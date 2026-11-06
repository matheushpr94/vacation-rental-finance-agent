#!/usr/bin/env node
/**
 * Servidor MCP (stdio) com o SDK oficial @modelcontextprotocol/sdk.
 * A versão em produção tinha JSON-RPC escrito à mão e ~20 tools; aqui fica o subconjunto que
 * mostra o desenho: 5 de leitura + 1 de escrita validada e com confirmação.
 *
 * Uso no Claude Desktop / Claude Code: ver README ("Como rodar").
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadStore, saveStore, DEFAULT_DB } from '../lib/store.js';
import { balances, monthlyBreakdown, queryTransactions } from '../lib/finance.js';
import { detectAnomalies } from '../lib/anomalies.js';
import { forecast } from '../lib/forecast.js';
import { createManualEntry, CATEGORIES } from '../lib/manual-entry.js';

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

export function buildServer({ dbFile = DEFAULT_DB, writeMode = process.env.WRITE_MODE || 'confirm', persist = true } = {}) {
  const server = new McpServer({ name: 'vacation-rental-finance', version: '0.1.0' });
  const store = () => loadStore(dbFile);

  server.registerTool('get_real_balance', {
    title: 'Saldo contábil, confirmado e projetado',
    description: 'Saldo do proprietário. contábil = créditos − débitos ativos; confirmado = + parcelas pagas pelo hóspede e ainda não repassadas; projetado = + tudo que falta receber das reservas ativas. Use SEMPRE esta tool para responder sobre saldo; nunca some parcelas por conta própria.',
    inputSchema: {},
  }, async () => json(balances(store())));

  server.registerTool('get_transactions', {
    title: 'Lista transações',
    description: 'Filtra transações. Se truncated=true, os totais da página NÃO representam o período: use net_sum_all_records ou aumente limit.',
    inputSchema: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type: z.enum(['credit', 'debit']).optional(),
      category: z.enum(CATEGORIES).optional(),
      search: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
  }, async (args) => json(queryTransactions(store(), args)));

  server.registerTool('get_monthly_breakdown', {
    title: 'Receita e despesa por mês',
    description: 'Créditos, débitos, resultado e débitos por categoria, mês a mês.',
    inputSchema: { months: z.number().int().min(1).max(24).default(6) },
  }, async ({ months }) => json(monthlyBreakdown(store(), { months })));

  server.registerTool('get_anomalies', {
    title: 'Anomalias de despesa',
    description: 'Despesas fora do padrão por mediana/MAD (sem LLM). Categorias recorrentes: total mensal vs. mediana; demais: lançamento vs. mediana da categoria.',
    inputSchema: { months_back: z.number().int().min(4).max(24).default(6) },
  }, async ({ months_back }) => { const s = store(); return json(detectAnomalies(s.transactions, { asOf: s.meta?.as_of, monthsBack: months_back })); });

  server.registerTool('get_forecast', {
    title: 'Projeção de caixa',
    description: 'Projeção mensal: receita = parcelas a receber já contratadas; despesa = mediana sazonal. Não estima reservas futuras ainda não feitas.',
    inputSchema: { months: z.number().int().min(1).max(12).default(6) },
  }, async ({ months }) => json(forecast(store(), { months })));

  server.registerTool('create_manual_entry', {
    title: 'Lançamento manual (escrita)',
    description: 'Cria crédito/débito manual. Em modo confirm, a 1ª chamada devolve só a prévia; mostre-a ao humano e só reenvie com confirmed=true se ele aprovar explicitamente.',
    inputSchema: {
      date: z.string(), description: z.string(), amount: z.number(), type: z.enum(['credit', 'debit']),
      category: z.enum(CATEGORIES).optional(), reason: z.string(), confirmed: z.boolean().optional(),
    },
  }, async (args) => {
    const s = store();
    const r = createManualEntry(s, args, { writeMode });
    if (r.status === 'created' && persist) saveStore(s, dbFile);
    return { ...json(r), isError: r.status === 'rejected' };
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error('[mcp] vacation-rental-finance pronto (stdio)');
}
