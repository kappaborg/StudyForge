-- Hash-chained, append-only AuditLog. Each row's hash = sha256(prevHash || canonical_json).
-- The trigger computes hash on INSERT and rejects any UPDATE / DELETE.
-- A nightly verifier walks the chain end-to-end and alerts on the first mismatch.

CREATE OR REPLACE FUNCTION audit_log_seal() RETURNS trigger AS $$
DECLARE
  prev bytea;
  payload bytea;
BEGIN
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'AuditLog is append-only (%) blocked', TG_OP;
  END IF;

  SELECT "hash" INTO prev FROM "AuditLog" ORDER BY "id" DESC LIMIT 1;
  IF prev IS NULL THEN
    prev := decode('0000000000000000000000000000000000000000000000000000000000000000', 'hex');
  END IF;
  NEW."prevHash" := prev;

  payload := convert_to(
    coalesce(NEW."tenantId"::text, '') || '|' ||
    coalesce(NEW."actorId"::text, '')  || '|' ||
    coalesce(NEW."actorKind", '')      || '|' ||
    NEW."action"                        || '|' ||
    coalesce(NEW."resource", '')        || '|' ||
    coalesce(NEW."payload"::text, '')   || '|' ||
    to_char(NEW."ts" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    'UTF8'
  );
  NEW."hash" := digest(NEW."prevHash" || payload, 'sha256');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_seal_trg ON "AuditLog";
CREATE TRIGGER audit_log_seal_trg
  BEFORE INSERT OR UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_seal();

-- Verifier: walks the chain and returns the first broken row id, or NULL when
-- intact. The nightly job calls this and pages on a non-null result.
CREATE OR REPLACE FUNCTION audit_log_verify() RETURNS bigint AS $$
DECLARE
  r record;
  expected bytea;
  prev bytea := decode('0000000000000000000000000000000000000000000000000000000000000000', 'hex');
  payload bytea;
BEGIN
  FOR r IN SELECT * FROM "AuditLog" ORDER BY "id" ASC LOOP
    payload := convert_to(
      coalesce(r."tenantId"::text, '') || '|' ||
      coalesce(r."actorId"::text, '')  || '|' ||
      coalesce(r."actorKind", '')      || '|' ||
      r."action"                        || '|' ||
      coalesce(r."resource", '')        || '|' ||
      coalesce(r."payload"::text, '')   || '|' ||
      to_char(r."ts" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      'UTF8'
    );
    expected := digest(prev || payload, 'sha256');
    IF r."hash" <> expected OR r."prevHash" <> prev THEN
      RETURN r."id";
    END IF;
    prev := r."hash";
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;
