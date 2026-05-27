-- Rename space_grants.role 'owner' to 'maintainer'.
-- 'owner' now refers exclusively to spaces.created_by_sub (the creator).
-- Group grants can confer at most maintainer capability.

DO $$
DECLARE
  c_name text;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'space_grants'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%role%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE space_grants DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

UPDATE space_grants SET role = 'maintainer' WHERE role = 'owner';

ALTER TABLE space_grants
  ADD CONSTRAINT space_grants_role_check
  CHECK (role IN ('maintainer','editor','viewer'));
