-- Accounts (plan §3.5, M4: RF-M4-01, RF-M4-02, RF-M4-07, EC-M4-02).
-- The user_settings -> account foreign key is added in a later migration (TASK-020).

CREATE TABLE account (
  id                   uuid             NOT NULL,
  user_id              uuid             NOT NULL,
  type                 account_type     NOT NULL,
  name                 varchar(40)      NOT NULL,
  currency_code        char(3)          NOT NULL,
  initial_balance      numeric(14,2)    NOT NULL DEFAULT 0,
  initial_balance_date date             NOT NULL,
  color                varchar(16)      NOT NULL,
  icon                 varchar(32)      NOT NULL,
  card_cut_day         smallint,
  card_pay_day         smallint,
  card_limit           numeric(14,2),
  status               lifecycle_status NOT NULL DEFAULT 'active',
  archived_at          timestamptz,
  sort_order           integer          NOT NULL,
  created_at           timestamptz      NOT NULL DEFAULT now(),
  updated_at           timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT account_pkey PRIMARY KEY (id),
  CONSTRAINT account_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT account_user_id_currency_code_fkey FOREIGN KEY (user_id, currency_code)
    REFERENCES currency (user_id, code),
  CONSTRAINT account_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 40),
  CONSTRAINT account_initial_balance_check CHECK (abs(initial_balance) <= 999999999.99),
  CONSTRAINT account_card_cut_day_check CHECK (card_cut_day BETWEEN 1 AND 31),
  CONSTRAINT account_card_pay_day_check CHECK (card_pay_day BETWEEN 1 AND 31),
  CONSTRAINT account_card_limit_check CHECK (card_limit > 0),
  CONSTRAINT account_card_fields_check CHECK (
    type = 'credit_card' OR (card_cut_day IS NULL AND card_pay_day IS NULL AND card_limit IS NULL)
  ),
  CONSTRAINT account_non_negative_initial_check CHECK (type NOT IN ('cash','ewallet') OR initial_balance >= 0),
  CONSTRAINT account_archived_check CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX account_active_name ON account (user_id, lower(name)) WHERE status = 'active';
CREATE INDEX account_user_id_status_sort_order_idx ON account (user_id, status, sort_order);

CREATE TRIGGER account_set_updated_at BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The initial balance and its date never change after creation; corrections use "Ajustar saldo" (RF-M4-07).
CREATE FUNCTION account_initial_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.initial_balance IS DISTINCT FROM OLD.initial_balance
     OR NEW.initial_balance_date IS DISTINCT FROM OLD.initial_balance_date THEN
    RAISE EXCEPTION 'account initial balance and its date are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER account_initial_immutable BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION account_initial_immutable();
