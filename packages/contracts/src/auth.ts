import { z } from 'zod';

const DEFAULT_TIMEZONE = 'America/La_Paz';

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(8).max(128);
const PersonName = z.string().trim().min(1).max(60);
const Timezone = z.string().refine(isIanaTimezone).catch(DEFAULT_TIMEZONE);
const Token = z.string().min(32);

export const SignUpInput = z.object({
  name: PersonName,
  email: Email,
  password: Password,
  acceptTerms: z.literal(true),
  timezone: Timezone.optional(),
});

export const SignInInput = z.object({
  email: Email,
  password: z.string().min(1).max(128),
});

export const ResendInput = z.union([z.object({ email: Email }), z.object({ token: Token })]);

export const ConfirmInput = z.object({ token: Token });

export const ForgotInput = z.object({ email: Email });

export const ResetInput = z.object({ token: Token, newPassword: Password });

export const ChangePwdInput = z.object({
  currentPassword: z.string().min(1),
  newPassword: Password,
});

export const UpdateMeInput = z.strictObject({
  name: PersonName.optional(),
  timezone: Timezone.optional(),
});

export const DeleteAccountInput = z.object({
  password: z.string().min(1),
  confirmation: z.literal('ELIMINAR'),
});

export const MeDto = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  timezone: z.string(),
  locale: z.literal('es-BO'),
  release: z.enum(['1.0', '1.1', '1.2']),
  onboarding: z.object({
    step: z.number().int(),
    completed: z.boolean(),
  }),
});

export type SignUpInput = z.infer<typeof SignUpInput>;
export type SignInInput = z.infer<typeof SignInInput>;
export type ResendInput = z.infer<typeof ResendInput>;
export type ConfirmInput = z.infer<typeof ConfirmInput>;
export type ForgotInput = z.infer<typeof ForgotInput>;
export type ResetInput = z.infer<typeof ResetInput>;
export type ChangePwdInput = z.infer<typeof ChangePwdInput>;
export type UpdateMeInput = z.infer<typeof UpdateMeInput>;
export type DeleteAccountInput = z.infer<typeof DeleteAccountInput>;
export type MeDto = z.infer<typeof MeDto>;
