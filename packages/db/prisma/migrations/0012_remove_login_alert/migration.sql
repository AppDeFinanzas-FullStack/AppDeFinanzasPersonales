-- RF-M1-16: the failed sign-in alert email is gone (TASK-262). Postgres cannot drop a value from an
-- enum, so email_kind is rebuilt with the 5 account emails. The index on email_send_log (email_hmac,
-- kind, sent_at DESC) is rebuilt by ALTER COLUMN TYPE; no CHECK uses kind.
BEGIN;

DELETE FROM email_outbox WHERE kind = 'login_alert';
DELETE FROM email_send_log WHERE kind = 'login_alert';

ALTER TYPE email_kind RENAME TO email_kind_old;
CREATE TYPE email_kind AS ENUM ('confirm','register_attempt','reset','password_changed','account_deleted');
ALTER TABLE email_outbox ALTER COLUMN kind TYPE email_kind USING kind::text::email_kind;
ALTER TABLE email_send_log ALTER COLUMN kind TYPE email_kind USING kind::text::email_kind;
DROP TYPE email_kind_old;

ALTER TABLE login_throttle DROP COLUMN last_alert_sent_at;

COMMIT;
