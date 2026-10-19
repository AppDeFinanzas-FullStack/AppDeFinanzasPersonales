-- Goals and debts (plan §3.6, ADR-14; M12: RF-M12-01, RF-M12-03; M13: RF-M13-01, RF-M13-05).
-- Dates relative to today, the non-card dedicated account and the payment limits against the
-- accrued interest and outstanding capital are validated in the service (Zod + domain).

CREATE TABLE goal (
  id                   uuid          NOT NULL,
  user_id              uuid          NOT NULL,
  name                 varchar(40)   NOT NULL,
  target               numeric(14,2) NOT NULL,
  currency_code        char(3)       NOT NULL,
  target_date          date,
  icon                 varchar(32)   NOT NULL,
  color                varchar(16)   NOT NULL,
  dedicated_account_id uuid,
  celebrated_at        timestamptz,
  archived_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT goal_pkey PRIMARY KEY (id),
  -- A dedicated account belongs to a single goal (RF-M12-03).
  CONSTRAINT goal_dedicated_account_id_key UNIQUE (dedicated_account_id),
  CONSTRAINT goal_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT goal_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT goal_user_id_currency_code_fkey FOREIGN KEY (user_id, currency_code)
    REFERENCES currency (user_id, code),
  CONSTRAINT goal_user_id_dedicated_account_id_fkey FOREIGN KEY (user_id, dedicated_account_id)
    REFERENCES account (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT goal_target_check CHECK (target BETWEEN 0.01 AND 999999999.99),
  -- An archived goal has no dedicated account (RF-M12-03).
  CONSTRAINT goal_archived_dedicated_check CHECK (archived_at IS NULL OR dedicated_account_id IS NULL)
);

CREATE TRIGGER goal_set_updated_at BEFORE UPDATE ON goal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Allocations (+) and withdrawals (-).
CREATE TABLE goal_allocation_event (
  id                     uuid              NOT NULL,
  user_id                uuid              NOT NULL,
  goal_id                uuid              NOT NULL,
  account_id             uuid              NOT NULL,
  amount                 numeric(14,2)     NOT NULL,
  origin                 allocation_origin NOT NULL,
  related_transaction_id uuid,
  created_at             timestamptz       NOT NULL DEFAULT now(),
  CONSTRAINT goal_allocation_event_pkey PRIMARY KEY (id),
  CONSTRAINT goal_allocation_event_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT goal_allocation_event_user_id_goal_id_fkey FOREIGN KEY (user_id, goal_id)
    REFERENCES goal (user_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_allocation_event_user_id_account_id_fkey FOREIGN KEY (user_id, account_id)
    REFERENCES account (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT goal_allocation_event_amount_check CHECK (amount <> 0)
);
CREATE INDEX goal_allocation_event_user_id_account_id_idx ON goal_allocation_event (user_id, account_id);
CREATE INDEX goal_allocation_event_goal_id_created_at_idx ON goal_allocation_event (goal_id, created_at);

-- Interest is kept as a snapshot (ADR-14): capital_outstanding, interest_unpaid and accrued_through.
CREATE TABLE debt (
  id                     uuid            NOT NULL,
  user_id                uuid            NOT NULL,
  direction              debt_direction  NOT NULL,
  person                 varchar(40)     NOT NULL,
  -- lower(unaccent(person)), for autocompletion over the people already used.
  person_key             varchar(40)     NOT NULL,
  principal              numeric(14,2)   NOT NULL,
  currency_code          char(3)         NOT NULL,
  start_date             date            NOT NULL,
  due_date               date,
  note                   varchar(140),
  interest_rate          numeric(7,4),
  interest_period        interest_period,
  status                 debt_status     NOT NULL DEFAULT 'active',
  forgiven_amount        numeric(14,2),
  initial_transaction_id uuid,
  capital_outstanding    numeric(14,2)   NOT NULL,
  interest_unpaid        numeric(24,10)  NOT NULL DEFAULT 0,
  accrued_through        date            NOT NULL,
  created_at             timestamptz     NOT NULL DEFAULT now(),
  updated_at             timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT debt_pkey PRIMARY KEY (id),
  CONSTRAINT debt_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT debt_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT debt_user_id_currency_code_fkey FOREIGN KEY (user_id, currency_code)
    REFERENCES currency (user_id, code),
  CONSTRAINT debt_initial_transaction_id_fkey FOREIGN KEY (initial_transaction_id)
    REFERENCES ledger_transaction (id) ON DELETE SET NULL,
  CONSTRAINT debt_person_check CHECK (person = btrim(person) AND char_length(person) BETWEEN 1 AND 40),
  CONSTRAINT debt_principal_check CHECK (principal BETWEEN 0.01 AND 999999999.99),
  CONSTRAINT debt_interest_rate_check CHECK (interest_rate BETWEEN 0.01 AND 100),
  CONSTRAINT debt_capital_outstanding_check CHECK (capital_outstanding >= 0),
  CONSTRAINT debt_interest_unpaid_check CHECK (interest_unpaid >= 0),
  CONSTRAINT debt_interest_check CHECK ((interest_rate IS NULL) = (interest_period IS NULL)),
  CONSTRAINT debt_forgiven_check CHECK ((status = 'forgiven') = (forgiven_amount IS NOT NULL))
);
CREATE INDEX debt_user_id_status_due_date_idx ON debt (user_id, status, due_date);
CREATE INDEX debt_user_id_person_key_idx ON debt (user_id, person_key);

CREATE TRIGGER debt_set_updated_at BEFORE UPDATE ON debt
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE debt_payment (
  id                      uuid          NOT NULL,
  user_id                 uuid          NOT NULL,
  debt_id                 uuid          NOT NULL,
  amount                  numeric(14,2) NOT NULL,
  interest_part           numeric(14,2) NOT NULL,
  capital_part            numeric(14,2) NOT NULL,
  date                    date          NOT NULL,
  account_id              uuid,
  declared_rate           numeric(14,2),
  account_amount          numeric(14,2),
  capital_transaction_id  uuid,
  interest_transaction_id uuid,
  note                    varchar(140),
  created_at              timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT debt_payment_pkey PRIMARY KEY (id),
  CONSTRAINT debt_payment_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT debt_payment_debt_id_fkey FOREIGN KEY (debt_id) REFERENCES debt (id) ON DELETE CASCADE,
  CONSTRAINT debt_payment_user_id_account_id_fkey FOREIGN KEY (user_id, account_id)
    REFERENCES account (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT debt_payment_capital_transaction_id_fkey FOREIGN KEY (capital_transaction_id)
    REFERENCES ledger_transaction (id) ON DELETE SET NULL,
  CONSTRAINT debt_payment_interest_transaction_id_fkey FOREIGN KEY (interest_transaction_id)
    REFERENCES ledger_transaction (id) ON DELETE SET NULL,
  CONSTRAINT debt_payment_amount_check CHECK (amount > 0),
  CONSTRAINT debt_payment_interest_part_check CHECK (interest_part >= 0),
  CONSTRAINT debt_payment_capital_part_check CHECK (capital_part >= 0),
  CONSTRAINT debt_payment_declared_rate_check CHECK (declared_rate >= 0.01),
  -- interest + capital = payment amount (RF-M13-05).
  CONSTRAINT debt_payment_parts_check CHECK (amount = interest_part + capital_part)
);
CREATE INDEX debt_payment_debt_id_created_at_idx ON debt_payment (debt_id, created_at DESC);
