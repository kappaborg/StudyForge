import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Envelope encryption helpers.
 *
 *   plaintext --AES-256-GCM(DEK, iv)--> {cipher, iv, tag}
 *   DEK       --AES-256-GCM(KEK, iv)--> wrappedDek
 *
 * The KEK never leaves the KMS / Vault boundary in production. For the Phase 0
 * dev loop we accept a raw 32-byte KEK from `STUDYFORGE_KEK_BASE64` so the
 * envelope contract is exercisable end to end without external infra. The
 * Phase 1 KMS integration replaces `kekUnwrap` only — every consumer of this
 * module keeps working.
 */

const AES_KEY_BYTES = 32; // 256 bits
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface EncryptedSecret {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** Last 4 chars of the plaintext, the only fragment ever rendered to a user. */
  last4: string;
}

export interface EnvelopeContext {
  /** Per-tenant DEK ciphertext, wrapped by the KEK. Stored on `Tenant.wrappedDek`. */
  wrappedDek: Buffer;
}

/**
 * Encrypts a secret under the per-tenant DEK. The DEK itself is unwrapped from
 * the tenant context using the KEK, kept in memory for the duration of this
 * call only, and zeroed before returning.
 */
export function encryptSecret(
  plaintext: string,
  ctx: EnvelopeContext,
  kek: Buffer,
): EncryptedSecret {
  if (plaintext.length === 0) throw new Error('refusing to encrypt empty plaintext');
  if (kek.length !== AES_KEY_BYTES) throw new Error('KEK must be 32 bytes');
  const dek = kekUnwrap(ctx.wrappedDek, kek);
  try {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      cipher: encrypted,
      iv,
      tag,
      last4: lastFour(plaintext),
    };
  } finally {
    dek.fill(0);
  }
}

/**
 * Decrypts a secret. The plaintext lives only inside the returned Buffer; the
 * caller is responsible for zeroing it after use. The audit-log `byok.decrypt`
 * action is the caller's responsibility — this module is purposely unaware of
 * cross-cutting concerns.
 */
export function decryptSecret(
  encrypted: EncryptedSecret,
  ctx: EnvelopeContext,
  kek: Buffer,
): Buffer {
  if (kek.length !== AES_KEY_BYTES) throw new Error('KEK must be 32 bytes');
  if (encrypted.iv.length !== GCM_IV_BYTES) throw new Error('IV must be 12 bytes');
  if (encrypted.tag.length !== GCM_TAG_BYTES) throw new Error('tag must be 16 bytes');
  const dek = kekUnwrap(ctx.wrappedDek, kek);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, encrypted.iv);
    decipher.setAuthTag(encrypted.tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted.cipher),
      decipher.final(),
    ]);
    return plaintext;
  } finally {
    dek.fill(0);
  }
}

/**
 * Generates a new tenant DEK and wraps it under the KEK. Returns the bytes the
 * caller should store on `Tenant.wrappedDek`. The plaintext DEK is zeroed
 * before returning.
 */
export function wrapNewDek(kek: Buffer): Buffer {
  if (kek.length !== AES_KEY_BYTES) throw new Error('KEK must be 32 bytes');
  const dek = randomBytes(AES_KEY_BYTES);
  try {
    return kekWrap(dek, kek);
  } finally {
    dek.fill(0);
  }
}

/**
 * Constant-time equality check for surfacing-safe comparisons (e.g. matching
 * BYOK `last4` fingerprints without leaking timing).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return timingSafeEqual(ab, bb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function kekWrap(dek: Buffer, kek: Buffer): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv || tag || ciphertext. Self-contained so the wrapped DEK is a
  // single column on `Tenant`.
  return Buffer.concat([iv, tag, encrypted]);
}

function kekUnwrap(wrapped: Buffer, kek: Buffer): Buffer {
  if (wrapped.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) {
    throw new Error('wrappedDek is malformed');
  }
  const iv = wrapped.subarray(0, GCM_IV_BYTES);
  const tag = wrapped.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const cipher = wrapped.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

function lastFour(plaintext: string): string {
  if (plaintext.length <= 4) return plaintext;
  return plaintext.slice(-4);
}

export const __INTERNAL__ = { kekWrap, kekUnwrap, lastFour };
