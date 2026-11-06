/**
 * Categorizador de débitos por regras (regex), com nível de confiança e log de decisão.
 *
 * Por que regras e não LLM: as descrições vêm de uma planilha da gestora, são curtas e repetitivas
 * ("0. Pag. solicitado Energia"). Regra é auditável, grátis, determinística e cobre ~95% dos casos.
 * O que sobra cai em `other` com confiança baixa e vai para revisão humana (o log é a fila de revisão).
 *
 * Etapas:
 *   1. remove o prefixo numérico que a PMS coloca ("0. ", "3. ")
 *   2. se a descrição começa com "Pag. solicitado <X>", tenta categorizar pelo sufixo <X> primeiro
 *   3. compara sem acento e sem caixa contra as regras, na ordem (a primeira que casar vence)
 *   4. se nada casar, tenta "fuzzy" pelos exemplos das regras (confiança média)
 *   5. se ainda nada, `other` com confiança baixa
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RULES_PATH = path.join(__dirname, '../../config/category-rules.json');

export function removeAccents(str) {
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const NUM_PREFIX_RE = /^\d+\.\s*/;
const PAG_PREFIX_RE = /^pag(?:amento)?\.?\s*solicitad[oa]\s*/i;

export function loadRules(rulesPath = RULES_PATH) {
  const config = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
  return config.rules.map((r) => ({ ...r, _re: new RegExp(removeAccents(r.pattern), 'i') }));
}

/**
 * Cria um categorizador. `options` existe para os evals conseguirem "sabotar" etapas
 * (ver evals/selftest): normalizeAccents=false, stripPagPrefix=false.
 */
export function createCategorizer({ rules = loadRules(), normalizeAccents = true, stripPagPrefix = true } = {}) {
  const norm = (s) => (normalizeAccents ? removeAccents(s) : s);

  function tryRules(text, skipCategory = null) {
    const t = norm(text);
    for (const rule of rules) {
      if (skipCategory && rule.category === skipCategory) continue;
      const m = t.match(rule._re);
      if (m) return { rule, match: m[0] };
    }
    return null;
  }

  return function categorize(description) {
    if (!description || !String(description).trim()) {
      return { category: 'other', confidence: 'low', rule_id: null, matched_pattern: null };
    }
    const desc = String(description).trim();
    const noNum = desc.replace(NUM_PREFIX_RE, '').trim() || desc;

    if (stripPagPrefix) {
      const suffix = noNum.replace(PAG_PREFIX_RE, '').trim();
      if (suffix !== noNum && suffix.length >= 3) {
        const hit = tryRules(suffix, 'owner_payout');
        if (hit) {
          return { category: hit.rule.category, confidence: hit.rule.confidence, rule_id: hit.rule.id, matched_pattern: hit.match };
        }
      }
    }

    const hit = tryRules(noNum);
    if (hit) {
      return { category: hit.rule.category, confidence: hit.rule.confidence, rule_id: hit.rule.id, matched_pattern: hit.match };
    }

    // fuzzy: algum exemplo de regra contido na descrição (sem números/pontos/espaços)
    const clean = (s) => norm(s).toLowerCase().replace(/[0-9.\s]/g, '');
    const d = clean(noNum);
    for (const rule of rules) {
      for (const ex of rule.examples || []) {
        const e = clean(ex);
        if (e.length > 4 && d.includes(e)) {
          return { category: rule.category, confidence: 'medium', rule_id: `${rule.id}_fuzzy`, matched_pattern: ex };
        }
      }
    }
    return { category: 'other', confidence: 'low', rule_id: null, matched_pattern: null };
  };
}

let _default;
export function categorize(description) {
  _default ||= createCategorizer();
  return _default(description);
}

/**
 * Categoriza e registra a decisão no log (store.categorization_log).
 * Itens com confiança low/medium ficam `reviewed: false` e formam a fila de revisão.
 */
export function categorizeWithLog(store, description, transactionId = null) {
  const result = categorize(description);
  store.categorization_log.push({
    transaction_id: transactionId,
    description,
    assigned_category: result.category,
    confidence: result.confidence,
    rule_id: result.rule_id,
    matched_pattern: result.matched_pattern,
    reviewed: result.confidence === 'high',
  });
  return result;
}

export function reviewQueue(store) {
  return store.categorization_log.filter((l) => !l.reviewed);
}
