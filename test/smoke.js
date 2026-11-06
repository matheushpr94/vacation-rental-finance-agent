#!/usr/bin/env node
/**
 * Smoke test ponta a ponta do servidor MCP: sobe `src/mcp/server.js` por stdio com o cliente
 * oficial do SDK, lista as tools e chama cada uma. Usa um banco temporário dentro do repo
 * (data/.smoke-db.json) para a escrita não sujar data/db.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { replay } from '../src/sync.js';
import { saveStore, emptyStore } from '../src/lib/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'data/.smoke-db.json');
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails.push(msg); };

const { store } = await replay({ store: emptyStore() });
saveStore(store, DB);

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src/mcp/server.js')], env: { ...process.env, FINANCE_DB: DB, WRITE_MODE: 'confirm' }, stderr: 'ignore' });
const client = new Client({ name: 'smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  ok(['create_manual_entry', 'get_anomalies', 'get_forecast', 'get_monthly_breakdown', 'get_real_balance', 'get_transactions'].every((n) => names.includes(n)), `tools: ${names.join(', ')}`);

  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError, data: JSON.parse(r.content[0].text) }; };
  const bal = await call('get_real_balance');
  ok(typeof bal.data.accounting === 'number' && bal.data.projected >= bal.data.accounting, `get_real_balance → contábil ${bal.data.accounting}, projetado ${bal.data.projected}`);
  const tx = await call('get_transactions', { type: 'debit', category: 'electricity', limit: 3 });
  ok(tx.data.returned === 3 && tx.data.truncated === true, `get_transactions → ${tx.data.total_records} registros, truncated=${tx.data.truncated}`);
  const mb = await call('get_monthly_breakdown', { months: 3 });
  ok(Object.keys(mb.data).length >= 3, `get_monthly_breakdown → ${Object.keys(mb.data).join(', ')}`);
  const an = await call('get_anomalies');
  ok(Array.isArray(an.data) && an.data.length > 0, `get_anomalies → ${an.data.length} anomalias`);
  const fc = await call('get_forecast', { months: 3 });
  ok(fc.data.months.length === 3, 'get_forecast → 3 meses');

  const entry = { date: '2026-10-20', description: 'Conserto portão elétrico', amount: 350, type: 'debit', reason: 'pago em dinheiro, sem nota na PMS' };
  const p1 = await call('create_manual_entry', entry);
  ok(p1.data.status === 'pending_confirmation', 'create_manual_entry sem confirmed → prévia');
  const p2 = await call('create_manual_entry', { ...entry, confirmed: true });
  ok(p2.data.status === 'created', 'create_manual_entry confirmed → grava');
  const p3 = await call('create_manual_entry', { ...entry, date: '2030-01-01', confirmed: true });
  ok(p3.isError === true && p3.data.status === 'rejected', `create_manual_entry data futura → rejeitado (${p3.data.errors?.[0]})`);
  const bad = await client.callTool({ name: 'get_transactions', arguments: { limit: 10_000 } });
  ok(bad.isError === true, 'schema zod rejeita limit fora da faixa');
} finally {
  await client.close().catch(() => {});
  fs.rmSync(DB, { force: true });
}
process.exit(fails.length ? 1 : 0);
