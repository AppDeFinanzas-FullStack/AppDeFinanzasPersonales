import { createHash, randomBytes } from 'node:crypto';

import type { EmailLinkPurpose } from '../ports/repositories.js';

/** Lifetime of each kind of link, in seconds (RF-M1-05 confirmation 24 h, RF-M1-09 recovery 1 h). */
export const EMAIL_LINK_LIFETIME_SECONDS: Readonly<Record<EmailLinkPurpose, number>> = {
  confirm_email: 24 * 60 * 60,
  reset_password: 60 * 60,
};

/** A random 32-byte token, as base64url text (43 characters). */
export function generateEmailLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a token in hex: the only form that is stored (plan §3.9). */
export function hashEmailLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
