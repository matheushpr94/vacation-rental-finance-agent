/**
 * "PMS fake": simula a plataforma da gestora do imóvel a partir de data/pms/*.json.
 *
 * Comportamentos reproduzidos de propósito:
 *   - a lista de reservas é vista "numa data" (asOf): só aparecem reservas já feitas
 *   - depois do checkout, algumas reservas voltam com OUTRO id (e às vezes outro nome/check-in/valor)
 *   - o extrato de um mês pode repetir lançamentos do mês anterior
 *   - descrições com prefixo numérico ("3. ...") e "Pag. solicitado <X>"
 *
 * Dois modos com a mesma interface: em processo (padrão, sem rede) e HTTP (PMS_URL aponta para
 * src/pms/fake-pms-server.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = process.env.PMS_DATA_DIR || path.join(ROOT, 'data/pms');

let cache;
function load() {
  if (cache) return cache;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf-8'));
  cache = { meta: read('meta.json'), reservations: read('reservations.json'), statements: read('statements.json') };
  return cache;
}

/** Visão pública de uma reserva numa data: aplica a troca de id pós-checkout e esconde a "verdade". */
export function viewReservation(r, asOf) {
  const { truth_schedule, after_checkout, paid_total, ...pub } = r;
  const paidSoFar = truth_schedule.filter((p) => p.paid_date && p.paid_date <= asOf).reduce((s, p) => s + p.amount, 0);
  const v = { ...pub, paid_total: Math.round(paidSoFar * 100) / 100 };
  if (after_checkout && r.check_out < asOf) Object.assign(v, after_checkout);
  return v;
}

export function inProcessPms() {
  const db = load();
  return {
    meta: async () => db.meta,
    reservations: async ({ asOf }) => db.reservations.filter((r) => r.booked_at <= asOf).map((r) => viewReservation(r, asOf)),
    statement: async ({ month }) => db.statements[month] || { debits: [], credits: [] },
  };
}

export function httpPms(baseUrl) {
  const get = async (p) => {
    const res = await fetch(new URL(p, baseUrl));
    if (!res.ok) throw new Error(`PMS HTTP ${res.status} em ${p}`);
    return res.json();
  };
  return {
    meta: () => get('/meta'),
    reservations: ({ asOf }) => get(`/reservations?as_of=${asOf}`),
    statement: ({ month }) => get(`/statements/${month}`),
  };
}

export function pmsClient() {
  return process.env.PMS_URL ? httpPms(process.env.PMS_URL) : inProcessPms();
}
