-- Categories (plan §3.5, plan §4.5.3, M5: RF-M5-01, RF-M5-02, RF-M5-05, EC-M5-01).
-- The favorite_category -> category foreign key is added in a later migration (TASK-020).

CREATE TABLE category (
  id          uuid                NOT NULL,
  user_id     uuid                NOT NULL,
  kind        category_kind       NOT NULL,
  parent_id   uuid,
  name        varchar(30)         NOT NULL,
  color       varchar(16)         NOT NULL,
  icon        varchar(32)         NOT NULL,
  is_system   boolean             NOT NULL DEFAULT false,
  system_key  system_category_key,
  seed_order  smallint,
  status      lifecycle_status    NOT NULL DEFAULT 'active',
  archived_at timestamptz,
  sort_order  integer             NOT NULL,
  created_at  timestamptz         NOT NULL DEFAULT now(),
  updated_at  timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT category_pkey PRIMARY KEY (id),
  CONSTRAINT category_user_id_id_key UNIQUE (user_id, id),
  CONSTRAINT category_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_user (id) ON DELETE CASCADE,
  CONSTRAINT category_user_id_parent_id_fkey FOREIGN KEY (user_id, parent_id)
    REFERENCES category (user_id, id) ON DELETE RESTRICT,
  CONSTRAINT category_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 30),
  CONSTRAINT category_system_check CHECK (is_system = (system_key IS NOT NULL)),
  CONSTRAINT category_archived_check CHECK ((status = 'archived') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX category_active_name ON category (user_id, kind, parent_id, lower(name))
  NULLS NOT DISTINCT WHERE status = 'active';
CREATE UNIQUE INDEX category_system_key ON category (user_id, kind, system_key)
  WHERE system_key IS NOT NULL;

CREATE TRIGGER category_set_updated_at BEFORE UPDATE ON category
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Hierarchy and protection rules (plan §4.5.3): a single level, the parent has the same kind and is
-- active, a category with subcategories never becomes a subcategory, the kind never changes
-- (RF-M5-01) and a system category only changes its color and its icon (RF-M5-05).
CREATE FUNCTION category_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  parent category%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'category kind is immutable'
        USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.is_system
       AND (to_jsonb(NEW) - 'color' - 'icon' - 'updated_at')
           IS DISTINCT FROM (to_jsonb(OLD) - 'color' - 'icon' - 'updated_at') THEN
      RAISE EXCEPTION 'a system category only changes its color and its icon'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.parent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'a category cannot be its own parent'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO parent
      FROM category
     WHERE user_id = NEW.user_id AND id = NEW.parent_id
       FOR SHARE;

    -- A parent of another user does not exist for this user: the foreign key rejects it.
    IF FOUND THEN
      IF parent.parent_id IS NOT NULL THEN
        RAISE EXCEPTION 'categories allow a single level of subcategories'
          USING ERRCODE = 'check_violation';
      END IF;
      IF parent.kind <> NEW.kind THEN
        RAISE EXCEPTION 'a subcategory must have the same kind as its parent'
          USING ERRCODE = 'check_violation';
      END IF;
      IF parent.status <> 'active' THEN
        RAISE EXCEPTION 'the parent category must be active'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF TG_OP = 'UPDATE'
       AND EXISTS (SELECT 1 FROM category WHERE user_id = NEW.user_id AND parent_id = NEW.id) THEN
      RAISE EXCEPTION 'a category with subcategories cannot become a subcategory'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER category_guard BEFORE INSERT OR UPDATE ON category
  FOR EACH ROW EXECUTE FUNCTION category_guard();
