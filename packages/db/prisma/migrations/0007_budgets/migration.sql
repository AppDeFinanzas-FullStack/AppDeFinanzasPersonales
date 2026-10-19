-- Budgets (plan §3.6; M11: RF-M11-01, RF-M11-04, RF-M11-13, RNF-12).
-- Thresholds without repeats and in order are validated in the service (Zod + domain).

CREATE TABLE budget (
  id               uuid                  NOT NULL,
  user_id          uuid                  NOT NULL,
  scope            budget_scope          NOT NULL,
  category_id      uuid,
  amount           numeric(14,2)         NOT NULL,
  currency_code    char(3)               NOT NULL,
  start_day        smallint              NOT NULL,
  next_start_day   smallint,
  default_action   budget_default_action NOT NULL DEFAULT 'discard',
  thresholds       smallint[]            NOT NULL DEFAULT '{80,100}',
  status           budget_status         NOT NULL DEFAULT 'active',
  frozen_carryover numeric(14,2),
  created_at       timestamptz           NOT NULL DEFAULT now(),
  updated_at       timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT budget_pkey PRIMARY KEY (id),
  CONSTRAINT budget_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT budget_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT budget_user_id_category_id_fkey FOREIGN KEY (user_id, category_id)
    REFERENCES category (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT budget_user_id_currency_code_fkey FOREIGN KEY (user_id, currency_code)
    REFERENCES currency (user_id, code),
  CONSTRAINT budget_amount_check CHECK (amount BETWEEN 0.01 AND 999999999.99),
  CONSTRAINT budget_start_day_check CHECK (start_day BETWEEN 1 AND 28),
  CONSTRAINT budget_next_start_day_check CHECK (next_start_day BETWEEN 1 AND 28),
  CONSTRAINT budget_thresholds_check
    CHECK (cardinality(thresholds) <= 3 AND 1 <= ALL (thresholds) AND 150 >= ALL (thresholds)),
  CONSTRAINT budget_scope_check CHECK ((scope = 'general') = (category_id IS NULL))
);
CREATE UNIQUE INDEX budget_one_per_category ON budget (user_id, category_id)
  WHERE scope = 'category' AND status IN ('active','paused','finalizing');
CREATE UNIQUE INDEX budget_one_general ON budget (user_id)
  WHERE scope = 'general' AND status IN ('active','paused','finalizing');

CREATE TRIGGER budget_set_updated_at BEFORE UPDATE ON budget
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE budget_period (
  id                 uuid                 NOT NULL,
  user_id            uuid                 NOT NULL,
  budget_id          uuid                 NOT NULL,
  start_date         date                 NOT NULL,
  end_date           date                 NOT NULL,
  amount             numeric(14,2)        NOT NULL,
  carryover_in       numeric(14,2)        NOT NULL DEFAULT 0,
  status             budget_period_status NOT NULL DEFAULT 'open',
  spent_at_decision  numeric(14,2),
  result_at_decision numeric(14,2),
  decision           jsonb,
  decision_deadline  timestamptz,
  decided_at         timestamptz,
  CONSTRAINT budget_period_pkey PRIMARY KEY (id),
  CONSTRAINT budget_period_budget_id_start_date_key UNIQUE (budget_id, start_date),
  CONSTRAINT budget_period_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT budget_period_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES budget (id) ON DELETE CASCADE,
  CONSTRAINT budget_period_end_date_check CHECK (end_date >= start_date),
  CONSTRAINT budget_period_decided_check CHECK ((status IN ('decided','defaulted')) = (decided_at IS NOT NULL))
);
CREATE INDEX budget_period_user_id_status_end_date_idx ON budget_period (user_id, status, end_date);

CREATE TABLE budget_late_adjustment (
  id               uuid          NOT NULL,
  user_id          uuid          NOT NULL,
  period_id        uuid          NOT NULL,
  source_period_id uuid          NOT NULL,
  amount           numeric(14,2) NOT NULL,
  voided_at        timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT budget_late_adjustment_pkey PRIMARY KEY (id),
  CONSTRAINT budget_late_adjustment_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  -- The period in progress that receives the adjustment.
  CONSTRAINT budget_late_adjustment_period_id_fkey FOREIGN KEY (period_id)
    REFERENCES budget_period (id) ON DELETE CASCADE,
  -- The closed period the late movement belongs to.
  CONSTRAINT budget_late_adjustment_source_period_id_fkey FOREIGN KEY (source_period_id)
    REFERENCES budget_period (id) ON DELETE CASCADE
);

CREATE TABLE budget_threshold_hit (
  period_id  uuid        NOT NULL,
  threshold  smallint    NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One notice per threshold and period (RN-10, RNF-12).
  CONSTRAINT budget_threshold_hit_pkey PRIMARY KEY (period_id, threshold),
  CONSTRAINT budget_threshold_hit_period_id_fkey FOREIGN KEY (period_id)
    REFERENCES budget_period (id) ON DELETE CASCADE
);
