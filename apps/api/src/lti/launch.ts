import { createPublicKey, createVerify } from 'node:crypto';

/**
 * LTI 1.3 launch validator.
 *
 *   * Verifies the `id_token` JWS signature against the issuer's JWKS.
 *   * Validates the required IMS claims (iss, aud, azp, nonce, iat, exp,
 *     deployment_id, message_type, version).
 *   * Returns a typed `LtiClaims` object for downstream provisioning.
 *
 * Supports RS256, RS384, RS512, ES256, ES384, PS256. AGS / NRPS endpoints
 * reuse the resolved deployment_id from `LtiClaims.deploymentId`.
 */

const LEEWAY_SEC = 60;

export type LtiLaunchErrorCode =
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'key_not_found'
  | 'signature_invalid'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'nonce_missing'
  | 'expired'
  | 'not_yet_valid'
  | 'missing_claim';

export class LtiLaunchError extends Error {
  readonly code: LtiLaunchErrorCode;

  constructor(code: LtiLaunchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LtiLaunchError';
  }
}

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
}

export interface JwksFetcher {
  fetchKey(kid: string): Promise<Jwk | null>;
}

export interface LtiTrustConfig {
  /** Expected issuer (e.g. `https://canvas.instructure.com`). */
  issuer: string;
  /** Expected `aud` value — our tool's client_id at the platform. */
  clientId: string;
}

export interface LtiClaims {
  iss: string;
  aud: string;
  sub: string;
  nonce: string;
  iat: number;
  exp: number;
  azp: string;
  deploymentId: string;
  messageType: string;
  contextId?: string;
  resourceLinkId?: string;
  /** Roles claim, with the IMS-Global namespace stripped. */
  roles: string[];
  /** Full decoded payload, retained for downstream provisioning. */
  raw: Record<string, unknown>;
}

const CLAIM_DEPLOYMENT = 'https://purl.imsglobal.org/spec/lti/claim/deployment_id';
const CLAIM_MESSAGE_TYPE = 'https://purl.imsglobal.org/spec/lti/claim/message_type';
const CLAIM_VERSION = 'https://purl.imsglobal.org/spec/lti/claim/version';
const CLAIM_RESOURCE_LINK = 'https://purl.imsglobal.org/spec/lti/claim/resource_link';
const CLAIM_CONTEXT = 'https://purl.imsglobal.org/spec/lti/claim/context';
const CLAIM_ROLES = 'https://purl.imsglobal.org/spec/lti/claim/roles';

