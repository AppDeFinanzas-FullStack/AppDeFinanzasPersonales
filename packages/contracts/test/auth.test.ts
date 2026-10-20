import { describe, expect, it } from 'vitest';

import {
  ChangePwdInput,
  ConfirmInput,
  DeleteAccountInput,
  ForgotInput,
  ResendInput,
  ResetInput,
  SignInInput,
  SignUpInput,
  UpdateMeInput,
} from '../src/index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const validSignUp = {
  name: 'Ana',
  email: 'ana@mail.com',
  password: 'abcdefgh',
  acceptTerms: true,
};

const token = 'a'.repeat(32);

describe('SignUpInput (RF-M1-01)', () => {
  it('RF-M1-01 acepta una entrada valida', () => {
    expect(ok(SignUpInput, validSignUp)).toBe(true);
  });

  it('RF-M1-01 el nombre debe tener de 1 a 60 caracteres', () => {
    expect(ok(SignUpInput, { ...validSignUp, name: '' })).toBe(false);
    expect(ok(SignUpInput, { ...validSignUp, name: '   ' })).toBe(false);
    expect(ok(SignUpInput, { ...validSignUp, name: 'a' })).toBe(true);
    expect(ok(SignUpInput, { ...validSignUp, name: 'a'.repeat(60) })).toBe(true);
    expect(ok(SignUpInput, { ...validSignUp, name: 'a'.repeat(61) })).toBe(false);
  });

  it('RF-M1-01 la contrasena debe tener de 8 a 128 caracteres', () => {
    expect(ok(SignUpInput, { ...validSignUp, password: 'a'.repeat(7) })).toBe(false);
    expect(ok(SignUpInput, { ...validSignUp, password: 'a'.repeat(8) })).toBe(true);
    expect(ok(SignUpInput, { ...validSignUp, password: 'a'.repeat(128) })).toBe(true);
    expect(ok(SignUpInput, { ...validSignUp, password: 'a'.repeat(129) })).toBe(false);
  });

  it('RF-M1-01 acceptTerms es obligatorio y debe ser true', () => {
    const without: Record<string, unknown> = { ...validSignUp };
    delete without.acceptTerms;
    expect(ok(SignUpInput, without)).toBe(false);
    expect(ok(SignUpInput, { ...validSignUp, acceptTerms: false })).toBe(false);
    expect(ok(SignUpInput, { ...validSignUp, acceptTerms: 'true' })).toBe(false);
  });

  it('RF-M1-01 rechaza un correo con formato invalido', () => {
    expect(ok(SignUpInput, { ...validSignUp, email: 'no-es-correo' })).toBe(false);
  });

  it('RF-M1-02 " ANA@mail.com " se normaliza a "ana@mail.com"', () => {
    const r = SignUpInput.parse({ ...validSignUp, email: ' ANA@mail.com ' });
    expect(r.email).toBe('ana@mail.com');
  });

  it('RF-M1-02 SignIn, Forgot y Resend normalizan el correo', () => {
    expect(SignInInput.parse({ email: ' ANA@mail.com ', password: 'x' }).email).toBe(
      'ana@mail.com',
    );
    expect(ForgotInput.parse({ email: ' ANA@mail.com ' }).email).toBe('ana@mail.com');
    expect(ResendInput.parse({ email: ' ANA@mail.com ' })).toEqual({ email: 'ana@mail.com' });
  });

  it('RF-M1-02 el correo admite como maximo 254 caracteres', () => {
    const long = `${'a'.repeat(250)}@b.co`;
    expect(ok(SignUpInput, { ...validSignUp, email: long })).toBe(false);
  });

  it('RF-M1-11 una zona horaria valida se conserva', () => {
    const r = SignUpInput.parse({ ...validSignUp, timezone: 'America/Sao_Paulo' });
    expect(r.timezone).toBe('America/Sao_Paulo');
  });

  it('RF-M1-11 una zona horaria invalida cae a America/La_Paz', () => {
    const r = SignUpInput.parse({ ...validSignUp, timezone: 'Marte/Olympus' });
    expect(r.timezone).toBe('America/La_Paz');
  });

  it('RF-M1-11 la zona horaria es opcional', () => {
    const r = SignUpInput.parse(validSignUp);
    expect(r.timezone).toBeUndefined();
  });
});

