#!/usr/bin/env node
// Pull intercompany balances from Sage Intacct XML gateway and print a matrix.
// Usage:
//   1. cp .env.example .env  (fill in credentials)
//   2. cp config/intercompany.example.json config/intercompany.json  (fill in entity locations + IC accounts)
//   3. node scripts/intercompany-matrix.mjs

import { readFileSync, writeFileSync } from 'node:fs';

try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const required = ['SAGE_SENDER_ID', 'SAGE_SENDER_PASSWORD', 'SAGE_COMPANY_ID', 'SAGE_USER_ID', 'SAGE_USER_PASSWORD'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. See .env.example`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(readFileSync('config/intercompany.json', 'utf8'));
} catch {
  console.error('Missing config/intercompany.json. Copy config/intercompany.example.json and edit.');
  process.exit(1);
}

const AS_OF = cfg.asOfDate;
const ENTITIES = Object.entries(cfg.entities);
const ACCOUNT_MAP = cfg.accounts;
const GATEWAY = 'https://api.intacct.com/ia/xml/xmlgw.phtml';

const xe = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function envelope(content) {
  const e = process.env;
  return `<?xml version="1.0" encoding="UTF-8"?>
<request>
  <control>
    <senderid>${xe(e.SAGE_SENDER_ID)}</senderid>
    <password>${xe(e.SAGE_SENDER_PASSWORD)}</password>
    <controlid>${Date.now()}</controlid>
    <uniqueid>false</uniqueid>
    <dtdversion>3.0</dtdversion>
    <includewhitespace>false</includewhitespace>
  </control>
  <operation>
    <authentication>
      <login>
        <userid>${xe(e.SAGE_USER_ID)}</userid>
        <companyid>${xe(e.SAGE_COMPANY_ID)}</companyid>
        <password>${xe(e.SAGE_USER_PASSWORD)}</password>
      </login>
    </authentication>
    <content>${content}</content>
  </operation>
</request>`;
}

function queryFn(controlid, locationId, accounts) {
  const accountFilter = accounts.map(a =>
    `<equalto><field>ACCOUNTNO</field><value>${xe(a)}</value></equalto>`).join('');
  return `
    <function controlid="${xe(controlid)}">
      <query>
        <object>GLDETAIL</object>
        <select>
          <field>ACCOUNTNO</field>
          <field>TRX_AMOUNT</field>
        </select>
        <filter>
          <and>
            <equalto><field>LOCATIONID</field><value>${xe(locationId)}</value></equalto>
            <lessthanorequalto><field>WHENPOSTED</field><value>${xe(AS_OF)}</value></lessthanorequalto>
            <or>${accountFilter}</or>
          </and>
        </filter>
        <pagesize>2000</pagesize>
      </query>
    </function>`;
}

async function call(xml) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml; charset=UTF-8' },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  const fail = text.match(/<errormessage[^>]*>([\s\S]*?)<\/errormessage>/);
  if (fail) throw new Error(`Intacct error: ${fail[1].trim().slice(0, 800)}`);
  return text;
}

function extractRows(xml) {
  const rows = [];
  const re = /<gldetail>([\s\S]*?)<\/gldetail>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const acct = (m[1].match(/<accountno>([^<]*)<\/accountno>/i) || [])[1];
    const amt = parseFloat((m[1].match(/<trx_amount>([^<]*)<\/trx_amount>/i) || [])[1] || '0');
    if (acct) rows.push({ acct, amt });
  }
  return rows;
}

(async () => {
  const matrix = {};
  for (const [name] of ENTITIES) matrix[name] = {};

  for (const [name, locId] of ENTITIES) {
    const accts = Object.keys(ACCOUNT_MAP[name] || {});
    if (!accts.length) {
      console.error(`No IC accounts mapped for ${name}; skipping.`);
      continue;
    }
    const xml = envelope(queryFn(locId, locId, accts));
    const resp = await call(xml);
    const rows = extractRows(resp);
    const sums = {};
    for (const { acct, amt } of rows) sums[acct] = (sums[acct] || 0) + amt;
    for (const [acct, counterparty] of Object.entries(ACCOUNT_MAP[name])) {
      matrix[name][counterparty] = (matrix[name][counterparty] || 0) + (sums[acct] || 0);
    }
  }

  const fmt = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const names = ENTITIES.map(([n]) => n);
  const W = 22;
  console.log(`\nIntercompany balances as of ${AS_OF}`);
  console.log(`(Row entity's books — receivable from column entity)\n`);
  console.log(['From \\ To', ...names].map(s => s.padEnd(W)).join(''));
  for (const r of names) {
    const row = [r];
    for (const c of names) row.push(r === c ? '—' : fmt(matrix[r][c] || 0));
    console.log(row.map(s => s.padEnd(W)).join(''));
  }
  writeFileSync('intercompany-matrix.json', JSON.stringify({ asOf: AS_OF, matrix }, null, 2));
  console.log(`\nWrote intercompany-matrix.json`);
})().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
