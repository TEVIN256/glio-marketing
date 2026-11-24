/**
 * Sending email. `Mailer` is what the report delivery needs; `ResendMailer`
 * is the production implementation over Resend's HTTP API (no SDK dependency).
 *
 * In production since 2026-11-22 (report emails delivered, message ids logged).
 * Request fields: from, to, subject, html, text, reply_to and optional headers
 * (List-Unsubscribe); `Idempotency-Key` header; the response carries `id`.
 */

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Same key = same email: lets a retried request not send twice. */
  idempotencyKey?: string;
  /** Extra mail headers, e.g. List-Unsubscribe (RFC 8058). */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(message: MailMessage): Promise<{ id: string }>;
}

export class MailError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) {
    super(message);
    this.name = "MailError";
  }
}

export type MailFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: MailFetch = globalThis.fetch as unknown as MailFetch,
  ) {
    if (!apiKey) throw new MailError("Resend API key is missing", "RESEND_NOT_CONFIGURED", false);
  }

  async send(m: MailMessage): Promise<{ id: string }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
    if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey.slice(0, 256);
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await this.fetchImpl(RESEND_EMAILS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: m.from, to: [m.to], subject: m.subject, html: m.html, text: m.text, reply_to: m.replyTo,
          ...(m.headers ? { headers: m.headers } : {}),
        }),
      });
    } catch {
      throw new MailError("Could not reach Resend", "RESEND_NETWORK", true);
    }
    if (res.status < 200 || res.status >= 300) {
      // The response body is not echoed: it could quote request details.
      throw new MailError(`Resend returned HTTP ${res.status}`, `RESEND_${res.status}`, res.status === 429 || res.status >= 500);
    }
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || typeof body.id !== "string" || !body.id) throw new MailError("Resend response had no message id", "RESEND_BAD_RESPONSE", false);
    return { id: body.id };
  }
}
