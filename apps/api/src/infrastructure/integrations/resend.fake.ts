import type { EmailGateway, SendEmailInput } from '../../application/ports/email-gateway.js';
import { renderEmail, type RenderedEmail } from './email-templates.js';

export interface SentEmail extends SendEmailInput {
  rendered: RenderedEmail;
}

export class FakeEmailGateway implements EmailGateway {
  private readonly sent: SentEmail[] = [];

  async send(input: SendEmailInput): Promise<void> {
    this.sent.push({ ...input, rendered: renderEmail(input.kind, input.payload) });
    return Promise.resolve();
  }

  inboxOf(to: string): SentEmail[] {
    const target = to.toLowerCase();
    return this.sent.filter((email) => email.to.toLowerCase() === target);
  }

  all(): SentEmail[] {
    return [...this.sent];
  }

  clear(): void {
    this.sent.length = 0;
  }
}
