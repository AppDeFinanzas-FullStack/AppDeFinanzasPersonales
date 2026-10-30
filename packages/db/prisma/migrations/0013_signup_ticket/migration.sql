-- RF-M1-18: the app waiting on "Revisa tu correo" learns about the confirmation through a secret
-- ticket kept in a cookie. Only the SHA-256 of the cookie value is stored (plan §3.3, TASK-264).

CREATE TABLE signup_ticket (
  token_hash   char(64)    NOT NULL,
  user_id      uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  confirmed_at timestamptz,
  CONSTRAINT signup_ticket_pkey PRIMARY KEY (token_hash),
  CONSTRAINT signup_ticket_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX signup_ticket_user_id_key ON signup_ticket (user_id);
