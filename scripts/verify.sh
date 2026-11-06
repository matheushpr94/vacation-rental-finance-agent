#!/usr/bin/env bash
# Portão rápido (CI e pre-push): sintaxe + dados sintéticos reprodutíveis + evals offline + selftest + smoke do MCP.
# Não usa rede nem chave de API.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
step() { printf '\n── %s\n' "$1"; }

step "node --check (sintaxe)"
while IFS= read -r f; do node --check "$f" || { echo "  ✗ $f"; fail=1; }; done < <(git ls-files '*.js' 2>/dev/null || find src evals scripts test -name '*.js')
[ $fail -eq 0 ] && echo "  ✓ ok"

step "dados sintéticos são reprodutíveis (semente fixa)"
node scripts/generate-synthetic.js >/dev/null || fail=1
if git rev-parse --git-dir >/dev/null 2>&1 && ! git diff --quiet -- data/pms data/manager-reports; then
  echo "  ✗ o gerador produziu dados diferentes dos versionados"; git diff --stat -- data/pms data/manager-reports; fail=1
else echo "  ✓ idênticos"; fi

step "evals offline"
node evals/run-all.js --json || fail=1

step "selftest dos evals (implementações sabotadas têm de reprovar)"
node evals/run-all.js --selftest || fail=1

step "smoke do servidor MCP (stdio, SDK oficial)"
node test/smoke.js || fail=1

echo
[ $fail -eq 0 ] && echo "✅ VERIFY OK" || echo "❌ VERIFY FALHOU"
exit $fail
