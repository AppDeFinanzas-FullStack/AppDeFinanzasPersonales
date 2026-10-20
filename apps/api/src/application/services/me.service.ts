import { AppError } from '../errors.js';
import type { AuthGateway } from '../ports/auth-gateway.js';

/** The profile of a user, as the application sees it. */
export interface MeProfileData {
  id: string;
  name: string;
  email: string;
  timezone: string;
  onboardingStep: number;
  onboardingCompleted: boolean;
}

/** Changes the profile allows (RF-M1-11); the email is not among them (RF-M1-13). */
export interface MeChanges {
  name?: string | undefined;
  timezone?: string | undefined;
}

/** Storage of the profile, always addressed by the id of the session's user (RN-09). */
export interface MeStore {
  findByUserId(userId: string): Promise<MeProfileData | null>;
  /** Updates only the given fields of the user's name and timezone; dates are never touched. */
  update(userId: string, changes: MeChanges): Promise<void>;
  /** The email and password hash of the user, or null when it does not exist. */
  findCredential(userId: string): Promise<{ email: string; passwordHash: string | null } | null>;
  /**
   * Under the user's lock, queues `account_deleted` for the email and deletes the user with all
   * of its data and sessions (cascade, plan §3.8).
   */
  deleteAccount(userId: string, email: string): Promise<void>;
}

export interface MeService {
  get(userId: string): Promise<MeProfileData>;
  update(userId: string, changes: MeChanges): Promise<MeProfileData>;
  /** Deletes the account after checking the password and the word ELIMINAR (RF-M1-15). */
  deleteAccount(input: { userId: string; password: string; confirmation: string }): Promise<void>;
}

const CONFIRMATION_WORD = 'ELIMINAR';

export function createMeService({
  store,
  auth,
}: {
  store: MeStore;
  auth: AuthGateway;
}): MeService {
  const load = async (userId: string): Promise<MeProfileData> => {
    const profile = await store.findByUserId(userId);
    if (profile === null) {
      throw new AppError('SESSION_EXPIRED');
    }
    return profile;
  };

  return {
    get: load,

    async update(userId, changes) {
      if (changes.name !== undefined || changes.timezone !== undefined) {
        await store.update(userId, changes);
      }
      return load(userId);
    },

    async deleteAccount({ userId, password, confirmation }) {
      const credential = await store.findCredential(userId);
      if (credential === null) {
        throw new AppError('SESSION_EXPIRED');
      }
      const valid =
        credential.passwordHash !== null &&
        (await auth.verifyPassword(credential.passwordHash, password));
      if (!valid) {
        throw new AppError('INVALID_PASSWORD');
      }
      if (confirmation !== CONFIRMATION_WORD) {
        throw new AppError('CONFIRMATION_MISMATCH');
      }
      await store.deleteAccount(userId, credential.email);
    },
  };
}
