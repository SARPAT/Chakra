// Hasher — SHA-256 hashing for PII (user IDs, session tokens)
// Privacy is non-negotiable: all identifiers are hashed before storage.
// Uses Node.js built-in crypto — no external dependency.

import { createHash } from 'crypto';

/**
 * SHA-256 hash of a string value.
 * Returns a 64-character hex string.
 * Used for session tokens and user IDs before any storage.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Hash a nullable identifier.
 * Returns null if the input is null/undefined/empty — preserves nullability.
 */
export function hashId(value: string | null | undefined): string | null {
  if (!value) return null;
  return sha256(value);
}
