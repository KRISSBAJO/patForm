import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { Attachment, DeliveryResult, EmailProvider, OutgoingEmail } from './email.js';

/**
 * A small SMTP client.
 *
 * Written rather than pulled in because the surface actually needed is narrow
 * — EHLO, STARTTLS, AUTH, one message, QUIT — and a mail library brings a
 * dependency tree into the one part of the system that talks to the outside
 * world. The protocol has not changed since RFC 5321.
 *
 * What it does: STARTTLS on a plain port, implicit TLS when `secure`, AUTH
 * LOGIN and AUTH PLAIN, multipart/mixed with base64 attachments, dot-stuffing,
 * and CRLF line endings everywhere the protocol demands them.
 *
 * What it does not: connection pooling, pipelining, DSN, 8BITMIME negotiation,
 * or inline images. A high-volume sender wants a provider, which is why the
 * providers exist beside this.
 */

const CRLF = '\r\n';

interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** True for implicit TLS (465). False starts plain and upgrades with STARTTLS. */
  secure: boolean;
}

class SmtpSession {
  private socket: Socket | TLSSocket;
  private buffer = '';
  private waiting: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      // A reply ends with a line whose fourth character is a space rather
      // than a hyphen; hyphens mean more lines follow.
      const lines = this.buffer.split(CRLF).filter(Boolean);
      const last = lines.at(-1);
      if (!last || !/^\d{3} /.test(last)) return;
      const reply = this.buffer;
      this.buffer = '';
      this.waiting?.resolve(reply);
      this.waiting = null;
    });
    this.socket.on('error', (err) => {
      this.waiting?.reject(err);
      this.waiting = null;
    });
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** Sends a command and returns the reply, throwing on anything but the expected code. */
  async command(line: string, expect: number[]): Promise<string> {
    const pending = this.read();
    this.socket.write(line + CRLF);
    const reply = await pending;
    const code = Number(reply.slice(0, 3));
    if (!expect.includes(code)) {
      const err = new Error(`SMTP ${code}: ${reply.trim()}`) as Error & { smtpCode: number };
      err.smtpCode = code;
      throw err;
    }
    return reply;
  }

  async upgrade(host: string): Promise<void> {
    const plain = this.socket as Socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    this.socket = tlsConnect({ socket: plain, servername: host });
    await new Promise<void>((resolve, reject) => {
      this.socket.once('secureConnect', () => resolve());
      this.socket.once('error', reject);
    });
    this.attach();
  }

  end(): void {
    this.socket.end();
  }
}

function connectSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : createConnection({ host: config.host, port: config.port });
    const event = config.secure ? 'secureConnect' : 'connect';
    socket.once(event, () => resolve(socket));
    socket.once('error', reject);
  });
}

/** RFC 2047 for anything outside ASCII, so a subject with an accent survives. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(buffer: Buffer): string {
  return (buffer.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
}

/** Builds the MIME message. Multipart only when there is something to attach. */
export function buildMime(email: OutgoingEmail, messageId: string): string {
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to.join(', ')}`,
    email.cc?.length ? `Cc: ${email.cc.join(', ')}` : null,
    email.replyTo ? `Reply-To: ${email.replyTo}` : null,
    `Subject: ${encodeHeader(email.subject)}`,
    `Message-ID: <${messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ].filter(Boolean) as string[];

  const attachments = email.attachments ?? [];

  if (!attachments.length && !email.html) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join(CRLF)}${CRLF}${CRLF}${base64Lines(Buffer.from(email.text, 'utf8'))}`;
  }

  const boundary = `----patform_${randomBytes(12).toString('hex')}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];

  const body = email.html
    ? [
        `Content-Type: text/html; charset=utf-8`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(Buffer.from(email.html, 'utf8')),
      ]
    : [
        `Content-Type: text/plain; charset=utf-8`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(Buffer.from(email.text, 'utf8')),
      ];
  parts.push(`--${boundary}${CRLF}${body.join(CRLF)}`);

  for (const file of attachments as Attachment[]) {
    parts.push(
      `--${boundary}${CRLF}` +
        [
          `Content-Type: ${file.contentType}; name="${file.filename}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${file.filename}"`,
          '',
          base64Lines(file.content),
        ].join(CRLF),
    );
  }

  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}${CRLF}--${boundary}--`;
}

/** A leading dot on a line ends the DATA block, so it has to be doubled. */
function dotStuff(message: string): string {
  return message.replace(/\r\n\./g, `${CRLF}..`).replace(/^\./, '..');
}

function address(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return match ? match[1]! : value.trim();
}

export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';

  constructor(private readonly config: SmtpConfig) {}

  async send(email: OutgoingEmail): Promise<DeliveryResult> {
    const messageId = `${email.idempotencyKey}.${randomBytes(8).toString('hex')}@patform`;
    let session: SmtpSession | null = null;

    try {
      session = new SmtpSession(await connectSocket(this.config));
      await session.read(); // the 220 greeting

      const hostname = 'patform';
      let ehlo = await session.command(`EHLO ${hostname}`, [250]);

      if (!this.config.secure && /STARTTLS/i.test(ehlo)) {
        await session.command('STARTTLS', [220]);
        await session.upgrade(this.config.host);
        ehlo = await session.command(`EHLO ${hostname}`, [250]);
      }

      if (this.config.user && this.config.password) {
        if (/AUTH[^\r\n]*PLAIN/i.test(ehlo)) {
          const token = Buffer.from(`\0${this.config.user}\0${this.config.password}`, 'utf8').toString('base64');
          await session.command(`AUTH PLAIN ${token}`, [235]);
        } else {
          await session.command('AUTH LOGIN', [334]);
          await session.command(Buffer.from(this.config.user, 'utf8').toString('base64'), [334]);
          await session.command(Buffer.from(this.config.password, 'utf8').toString('base64'), [235]);
        }
      }

      await session.command(`MAIL FROM:<${address(email.from)}>`, [250]);
      for (const to of [...email.to, ...(email.cc ?? [])]) {
        await session.command(`RCPT TO:<${address(to)}>`, [250, 251]);
      }

      await session.command('DATA', [354]);
      const reply = await session.command(`${dotStuff(buildMime(email, messageId))}${CRLF}.`, [250]);
      await session.command('QUIT', [221]).catch(() => {});

      return { providerMessageId: messageId, status: 'sent', detail: reply.trim().slice(0, 120) };
    } catch (err) {
      const code = (err as { smtpCode?: number }).smtpCode;
      return {
        providerMessageId: null,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        // 4xx is a temporary refusal in SMTP; 5xx is permanent. A transport
        // error with no code at all is worth another attempt.
        retryable: code === undefined || (code >= 400 && code < 500),
      };
    } finally {
      session?.end();
    }
  }
}

export function smtpFromEnv(): SmtpProvider {
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error('EMAIL_PROVIDER=smtp but SMTP_HOST is not set');
  return new SmtpProvider({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER || undefined,
    password: process.env.SMTP_PASSWORD || undefined,
    secure: process.env.SMTP_SECURE === 'true',
  });
}
