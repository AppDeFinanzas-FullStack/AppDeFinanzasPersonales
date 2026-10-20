import type { EmailKind, EmailPayload } from '../../application/ports/email-gateway.js';

export type { EmailKind, EmailPayload };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const EMAIL_KINDS = [
  'confirm',
  'register_attempt',
  'reset',
  'password_changed',
  'login_alert',
  'account_deleted',
] as const satisfies readonly EmailKind[];

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const build = (subject: string, paragraphs: string[], link?: string): RenderedEmail => {
  const textParts = [...paragraphs];
  const htmlParts = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`);
  if (link !== undefined) {
    textParts.push(link);
    const safe = escapeHtml(link);
    htmlParts.push(`<p><a href="${safe}">${safe}</a></p>`);
  }
  return {
    subject,
    text: textParts.join('\n\n'),
    html: `<!doctype html><html lang="es"><body>${htmlParts.join('')}</body></html>`,
  };
};

export const emailTemplates: Record<EmailKind, (payload: EmailPayload) => RenderedEmail> = {
  confirm: (payload) =>
    build(
      'Confirma tu correo',
      ['Para activar tu cuenta, confirma tu correo con el siguiente enlace.'],
      payload.link,
    ),
  register_attempt: () =>
    build('Intento de registro con tu correo', [
      'Alguien intentó crear una cuenta con tu correo, pero ya tienes una. Si fuiste tú, inicia sesión o recupera tu contraseña. Si no, ignora este mensaje.',
    ]),
  reset: (payload) =>
    build(
      'Recupera tu contraseña',
      ['Usa el siguiente enlace para crear una nueva contraseña. Si no lo pediste, ignora este mensaje.'],
      payload.link,
    ),
  password_changed: () =>
    build('Cambió la contraseña de tu cuenta', [
      'La contraseña de tu cuenta fue cambiada. Si no fuiste tú, recupera tu contraseña de inmediato.',
    ]),
  login_alert: () =>
    build('Intentos fallidos de inicio de sesión', [
      'Detectamos varios intentos fallidos de inicio de sesión en tu cuenta. Si no fuiste tú, cambia tu contraseña.',
    ]),
  account_deleted: () =>
    build('Tu cuenta fue eliminada', [
      'Tu cuenta y tus datos fueron eliminados. Si no fuiste tú, contáctanos.',
    ]),
};

export const renderEmail = (kind: EmailKind, payload: EmailPayload): RenderedEmail =>
  emailTemplates[kind](payload);
