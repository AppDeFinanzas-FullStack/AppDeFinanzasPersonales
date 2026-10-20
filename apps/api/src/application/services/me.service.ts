import { AppError } from '../errors.js';

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
}

export interface MeService {
  get(userId: string): Promise<MeProfileData>;
  update(userId: string, changes: MeChanges): Promise<MeProfileData>;
}

export function createMeService({ store }: { store: MeStore }): MeService {
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
  };
}
