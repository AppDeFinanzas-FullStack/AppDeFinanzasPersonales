import { i18n, LANGUAGE } from '@/app/providers/i18n';
import auth from '@/locales/es-BO/auth.json';

import { CheckEmail } from './components/check-email';
import { ConfirmLink } from './components/confirm-link';
import { ForgotPasswordForm } from './components/forgot-password-form';
import { ResetPasswordForm } from './components/reset-password-form';
import { SignInForm } from './components/sign-in-form';
import { SignUpForm } from './components/sign-up-form';

// The feature registers its own namespace (RNF-07).
i18n.addResourceBundle(LANGUAGE, 'auth', auth, true, true);

/** The screens of the public routes of M1 (plan §4.1.4); the router loads them on demand. */
export { CheckEmail, ConfirmLink, ForgotPasswordForm, ResetPasswordForm, SignInForm, SignUpForm };
