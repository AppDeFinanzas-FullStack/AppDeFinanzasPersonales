import { createHmac } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { uuidv7 } from 'uuidv7';

import type { AuthGateway } from '../../application/ports/auth-gateway.js';

import type { PrismaClient } from '../persistence/prisma-client.js';

/** Session lifetime without activity (RF-M1-07). */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CREDENTIAL_PROVIDER = 'credential';

export interface BetterAuthGatewayOptions {
  prisma: PrismaClient;
  secret: string;
}

/**
 * The `AuthGateway` over Better Auth's server API (ADR-08). The generic HTTP handler of Better Auth
 * is never mounted: only its internal adapter, password hashing and cookie settings are used.
 */
export function createBetterAuthGateway(options: BetterAuthGatewayOptions): AuthGateway {
  const auth = betterAuth({
    secret: options.secret,
    // Better Auth only needs the model delegates of the client; its types are structural.
    database: prismaAdapter(options.prisma as never, { provider: 'postgresql' }),
    user: { modelName: 'authUser' },
    session: {
      modelName: 'authSession',
      expiresIn: SESSION_TTL_SECONDS,
      additionalFields: {
        lastActivityAt: { type: 'date', required: true, input: false },
      },
    },
    account: { modelName: 'authAccount' },
    verification: { modelName: 'authVerification' },
    advanced: {
      useSecureCookies: true,
      database: { generateId: () => uuidv7() },
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax' },
    },
  });

  const contextPromise = auth.$context;

  return {
    hashPassword: (password) => hashPassword(password),
    verifyPassword: (hash, password) => verifyPassword({ hash, password }),

    async createUserCredential(userId, passwordHash) {
      const ctx = await contextPromise;
      await ctx.internalAdapter.linkAccount({
        userId,
        providerId: CREDENTIAL_PROVIDER,
        accountId: userId,
        password: passwordHash,
      });
    },

    async setPassword(userId, passwordHash) {
      const ctx = await contextPromise;
      await ctx.internalAdapter.updatePassword(userId, passwordHash);
    },

    async markEmailVerified(userId) {
      const ctx = await contextPromise;
      await ctx.internalAdapter.updateUser(userId, { emailVerified: true });
    },

    async createSession(userId) {
      const ctx = await contextPromise;
      const session = await ctx.internalAdapter.createSession(userId, false, {
        lastActivityAt: new Date(),
      });
      const cookieConfig = ctx.authCookies.sessionToken;
      const signature = createHmac('sha256', options.secret).update(session.token).digest('base64');
      const value = encodeURIComponent(`${session.token}.${signature}`);
      const expires = session.expiresAt.toUTCString();
      const cookie =
        `${cookieConfig.name}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Expires=${expires}; ` +
        'Path=/; HttpOnly; Secure; SameSite=Lax';
      return { sessionId: session.id, token: session.token, cookie };
    },

    async getSession(token) {
      const ctx = await contextPromise;
      const found = await ctx.internalAdapter.findSession(token);
      if (!found || found.session.expiresAt.getTime() <= Date.now()) {
        return null;
      }
      return { sessionId: found.session.id, userId: found.session.userId };
    },

    async deleteSession(sessionId) {
      const ctx = await contextPromise;
      await ctx.adapter.deleteMany({
        model: 'session',
        where: [{ field: 'id', value: sessionId }],
      });
    },

    async revokeSessions(userId, exceptSessionId) {
      const ctx = await contextPromise;
      await ctx.adapter.deleteMany({
        model: 'session',
        where: [
          { field: 'userId', value: userId },
          ...(exceptSessionId
            ? [{ field: 'id', value: exceptSessionId, operator: 'ne' as const }]
            : []),
        ],
      });
    },
  };
}
