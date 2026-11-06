/**
 * Armazenamento em JSON (um arquivo). Substitui o Postgres da versão em produção para que esta versão
 * pública rode sem docker e sem rede. As "tabelas" seguem db/schema.sql.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DB = process.env.FINANCE_DB || path.join(ROOT, 'data/db.json');

export const TABLES = ['reservations', 'payment_schedule', 'transactions', 'categorization_log', 'cron_runs', 'audit_log'];

export function emptyStore() {
  return Object.fromEntries(TABLES.map((t) => [t, []]));
}

export function loadStore(file = DEFAULT_DB) {
  if (!fs.existsSync(file)) return emptyStore();
  const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const t of TABLES) s[t] ||= [];
  return s;
}

export function saveStore(store, file = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, file); // escrita atômica
}

/** UUID determinístico a partir de uma chave (dados reprodutíveis entre execuções). */
export function uuidFrom(key) {
  const h = crypto.createHash('sha1').update(String(key)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function audit(store, { table, record_id, action, old_data = null, new_data = null, source, at }) {
  store.audit_log.push({ id: store.audit_log.length + 1, table_name: table, record_id, action, old_data, new_data, source, performed_at: at });
}

/** Rastreio de execuções (equivalente ao cron_runs da produção). */
export function trackRun(store, job, at) {
  const run = { id: store.cron_runs.length + 1, job, started_at: at, status: 'running', records_processed: 0, error: null };
  store.cron_runs.push(run);
  return {
    finish: (records = 0) => Object.assign(run, { status: 'ok', records_processed: records, finished_at: at }),
    fail: (err) => Object.assign(run, { status: 'error', error: String(err?.message || err), finished_at: at }),
  };
}
