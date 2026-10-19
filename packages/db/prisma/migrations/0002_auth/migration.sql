-- User account and security tables (plan §3.3, M1).

CREATE TABLE auth_user (
  id                uuid         NOT NULL,
  name              varchar(60)  NOT NULL,
  email             varchar(254) NOT NULL,
  email_verified    boolean      NOT NULL DEFAULT false,
  image             text,
  timezone          varchar(64)  NOT NULL DEFAULT 'America/La_Paz',
  locale            varchar(10)  NOT NULL DEFAULT 'es-BO',
  terms_accepted_at timestamptz  NOT NULL,
  registered_at     timestamptz  NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT auth_user_pkey PRIMARY KEY (id),
  CONSTRAINT auth_user_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT auth_user_email_check CHECK (email = lower(btrim(email))),
  CONSTRAINT auth_user_locale_check CHECK (locale = 'es-BO')
);
CREATE UNIQUE INDEX auth_user_email_key ON auth_user (email);
CREATE INDEX auth_user_unconfirmed_idx ON auth_user (registered_at) WHERE NOT email_verified;

CREATE TABLE auth_session (
  id               uuid        NOT NULL,
  token            text        NOT NULL,
  user_id          uuid        NOT NULL,
  expires_at       timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  ip_address       text,
  user_agent       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_session_pkey PRIMARY KEY (id),
  CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX auth_session_token_key ON auth_session (token);
CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);

CREATE TABLE auth_account (
  id                       uuid        NOT NULL,
  user_id                  uuid        NOT NULL,
  account_id               text        NOT NULL,
  provider_id              text        NOT NULL,
  password                 text,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_account_pkey PRIMARY KEY (id),
  CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX auth_account_provider_id_account_id_key ON auth_account (provider_id, account_id);

CREATE TABLE auth_verification (
  id         uuid        NOT NULL,
  identifier text        NOT NULL,
  value      text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_verification_pkey PRIMARY KEY (id)
);

CREATE TABLE email_link (
  id             uuid               NOT NULL,
  user_id        uuid               NOT NULL,
  purpose        email_link_purpose NOT NULL,
  token_hash     char(64)           NOT NULL,
  expires_at     timestamptz        NOT NULL,
  used_at        timestamptz,
  invalidated_at timestamptz,
  created_at     timestamptz        NOT NULL DEFAULT now(),
  CONSTRAINT email_link_pkey PRIMARY KEY (id),
  CONSTRAINT email_link_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT email_link_used_or_invalidated_check CHECK (used_at IS NULL OR invalidated_at IS NULL)
);
CREATE UNIQUE INDEX email_link_token_hash_key ON email_link (token_hash);
CREATE UNIQUE INDEX email_link_one_active ON email_link (user_id, purpose)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE login_throttle (
  email_hmac           char(64)    NOT NULL,
  consecutive_failures integer     NOT NULL DEFAULT 0,
  last_failure_at      timestamptz,
  locked_until         timestamptz,
  last_alert_sent_at   timestamptz,
  CONSTRAINT login_throttle_pkey PRIMARY KEY (email_hmac),
  CONSTRAINT login_throttle_consecutive_failures_check CHECK (consecutive_failures >= 0)
);

CREATE TABLE email_outbox (
  id              uuid          NOT NULL,
  to_address      varchar(254)  NOT NULL,
  kind            email_kind    NOT NULL,
  payload         jsonb         NOT NULL,
  status          outbox_status NOT NULL DEFAULT 'pending',
  attempts        integer       NOT NULL DEFAULT 0,
  next_attempt_at timestamptz   NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT email_outbox_pkey PRIMARY KEY (id)
);
CREATE INDEX email_outbox_next_attempt_at_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE email_send_log (
  id         bigint      GENERATED ALWAYS AS IDENTITY,
  email_hmac char(64)    NOT NULL,
  kind       email_kind  NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_send_log_pkey PRIMARY KEY (id)
);
CREATE INDEX email_send_log_email_hmac_kind_sent_at_idx ON email_send_log (email_hmac, kind, sent_at DESC);

CREATE TRIGGER auth_user_set_updated_at BEFORE UPDATE ON auth_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER auth_session_set_updated_at BEFORE UPDATE ON auth_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER auth_account_set_updated_at BEFORE UPDATE ON auth_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER auth_verification_set_updated_at BEFORE UPDATE ON auth_verification
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
