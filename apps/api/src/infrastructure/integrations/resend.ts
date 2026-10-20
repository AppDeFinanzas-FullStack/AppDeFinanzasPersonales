import type { EmailGateway, SendEmailInput } from '../../application/ports/email-gateway.js';
import { renderEmail } from './email-templates.js';

const RESEND_URL = 'https://api.resend.com/emails';

export interface ResendEmailGatewayOptions {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}

export class ResendEmailGateway implements EmailGateway {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendEmailGatewayOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send({ to, kind, payload }: SendEmailInput): Promise<void> {
    const { subject, text, html } = renderEmail(kind, payload);
    const response = await this.fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.from, to: [to], subject, text, html }),
    });
    if (!response.ok) {
      throw new Error(`Email delivery failed with status ${response.status}`);
    }
  }
}
