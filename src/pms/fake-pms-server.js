#!/usr/bin/env node
/**
 * Servidor HTTP mínimo da PMS fake (só node:http, escuta em 127.0.0.1).
 *   GET /meta
 *   GET /reservations?as_of=YYYY-MM-DD
 *   GET /statements/YYYY-MM
 * Uso: PORT=4010 node src/pms/fake-pms-server.js   e depois   PMS_URL=http://127.0.0.1:4010 npm run sync
 */
import http from 'node:http';
import { inProcessPms } from './client.js';

const pms = inProcessPms();
const PORT = Number(process.env.PORT || 4010);

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === '/meta') return send(200, await pms.meta());
      if (url.pathname === '/reservations') {
        const asOf = url.searchParams.get('as_of');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) return send(400, { error: 'as_of=YYYY-MM-DD obrigatório' });
        return send(200, await pms.reservations({ asOf }));
      }
      const m = url.pathname.match(/^\/statements\/(\d{4}-\d{2})$/);
      if (m) return send(200, await pms.statement({ month: m[1] }));
      return send(404, { error: 'não encontrado' });
    } catch (e) {
      return send(500, { error: e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, '127.0.0.1', () => console.log(`PMS fake em http://127.0.0.1:${PORT}`));
}
