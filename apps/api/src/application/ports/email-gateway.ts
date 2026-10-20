export interface AccountEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailGateway {
  send(email: AccountEmail): Promise<void>;
}
