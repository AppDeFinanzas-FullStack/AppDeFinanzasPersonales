/** A session created by the gateway: its id, its opaque token and the `Set-Cookie` header value. */
export interface CreatedSession {
  sessionId: string;
  token: string;
  /** Full `Set-Cookie` header value (`HttpOnly; Secure; SameSite=Lax`) carrying the signed token. */
  cookie: string;
}

/** The identity behind a valid session token. */
export interface ResolvedSession {
  sessionId: string;
  userId: string;
}

export interface AuthGateway {
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  /** Stores the password hash as the user's credential. */
  createUserCredential(userId: string, passwordHash: string): Promise<void>;
  /** Replaces the password hash of the user's credential. */
  setPassword(userId: string, passwordHash: string): Promise<void>;
  markEmailVerified(userId: string): Promise<void>;
  createSession(userId: string): Promise<CreatedSession>;
  /** Resolves a session by its raw token, or null when it is unknown or expired. */
  getSession(token: string): Promise<ResolvedSession | null>;
  deleteSession(sessionId: string): Promise<void>;
  /** Closes every session of the user, except `exceptSessionId` when given. */
  revokeSessions(userId: string, exceptSessionId?: string): Promise<void>;
}
