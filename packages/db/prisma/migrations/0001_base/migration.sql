-- Base migration: extensions, enumerated types and the updated_at trigger function (plan §3.1, §3.2, ADR-10).

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TYPE email_link_purpose    AS ENUM ('confirm_email','reset_password');
CREATE TYPE email_kind            AS ENUM ('confirm','register_attempt','reset','password_changed','login_alert','account_deleted');
CREATE TYPE outbox_status         AS ENUM ('pending','sent','failed');
CREATE TYPE number_format         AS ENUM ('dot_comma','comma_dot');
CREATE TYPE date_format           AS ENUM ('dmy','iso','short_text');
CREATE TYPE week_start            AS ENUM ('monday','sunday');
CREATE TYPE theme_mode            AS ENUM ('system','light','dark');
CREATE TYPE market_rate_kind      AS ENUM ('parallel_bid','parallel_ask','parallel_median','official');
CREATE TYPE rate_source           AS ENUM ('paralelo_bo','bcb','seed');
CREATE TYPE currency_status       AS ENUM ('active','inactive');
CREATE TYPE fx_event_kind         AS ENUM ('reference_set','manual_usd_on','manual_usd_off','custom_rate');
CREATE TYPE account_type          AS ENUM ('cash','bank','ewallet','credit_card','savings','other');
CREATE TYPE lifecycle_status      AS ENUM ('active','archived');
CREATE TYPE category_kind         AS ENUM ('expense','income');
CREATE TYPE system_category_key   AS ENUM ('debts','debts_interest');
CREATE TYPE transaction_kind      AS ENUM ('expense','income','transfer','adjustment');
CREATE TYPE transaction_origin    AS ENUM ('manual','recurring','debt_initial','debt_payment','fee','goal_transfer');
CREATE TYPE undo_kind             AS ENUM ('delete','recategorize','create');
CREATE TYPE entry_kind            AS ENUM ('expense','income','transfer');
CREATE TYPE budget_scope          AS ENUM ('category','general');
CREATE TYPE budget_status         AS ENUM ('active','paused','finalizing','finalized');
CREATE TYPE budget_default_action AS ENUM ('discard','carry');
CREATE TYPE budget_period_status  AS ENUM ('open','closed_pending','decided','defaulted');
CREATE TYPE allocation_origin     AS ENUM ('manual','budget','confirmed_spend','use_and_close','adjustment');
CREATE TYPE debt_direction        AS ENUM ('i_owe','owed_to_me');
CREATE TYPE debt_status           AS ENUM ('active','paid','forgiven');
CREATE TYPE interest_period       AS ENUM ('monthly','yearly');
CREATE TYPE rule_frequency        AS ENUM ('daily','weekly','monthly','yearly');
CREATE TYPE rule_end_type         AS ENUM ('none','until','count');
CREATE TYPE rule_mode             AS ENUM ('auto','confirm');
CREATE TYPE rule_status           AS ENUM ('active','paused','finished');
CREATE TYPE occurrence_status     AS ENUM ('pending','registered','skipped','omitted');
CREATE TYPE notification_type     AS ENUM ('payment_upcoming','budget_alert','period_close','recurring_pending','log_day','goal_progress');
CREATE TYPE decision_status       AS ENUM ('waiting','resolved');

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
