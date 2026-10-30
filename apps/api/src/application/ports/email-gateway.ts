export type EmailKind =
  | 'confirm'
  | 'register_attempt'
  | 'reset'
  | 'password_changed'
  | 'account_deleted';

export interface EmailPayload {
  link?: string;
}

export interface SendEmailInput {
  to: string;
  kind: EmailKind;
  payload: EmailPayload;
}

export interface EmailGateway {
  send(input: SendEmailInput): Promise<void>;
}