describe('UpdateMeInput (RF-M1-11, RF-M1-13)', () => {
  it('RF-M1-11 una zona horaria invalida cae a America/La_Paz en el perfil', () => {
    expect(UpdateMeInput.parse({ timezone: 'no/existe' }).timezone).toBe('America/La_Paz');
    expect(UpdateMeInput.parse({ timezone: 'America/Lima' }).timezone).toBe('America/Lima');
  });

  it('RF-M1-01 el nombre del perfil se valida de 1 a 60', () => {
    expect(ok(UpdateMeInput, { name: '' })).toBe(false);
    expect(ok(UpdateMeInput, { name: 'a'.repeat(61) })).toBe(false);
    expect(ok(UpdateMeInput, { name: 'Ana' })).toBe(true);
    expect(ok(UpdateMeInput, {})).toBe(true);
  });

  it('RF-M1-13 UpdateMeInput rechaza el campo email', () => {
    expect(ok(UpdateMeInput, { name: 'Ana', email: 'otro@mail.com' })).toBe(false);
    expect(ok(UpdateMeInput, { email: 'otro@mail.com' })).toBe(false);
  });
});

describe('DeleteAccountInput (EC-M1-08)', () => {
  it('EC-M1-08 acepta exactamente "ELIMINAR"', () => {
    expect(ok(DeleteAccountInput, { password: 'x', confirmation: 'ELIMINAR' })).toBe(true);
  });

  it('EC-M1-08 rechaza cualquier otra palabra', () => {
    for (const confirmation of ['eliminar', 'Eliminar', ' ELIMINAR', 'ELIMINAR ', 'ELIMINA', '']) {
      expect(ok(DeleteAccountInput, { password: 'x', confirmation })).toBe(false);
    }
  });

  it('EC-M1-08 la contrasena es obligatoria', () => {
    expect(ok(DeleteAccountInput, { password: '', confirmation: 'ELIMINAR' })).toBe(false);
    expect(ok(DeleteAccountInput, { confirmation: 'ELIMINAR' })).toBe(false);
  });
});

describe('otros contratos de M1 (plan 4.1.1)', () => {
  it('RF-M1-01 SignInInput exige contrasena de 1 a 128', () => {
    expect(ok(SignInInput, { email: 'a@b.co', password: '' })).toBe(false);
    expect(ok(SignInInput, { email: 'a@b.co', password: 'a'.repeat(128) })).toBe(true);
    expect(ok(SignInInput, { email: 'a@b.co', password: 'a'.repeat(129) })).toBe(false);
  });

  it('RF-M1-01 ResendInput acepta correo o token de al menos 32', () => {
    expect(ok(ResendInput, { email: 'a@b.co' })).toBe(true);
    expect(ok(ResendInput, { token })).toBe(true);
    expect(ok(ResendInput, { token: 'corto' })).toBe(false);
    expect(ok(ResendInput, {})).toBe(false);
  });

  it('RF-M1-01 ConfirmInput exige token de al menos 32', () => {
    expect(ok(ConfirmInput, { token })).toBe(true);
    expect(ok(ConfirmInput, { token: 'a'.repeat(31) })).toBe(false);
  });

  it('RF-M1-01 ForgotInput exige correo valido', () => {
    expect(ok(ForgotInput, { email: 'a@b.co' })).toBe(true);
    expect(ok(ForgotInput, { email: 'x' })).toBe(false);
  });

  it('RF-M1-01 ResetInput valida token y nueva contrasena de 8 a 128', () => {
    expect(ok(ResetInput, { token, newPassword: 'a'.repeat(8) })).toBe(true);
    expect(ok(ResetInput, { token, newPassword: 'a'.repeat(7) })).toBe(false);
    expect(ok(ResetInput, { token, newPassword: 'a'.repeat(129) })).toBe(false);
    expect(ok(ResetInput, { token: 'corto', newPassword: 'a'.repeat(8) })).toBe(false);
  });

  it('RF-M1-01 ChangePwdInput valida contrasena actual y nueva', () => {
    expect(ok(ChangePwdInput, { currentPassword: 'x', newPassword: 'a'.repeat(8) })).toBe(true);
    expect(ok(ChangePwdInput, { currentPassword: '', newPassword: 'a'.repeat(8) })).toBe(false);
    expect(ok(ChangePwdInput, { currentPassword: 'x', newPassword: 'a'.repeat(7) })).toBe(false);
  });
});