export async function verifyLtiLaunch(args: {
  idToken: string;
  trust: LtiTrustConfig;
  jwks: JwksFetcher;
  now?: number;
}): Promise<LtiClaims> {
  const { idToken, trust, jwks } = args;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw new LtiLaunchError('malformed_token', 'id_token must have three segments');
  }
  const [headerSeg, payloadSeg, signatureSeg] = segments as [string, string, string];
  const header = parseJsonBase64(headerSeg) as { alg?: string; kid?: string };
  const payload = parseJsonBase64(payloadSeg) as Record<string, unknown>;

  if (typeof header.alg !== 'string' || !SUPPORTED_ALGS.has(header.alg)) {
    throw new LtiLaunchError(
      'unsupported_algorithm',
      `alg ${String(header.alg)} not in {${[...SUPPORTED_ALGS].join(',')}}`,
    );
  }
  if (typeof header.kid !== 'string' || header.kid === '') {
    throw new LtiLaunchError('malformed_token', 'header.kid is required');
  }

  const jwk = await jwks.fetchKey(header.kid);
  if (jwk === null) {
    throw new LtiLaunchError('key_not_found', `kid ${header.kid} not in JWKS`);
  }

  if (!verifySignature(header.alg, jwk, `${headerSeg}.${payloadSeg}`, signatureSeg)) {
    throw new LtiLaunchError('signature_invalid', 'JWS signature verification failed');
  }

  // ── claim validation ───────────────────────────────────────────────────
  const iss = expectString(payload, 'iss');
  if (iss !== trust.issuer) {
    throw new LtiLaunchError('issuer_mismatch', `iss=${iss} != ${trust.issuer}`);
  }

  const aud = payload['aud'];
  const audMatches = Array.isArray(aud)
    ? aud.includes(trust.clientId)
    : aud === trust.clientId;
  if (!audMatches) {
    throw new LtiLaunchError('audience_mismatch', `aud does not include ${trust.clientId}`);
  }

  const azp = payload['azp'];
  if (typeof azp === 'string' && azp !== trust.clientId) {
    throw new LtiLaunchError('audience_mismatch', `azp=${azp} != ${trust.clientId}`);
  }

  if (typeof payload['nonce'] !== 'string' || payload['nonce'] === '') {
    throw new LtiLaunchError('nonce_missing', 'nonce claim is required');
  }
  const nonce = payload['nonce'];

  const exp = expectNumber(payload, 'exp');
  const iat = expectNumber(payload, 'iat');
  if (now > exp + LEEWAY_SEC) {
    throw new LtiLaunchError('expired', `id_token expired at ${exp}, now ${now}`);
  }
  if (now + LEEWAY_SEC < iat) {
    throw new LtiLaunchError('not_yet_valid', `id_token iat ${iat} is in the future`);
  }

  const deploymentId = payload[CLAIM_DEPLOYMENT];
  if (typeof deploymentId !== 'string' || deploymentId === '') {
    throw new LtiLaunchError('missing_claim', `${CLAIM_DEPLOYMENT} is required`);
  }
  const messageType = payload[CLAIM_MESSAGE_TYPE];
  if (typeof messageType !== 'string' || messageType === '') {
    throw new LtiLaunchError('missing_claim', `${CLAIM_MESSAGE_TYPE} is required`);
  }
  const version = payload[CLAIM_VERSION];
  if (version !== '1.3.0') {
    throw new LtiLaunchError('missing_claim', `expected ${CLAIM_VERSION} = 1.3.0`);
  }

  const sub = expectString(payload, 'sub');

  const rolesRaw = payload[CLAIM_ROLES];
  const roles = Array.isArray(rolesRaw) ? rolesRaw.filter((r): r is string => typeof r === 'string') : [];

  const audValue = typeof aud === 'string' ? aud : (aud as string[])[0]!;

  const resourceLink = payload[CLAIM_RESOURCE_LINK] as { id?: string } | undefined;
  const context = payload[CLAIM_CONTEXT] as { id?: string } | undefined;

  const claims: LtiClaims = {
    iss,
    aud: audValue,
    sub,
    nonce,
    iat,
    exp,
    azp: typeof azp === 'string' ? azp : trust.clientId,
    deploymentId,
    messageType,
    roles,
    raw: payload,
  };
  if (resourceLink?.id !== undefined) claims.resourceLinkId = resourceLink.id;
  if (context?.id !== undefined) claims.contextId = context.id;
  return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORTED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384']);

function verifySignature(
  alg: string,
  jwk: Jwk,
  signingInput: string,
  signatureSeg: string,
): boolean {
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const verify = createVerify(algToDigest(alg));
  verify.update(signingInput);
  verify.end();
  const signature = base64UrlToBuffer(signatureSeg);
  const opts: import('node:crypto').VerifyKeyObjectInput = { key };
  if (alg.startsWith('PS')) {
    opts.padding = 6; // crypto.constants.RSA_PKCS1_PSS_PADDING
    opts.saltLength = -1; // RSA_PSS_SALTLEN_DIGEST
  }
  return verify.verify(opts, signature);
}

function algToDigest(alg: string): string {
  const last3 = alg.slice(-3);
  return `sha${last3}`;
}

function parseJsonBase64(seg: string): Record<string, unknown> {
  return JSON.parse(base64UrlToBuffer(seg).toString('utf8')) as Record<string, unknown>;
}

function base64UrlToBuffer(seg: string): Buffer {
  const pad = seg.length % 4 === 0 ? '' : '='.repeat(4 - (seg.length % 4));
  return Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function expectString(obj: Record<string, unknown>, name: string): string {
  const value = obj[name];
  if (typeof value !== 'string' || value === '') {
    throw new LtiLaunchError('missing_claim', `${name} is required`);
  }
  return value;
}

function expectNumber(obj: Record<string, unknown>, name: string): number {
  const value = obj[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LtiLaunchError('missing_claim', `${name} is required`);
  }
  return value;
}
