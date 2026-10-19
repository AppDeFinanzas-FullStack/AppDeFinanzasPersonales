export interface AuthSession {
  userId: string;
  timezone: string;
}

export interface AuthGateway {
  /** Resolves the session from request headers, or null when there is none. */
  getSession(headers: Record<string, string | string[] | undefined>): Promise<AuthSession | null>;
}
