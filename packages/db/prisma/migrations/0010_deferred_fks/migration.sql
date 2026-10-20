-- Foreign keys towards tables created in later migrations (plan §3.1, plan §3.8, plan §3.9).
-- Together with 0001..0009 this closes the initial migration of plan §3.1.
-- The SET NULL column lists keep user_id intact when the referenced row is deleted.

-- Deleting the default account leaves the user without a default account (RF-M4-13).
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_user_id_default_account_id_fkey FOREIGN KEY (user_id, default_account_id)
    REFERENCES account (user_id, id) ON DELETE SET NULL (default_account_id);

-- Deleting a category removes it from the favorites.
ALTER TABLE favorite_category
  ADD CONSTRAINT favorite_category_user_id_category_id_fkey FOREIGN KEY (user_id, category_id)
    REFERENCES category (user_id, id) ON DELETE CASCADE;

-- Deleting a rule keeps its movements and their recurring_label (RF-M14-11).
ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_user_id_recurring_rule_id_fkey FOREIGN KEY (user_id, recurring_rule_id)
    REFERENCES recurring_rule (user_id, id) ON DELETE SET NULL (recurring_rule_id);
