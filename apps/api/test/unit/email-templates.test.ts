import { describe, expect, it } from 'vitest';
import {
  EMAIL_KINDS,
  emailTemplates,
  renderEmail,
  type EmailKind,
} from '../../src/infrastructure/integrations/email-templates.js';

const FIVE_KINDS = ['confirm', 'register_attempt', 'reset', 'password_changed', 'account_deleted'];
const LINK = 'https://app.example.com/auth/confirm?t=LINKTOKEN123';
const LINK_KINDS: EmailKind[] = ['confirm', 'reset'];
const NO_LINK_KINDS: EmailKind[] = ['register_attempt', 'password_changed', 'account_deleted'];

describe('email templates', () => {
  it('RF-M1-16 EMAIL_KINDS lists exactly the 5 email kinds', () => {
    expect([...EMAIL_KINDS].sort()).toEqual([...FIVE_KINDS].sort());
    expect(new Set(EMAIL_KINDS).size).toBe(5);
    expect(EMAIL_KINDS).not.toContain('login_alert');
  });

  it('RF-M1-16 there is exactly one template per email_kind', () => {
    expect(Object.keys(emailTemplates).sort()).toEqual([...FIVE_KINDS].sort());
    for (const kind of EMAIL_KINDS) {
      expect(typeof emailTemplates[kind]).toBe('function');
    }
  });

  it.each(FIVE_KINDS)('RF-M1-16 %s renders subject, text and html in Spanish', (kind) => {
    const out = renderEmail(kind as EmailKind, { link: LINK });
    expect(out.subject.trim().length).toBeGreaterThan(0);
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.html.trim().length).toBeGreaterThan(0);
    expect(Object.keys(out).sort()).toEqual(['html', 'subject', 'text']);
    expect(`${out.subject} ${out.text}`).toMatch(/[áéíóúñ¿¡]|cuenta|contraseña|correo|tu |su /i);
  });

  it('RF-M1-16 renderEmail delegates to the template of its kind', () => {
    for (const kind of EMAIL_KINDS) {
      expect(renderEmail(kind, { link: LINK })).toEqual(emailTemplates[kind]({ link: LINK }));
    }
  });

  it('RNF-25 templates exist for password change and account deletion, and none for failed attempts', () => {
    expect(Object.keys(emailTemplates)).not.toContain('login_alert');
    for (const kind of ['password_changed', 'account_deleted'] as const) {
      expect(typeof emailTemplates[kind]).toBe('function');
      const out = renderEmail(kind, {});
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(0);
      expect(out.html.length).toBeGreaterThan(0);
    }
  });

  it.each(LINK_KINDS)('RF-M1-16 %s includes the link in text and html', (kind) => {
    const out = renderEmail(kind, { link: LINK });
    expect(out.text).toContain(LINK);
    expect(out.html).toContain(LINK);
  });

  it.each(NO_LINK_KINDS)('RF-M1-16 %s does not use the payload link', (kind) => {
    const out = renderEmail(kind, { link: LINK });
    expect(out.subject).not.toContain(LINK);
    expect(out.text).not.toContain(LINK);
    expect(out.html).not.toContain(LINK);
    expect(renderEmail(kind, { link: LINK })).toEqual(renderEmail(kind, {}));
  });

  it('RF-M1-16 templates ignore any other payload field', () => {
    const extra = { link: LINK, password: 'Sup3rSecret!', token: 'RAWTOKEN999', amount: '1500.00' };
    for (const kind of EMAIL_KINDS) {
      const out = renderEmail(kind, extra);
      const base = renderEmail(kind, { link: LINK });
      expect(out).toEqual(base);
    }
  });

  it('RNF-25 no template includes the password or the token outside the link', () => {
    const extra = { link: LINK, password: 'Sup3rSecret!', token: 'RAWTOKEN999' };
    for (const kind of EMAIL_KINDS) {
      const out = renderEmail(kind, extra);
      for (const part of [out.subject, out.text, out.html]) {
        expect(part).not.toContain('Sup3rSecret!');
        expect(part).not.toContain('RAWTOKEN999');
        // the token embedded in the link only appears as part of the link itself
        const withoutLink = part.split(LINK).join('');
        expect(withoutLink).not.toContain('LINKTOKEN123');
      }
    }
  });

  it('RNF-25 no template includes amounts', () => {
    for (const kind of EMAIL_KINDS) {
      const out = renderEmail(kind, { link: LINK });
      const withoutLink = `${out.subject} ${out.text} ${out.html}`.split(LINK).join('');
      expect(withoutLink).not.toMatch(/\bBs\.?\s*\d|\bUSD\s*\d|\$\s*\d/);
    }
  });
});
