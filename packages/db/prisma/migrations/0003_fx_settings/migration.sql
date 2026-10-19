-- Exchange rates, currencies and user settings (plan §3.4, M3, M9, M10).
-- user_settings -> account and favorite_category -> category foreign keys are added with the tables they point to.

CREATE TABLE market_rate (
  kind        market_rate_kind NOT NULL,
  rate_date   date             NOT NULL,
  value       numeric(14,2)    NOT NULL,
  observed_at timestamptz      NOT NULL,
  source      rate_source      NOT NULL,
  CONSTRAINT market_rate_pkey PRIMARY KEY (kind, rate_date),
  CONSTRAINT market_rate_value_check CHECK (value >= 0.01)
);

CREATE TABLE currency (
  user_id    uuid            NOT NULL,
  code       char(3)         NOT NULL,
  symbol     varchar(5)      NOT NULL,
  is_system  boolean         NOT NULL DEFAULT false,
  status     currency_status NOT NULL DEFAULT 'active',
  created_at timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT currency_pkey PRIMARY KEY (user_id, code),
  CONSTRAINT currency_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT currency_code_check CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT currency_symbol_check CHECK (char_length(btrim(symbol)) BETWEEN 1 AND 5),
  CONSTRAINT currency_system_active_check CHECK (NOT is_system OR status = 'active')
);

CREATE TABLE user_fx_event (
  id            uuid             NOT NULL,
  user_id       uuid             NOT NULL,
  kind          fx_event_kind    NOT NULL,
  currency_code char(3),
  reference     market_rate_kind,
  value         numeric(14,2),
  effective_at  timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT user_fx_event_pkey PRIMARY KEY (id),
  CONSTRAINT user_fx_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT user_fx_event_user_id_currency_code_fkey FOREIGN KEY (user_id, currency_code)
    REFERENCES currency (user_id, code),
  CONSTRAINT user_fx_event_value_check CHECK (value >= 0.01),
  CONSTRAINT user_fx_event_kind_check CHECK (
    (kind = 'reference_set'  AND reference IS NOT NULL AND value IS NULL) OR
    (kind = 'manual_usd_on'  AND currency_code = 'USD' AND value IS NOT NULL) OR
    (kind = 'manual_usd_off' AND currency_code = 'USD' AND value IS NULL) OR
    (kind = 'custom_rate'    AND currency_code IS NOT NULL AND value IS NOT NULL)
  )
);
CREATE INDEX user_fx_event_user_id_kind_currency_code_effective_at_idx
  ON user_fx_event (user_id, kind, currency_code, effective_at DESC);

CREATE TABLE user_settings (
  user_id                 uuid             NOT NULL,
  number_format           number_format    NOT NULL DEFAULT 'dot_comma',
  date_format             date_format      NOT NULL DEFAULT 'dmy',
  week_start              week_start       NOT NULL DEFAULT 'monday',
  theme                   theme_mode       NOT NULL DEFAULT 'system',
  sidebar_collapsed       boolean          NOT NULL DEFAULT false,
  base_currency           char(3)          NOT NULL DEFAULT 'BOB',
  usd_reference           market_rate_kind NOT NULL DEFAULT 'parallel_median',
  manual_usd_value        numeric(14,2),
  manual_usd_since        timestamptz,
  default_account_id      uuid,
  always_show_note        boolean          NOT NULL DEFAULT false,
  dashboard_blocks        jsonb            NOT NULL,
  onboarding_step         smallint         NOT NULL DEFAULT 1,
  onboarding_completed_at timestamptz,
  updated_at              timestamptz      NOT NULL DEFAULT now(),
  CONSTRAINT user_settings_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT user_settings_user_id_base_currency_fkey FOREIGN KEY (user_id, base_currency)
    REFERENCES currency (user_id, code),
  CONSTRAINT user_settings_manual_usd_value_check CHECK (manual_usd_value >= 0.01),
  CONSTRAINT user_settings_onboarding_step_check CHECK (onboarding_step BETWEEN 1 AND 3),
  CONSTRAINT user_settings_manual_usd_pair_check CHECK ((manual_usd_value IS NULL) = (manual_usd_since IS NULL))
);

CREATE TABLE favorite_category (
  user_id     uuid          NOT NULL,
  category_id uuid          NOT NULL,
  kind        category_kind NOT NULL,
  position    smallint      NOT NULL,
  CONSTRAINT favorite_category_pkey PRIMARY KEY (user_id, category_id),
  CONSTRAINT favorite_category_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT favorite_category_user_id_kind_position_key UNIQUE (user_id, kind, position)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT favorite_category_position_check CHECK (position BETWEEN 1 AND 8)
);

CREATE TRIGGER user_settings_set_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rate of an added currency at the end of a day in the user's timezone (RF-M3-13).
-- Before the first data point it returns the first known value.
CREATE FUNCTION user_rate_on(p_user uuid, p_code char(3), p_date date) RETURNS numeric
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    (SELECT e.value FROM user_fx_event e JOIN auth_user u ON u.id = e.user_id
      WHERE e.user_id = p_user AND e.kind = 'custom_rate' AND e.currency_code = p_code
        AND e.effective_at < ((p_date + 1)::timestamp AT TIME ZONE u.timezone)
      ORDER BY e.effective_at DESC LIMIT 1),
    (SELECT e.value FROM user_fx_event e
      WHERE e.user_id = p_user AND e.kind = 'custom_rate' AND e.currency_code = p_code
      ORDER BY e.effective_at ASC LIMIT 1))
$$;
