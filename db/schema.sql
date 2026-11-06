-- Schema de referência (Postgres). Esta versão pública roda com o store em JSON (src/lib/store.js), que
-- segue estas mesmas tabelas; este arquivo documenta o modelo e serve para quem quiser plugar
-- um Postgres. Simplificado a partir do schema da versão em produção.

CREATE TABLE reservations (
  id            UUID PRIMARY KEY,
  external_id   TEXT,                 -- id na PMS (pode MUDAR depois do checkout)
  aliases       TEXT[] DEFAULT '{}',  -- ids antigos/novos reconhecidos pelo dedup
  code          TEXT,                 -- código curto da reserva
  guest_name    TEXT,
  check_in      DATE,
  check_out     DATE,
  nights        INT,
  gross_value   NUMERIC(12,2),        -- o que o hóspede paga
  commission    NUMERIC(12,2),        -- parte da gestora (não é custo do proprietário)
  net_value     NUMERIC(12,2) NOT NULL DEFAULT 0, -- receita do proprietário
  channel       TEXT,
  status        TEXT NOT NULL CHECK (status IN ('confirmed','completed','blocked','cancelled')),
  observation   TEXT,                 -- condições de pagamento em texto livre
  paid_total    NUMERIC(12,2),        -- pago pelo hóspede segundo a PMS
  captured_total NUMERIC(12,2),       -- já repassado ao proprietário (créditos)
  value_divergence JSONB,             -- valor mudou na PMS depois de gravado: revisão humana
  source        TEXT NOT NULL DEFAULT 'sync',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE payment_schedule (
  id                 UUID PRIMARY KEY,
  reservation_id     UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  installment_number INT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  due_date           DATE,
  paid               BOOLEAN DEFAULT FALSE, -- hóspede pagou
  paid_date          DATE,
  captured           BOOLEAN DEFAULT FALSE, -- repasse caiu como crédito (só então entra no contábil)
  parser_source      TEXT CHECK (parser_source IN ('llm','fallback')),
  notes              TEXT,
  UNIQUE (reservation_id, installment_number)
);

CREATE TABLE transactions (
  id                   UUID PRIMARY KEY,
  external_id          TEXT UNIQUE,     -- pms_<tipo>_<data>_<descrição>_<valor>, determinístico
  date                 DATE NOT NULL,
  description          TEXT NOT NULL,
  amount               NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  type                 TEXT NOT NULL CHECK (type IN ('credit','debit')),
  category             TEXT NOT NULL DEFAULT 'other',
  source               TEXT NOT NULL,   -- sync | agent | human
  is_manual            BOOLEAN DEFAULT FALSE,
  reason               TEXT,            -- obrigatório em lançamento manual
  reimbursement_status TEXT CHECK (reimbursement_status IS NULL OR reimbursement_status IN ('pending','paid')),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE categorization_log (
  id                BIGSERIAL PRIMARY KEY,
  transaction_id    UUID REFERENCES transactions(id),
  description       TEXT,
  assigned_category TEXT,
  confidence        TEXT CHECK (confidence IN ('high','medium','low')),
  rule_id           TEXT,
  matched_pattern   TEXT,
  reviewed          BOOLEAN DEFAULT FALSE -- low/medium entram na fila de revisão
);

CREATE TABLE cron_runs (
  id                BIGSERIAL PRIMARY KEY,
  job               TEXT NOT NULL,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  status            TEXT CHECK (status IN ('running','ok','error')),
  records_processed INT,
  error             TEXT
);

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  table_name   TEXT NOT NULL,
  record_id    UUID NOT NULL,
  action       TEXT NOT NULL,
  old_data     JSONB,
  new_data     JSONB,
  source       TEXT NOT NULL,
  performed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Saldos (mesma regra de src/lib/finance.js)
CREATE VIEW v_accounting_balance AS
SELECT COALESCE(SUM(amount) FILTER (WHERE type = 'credit'), 0)
     - COALESCE(SUM(amount) FILTER (WHERE type = 'debit' AND reimbursement_status IS DISTINCT FROM 'paid'), 0) AS balance
FROM transactions;
-- Atenção: "reimbursement_status <> 'paid'" excluiria os NULLs; por isso IS DISTINCT FROM.
