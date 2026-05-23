// Strict v4-or-similar UUID regex. Used to gate Prisma calls so a
// non-UUID URL segment (e.g. the FE's "demo" placeholder course id)
// doesn't crash the request with a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
