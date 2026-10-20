-- Recurring rules, notifications and job monitoring (plan §3.6, plan §3.7;
-- M14: RF-M14-12, RF-M14-14, RF-M14-15; M15: RN-10).
-- The foreign key from ledger_transaction.recurring_rule_id is created in TASK-020.

CREATE TABLE recurring_rule (
  id                  uuid           NOT NULL,
  user_id             uuid           NOT NULL,
  name                varchar(40)    NOT NULL,
  kind                entry_kind     NOT NULL,
  amount              numeric(14,2),
  account_id          uuid           NOT NULL,
  dest_account_id     uuid,
  category_id         uuid,
  note                varchar(140),
  frequency           rule_frequency NOT NULL,
  weekday             smallint,
  day_of_month        smallint,
  month               smallint,
  start_date          date           NOT NULL,
  end_type            rule_end_type  NOT NULL DEFAULT 'none',
  end_date            date,
  end_count           smallint,
  mode                rule_mode      NOT NULL,
  status              rule_status    NOT NULL DEFAULT 'active',
  paused_at           timestamptz,
  generated_count     integer        NOT NULL DEFAULT 0,
  last_generated_date date,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT recurring_rule_pkey PRIMARY KEY (id),
  CONSTRAINT recurring_rule_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT recurring_rule_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT recurring_rule_user_id_account_id_fkey FOREIGN KEY (user_id, account_id)
    REFERENCES account (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT recurring_rule_user_id_dest_account_id_fkey FOREIGN KEY (user_id, dest_account_id)
    REFERENCES account (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT recurring_rule_user_id_category_id_fkey FOREIGN KEY (user_id, category_id)
    REFERENCES category (user_id, id) ON DELETE RESTRICT,
  -- 1 to 40 characters, without surrounding spaces (RF-M14-15).
  CONSTRAINT recurring_rule_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT recurring_rule_amount_check CHECK (amount BETWEEN 0.01 AND 999999999.99),
  CONSTRAINT recurring_rule_weekday_check CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT recurring_rule_day_of_month_check CHECK (day_of_month BETWEEN 1 AND 31),
  CONSTRAINT recurring_rule_month_check CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT recurring_rule_end_count_check CHECK (end_count BETWEEN 1 AND 999),
  -- The amount is required in auto mode and optional in confirm mode (RF-M14-14).
  CONSTRAINT recurring_rule_amount_mode_check CHECK (amount IS NOT NULL OR mode = 'confirm'),
  CONSTRAINT recurring_rule_transfer_check
    CHECK ((kind = 'transfer') = (dest_account_id IS NOT NULL AND category_id IS NULL)),
  CONSTRAINT recurring_rule_category_check CHECK (kind = 'transfer' OR category_id IS NOT NULL),
  CONSTRAINT recurring_rule_weekly_check CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CONSTRAINT recurring_rule_day_of_month_frequency_check
    CHECK ((frequency IN ('monthly','yearly')) = (day_of_month IS NOT NULL)),
  CONSTRAINT recurring_rule_yearly_check CHECK ((frequency = 'yearly') = (month IS NOT NULL)),
  CONSTRAINT recurring_rule_end_until_check
    CHECK ((end_type = 'until') = (end_date IS NOT NULL) AND (end_date IS NULL OR end_date >= start_date)),
  CONSTRAINT recurring_rule_end_count_type_check CHECK ((end_type = 'count') = (end_count IS NOT NULL)),
  CONSTRAINT recurring_rule_paused_check CHECK ((status = 'paused') = (paused_at IS NOT NULL))
);
CREATE INDEX recurring_rule_user_id_status_idx ON recurring_rule (user_id, status);

CREATE TRIGGER recurring_rule_set_updated_at BEFORE UPDATE ON recurring_rule
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recurring_occurrence (
  id             uuid              NOT NULL,
  user_id        uuid              NOT NULL,
  rule_id        uuid              NOT NULL,
  scheduled_date date              NOT NULL,
  status         occurrence_status NOT NULL,
  transaction_id uuid,
  pending_since  timestamptz,
  decided_at     timestamptz,
  CONSTRAINT recurring_occurrence_pkey PRIMARY KEY (id),
  -- At most one occurrence per rule and date (RF-M14-12).
  CONSTRAINT recurring_occurrence_rule_id_scheduled_date_key UNIQUE (rule_id, scheduled_date),
  CONSTRAINT recurring_occurrence_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT recurring_occurrence_rule_id_fkey FOREIGN KEY (rule_id)
    REFERENCES recurring_rule (id) ON DELETE CASCADE,
  CONSTRAINT recurring_occurrence_transaction_id_fkey FOREIGN KEY (transaction_id)
    REFERENCES ledger_transaction (id) ON DELETE SET NULL
);
CREATE INDEX recurring_occurrence_user_id_status_pending_since_idx
  ON recurring_occurrence (user_id, status, pending_since);

CREATE TABLE notification (
  id              uuid              NOT NULL,
  user_id         uuid              NOT NULL,
  type            notification_type NOT NULL,
  -- e.g. debt:{id}:due:2026-10-20:d-3
  event_key       varchar(200)      NOT NULL,
  -- Data for the i18n text.
  params          jsonb             NOT NULL,
  target_route    varchar(200)      NOT NULL,
  -- 'budget_period' | 'occurrence'
  decision_kind   varchar(32),
  decision_ref    uuid,
  decision_status decision_status,
  read_at         timestamptz,
  created_at      timestamptz       NOT NULL DEFAULT now(),
  CONSTRAINT notification_pkey PRIMARY KEY (id),
  -- One event never produces two notifications (RN-10, RNF-12).
  CONSTRAINT notification_user_id_event_key_key UNIQUE (user_id, event_key),
  CONSTRAINT notification_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT notification_decision_check CHECK ((decision_ref IS NULL) = (decision_status IS NULL))
);
CREATE INDEX notification_user_id_created_at_idx ON notification (user_id, created_at DESC);
CREATE INDEX notification_user_id_unread_idx ON notification (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_preference (
  user_id   uuid              NOT NULL,
  type      notification_type NOT NULL,
  enabled   boolean           NOT NULL,
  hour      smallint,
  lead_days smallint,
  weekdays  smallint[],
  CONSTRAINT notification_preference_pkey PRIMARY KEY (user_id, type),
  CONSTRAINT notification_preference_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT notification_preference_hour_check CHECK (hour BETWEEN 0 AND 23),
  CONSTRAINT notification_preference_lead_days_check CHECK (lead_days BETWEEN 0 AND 7)
);

-- Monitoring only; mutual exclusion between job runs uses advisory locks.
CREATE TABLE job_run (
  job              varchar(64) NOT NULL,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_error       text,
  CONSTRAINT job_run_pkey PRIMARY KEY (job)
);
