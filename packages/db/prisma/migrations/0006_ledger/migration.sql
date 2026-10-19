-- Ledger, undo and shortcuts (plan §3.5, ADR-04, ADR-07, ADR-15; M6, M7: RF-M6-01, RF-M6-03, RF-M7-09, RN-09).
-- The ledger_transaction -> recurring_rule foreign key is added in a later migration (TASK-020).

CREATE TABLE ledger_transaction (
  id                    uuid               NOT NULL,
  user_id               uuid               NOT NULL,
  kind                  transaction_kind   NOT NULL,
  date                  date               NOT NULL,
  note                  varchar(140),
  category_id           uuid,
  origin                transaction_origin NOT NULL DEFAULT 'manual',
  origin_id             uuid,
  parent_transaction_id uuid,
  recurring_rule_id     uuid,
  recurring_label       varchar(40),
  rate_cur_bob          numeric(14,2)      NOT NULL,
  rate_usd_bob          numeric(14,2),
  declared_rate         numeric(14,2),
  created_at            timestamptz        NOT NULL DEFAULT now(),
  updated_at            timestamptz        NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT ledger_transaction_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_transaction_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT ledger_transaction_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT ledger_transaction_parent_transaction_id_fkey FOREIGN KEY (parent_transaction_id)
    REFERENCES ledger_transaction (id) ON DELETE CASCADE,
  CONSTRAINT ledger_transaction_user_id_category_id_fkey FOREIGN KEY (user_id, category_id)
    REFERENCES category (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_transaction_rate_cur_bob_check CHECK (rate_cur_bob >= 0.01),
  CONSTRAINT ledger_transaction_rate_usd_bob_check CHECK (rate_usd_bob >= 0.01),
  CONSTRAINT ledger_transaction_declared_rate_check CHECK (declared_rate >= 0.01),
  CONSTRAINT ledger_transaction_category_check CHECK ((kind IN ('expense','income')) = (category_id IS NOT NULL)),
  CONSTRAINT ledger_transaction_declared_rate_kind_check CHECK (declared_rate IS NULL OR kind = 'transfer'),
  CONSTRAINT ledger_transaction_fee_parent_check CHECK ((origin = 'fee') = (parent_transaction_id IS NOT NULL))
);
CREATE INDEX ledger_tx_list ON ledger_transaction (user_id, date DESC, created_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX ledger_transaction_user_id_category_id_date_idx ON ledger_transaction (user_id, category_id, date)
  WHERE deleted_at IS NULL;
CREATE INDEX ledger_transaction_deleted_at_idx ON ledger_transaction (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TRIGGER ledger_transaction_set_updated_at BEFORE UPDATE ON ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ledger_entry (
  id             uuid          NOT NULL,
  user_id        uuid          NOT NULL,
  transaction_id uuid          NOT NULL,
  account_id     uuid          NOT NULL,
  amount         numeric(14,2) NOT NULL,
  date           date          NOT NULL,
  CONSTRAINT ledger_entry_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_entry_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT ledger_entry_transaction_id_fkey FOREIGN KEY (transaction_id)
    REFERENCES ledger_transaction (id) ON DELETE CASCADE,
  CONSTRAINT ledger_entry_user_id_account_id_fkey FOREIGN KEY (user_id, account_id)
    REFERENCES account (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_entry_amount_check CHECK (amount <> 0)
);
CREATE INDEX ledger_entry_balance ON ledger_entry (user_id, account_id, date);
CREATE INDEX ledger_entry_transaction_id_idx ON ledger_entry (transaction_id);

CREATE TABLE undo_action (
  id          uuid        NOT NULL,
  user_id     uuid        NOT NULL,
  kind        undo_kind   NOT NULL,
  payload     jsonb       NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT undo_action_pkey PRIMARY KEY (id),
  CONSTRAINT undo_action_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE
);
CREATE INDEX undo_action_expires_at_idx ON undo_action (expires_at);

CREATE TABLE shortcut (
  id              uuid          NOT NULL,
  user_id         uuid          NOT NULL,
  name            varchar(30)   NOT NULL,
  kind            entry_kind    NOT NULL,
  amount          numeric(14,2),
  account_id      uuid          NOT NULL,
  dest_account_id uuid,
  category_id     uuid,
  note            varchar(140),
  sort_order      integer       NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT shortcut_pkey PRIMARY KEY (id),
  CONSTRAINT shortcut_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT shortcut_user_id_account_id_fkey FOREIGN KEY (user_id, account_id)
    REFERENCES account (user_id, id) ON DELETE CASCADE,
  CONSTRAINT shortcut_user_id_dest_account_id_fkey FOREIGN KEY (user_id, dest_account_id)
    REFERENCES account (user_id, id) ON DELETE CASCADE,
  CONSTRAINT shortcut_user_id_category_id_fkey FOREIGN KEY (user_id, category_id)
    REFERENCES category (user_id, id) ON DELETE CASCADE,
  CONSTRAINT shortcut_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 30),
  CONSTRAINT shortcut_amount_check CHECK (amount BETWEEN 0.01 AND 999999999.99),
  CONSTRAINT shortcut_transfer_check CHECK ((kind = 'transfer') = (dest_account_id IS NOT NULL AND category_id IS NULL)),
  -- A destination only in a transfer (RF-M7-09): the transfer check alone accepts a destination plus a category.
  CONSTRAINT shortcut_category_check CHECK (kind = 'transfer' OR (category_id IS NOT NULL AND dest_account_id IS NULL))
);

CREATE TRIGGER shortcut_set_updated_at BEFORE UPDATE ON shortcut
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
