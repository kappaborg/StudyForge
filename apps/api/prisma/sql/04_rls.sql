-- Row-level security: defence in depth on top of application-layer tenant checks.
-- Application code sets `app.tenant_id` per connection (via SET LOCAL inside a
-- transaction). Without it, no tenant-scoped row is visible. The migration runner
-- and the GDPR eraser bypass RLS via the BYPASSRLS role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studyforge_app') THEN
    CREATE ROLE studyforge_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studyforge_admin') THEN
    CREATE ROLE studyforge_admin NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- Grant the application role base privileges. Application creates its own
-- database role at deploy time and inherits studyforge_app.
GRANT USAGE ON SCHEMA public TO studyforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO studyforge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO studyforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studyforge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO studyforge_app;

-- Helper that returns the current tenant id from the per-connection setting.
-- Returns NULL when unset, which makes every tenant-scoped query empty.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
  -- Tables that carry a `tenantId` column and must be tenant-scoped.
  tenant_tables text[] := ARRAY[
    'User', 'Course', 'UploadBatch', 'Document', 'ChatSession',
    'Notification', 'UsageEvent', 'ApiKey', 'AuditLog', 'Job',
    'DSARRequest', 'CachedResponse', 'StudentModel', 'Tenant'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    IF t = 'Tenant' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (id = app_current_tenant())', t);
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = app_current_tenant())', t);
    END IF;
  END LOOP;
END $$;
