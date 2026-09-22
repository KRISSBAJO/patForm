import { createConnection, type Socket } from 'node:net';

/**
 * A very small Redis client, for §10.1's "Redis for bounded caching, rate
 * limits, distributed locks where necessary".
 *
 * Written rather than depended on for the same reason as the SMTP client and
 * the PDF writer: the surface actually needed is two commands, RESP has not
 * changed in a decade, and a client library brings a dependency tree into the
 * one part of the system that decides whether to refuse a request.
 *
 * What it does: connect, optional AUTH, pipelined INCR + EXPIRE, and a
 * reconnect on a dropped socket.
 *
 * What it does not: clustering, pub/sub, TLS, connection pooling, or any of
 * the fifty commands a cache would want. If this file ever needs a third
 * command it is probably time for a real client — the point of writing it was
 * that it did not.
 *
 * **It fails open.** A rate limiter that refuses every request when its
 * counter is unreachable has converted a cache outage into a total outage, and
 * the thing it was protecting against — a caller in a loop — is less harmful
 * than that. So an unreachable Redis falls back to the in-process counter and
 * says so once, rather than failing closed in silence.
 */

const CRLF = '\r\n';

export interface RedisLike {
  /** Increments a key and sets its expiry if it is new. Returns the count. */
  incrementWithExpiry(key: string, ttlSeconds: number): Promise<number>;
  close(): void;
  readonly connected: boolean;
}

class Resp {
  private socket: Socket | null = null;
  private buffer = '';
  private queue: { resolve: (v: string[]) => void; reject: (e: Error) => void; expect: number }[] = [];
  private failed = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password?: string,
  ) {}

  get connected(): boolean {
    return Boolean(this.socket) && !this.failed;
  }

  private async connect(): Promise<Socket> {
    if (this.socket && !this.failed) return this.socket;

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host: this.host, port: this.port });
      s.setNoDelay(true);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', () => this.drop());
    socket.on('close', () => this.drop());

    this.socket = socket;
    this.failed = false;

    if (this.password) {
      await this.send(['AUTH', this.password], 1);
    }
    return socket;
  }

  private drop(): void {
    this.failed = true;
    this.socket?.destroy();
    this.socket = null;
    for (const waiter of this.queue) waiter.reject(new Error('redis connection lost'));
    this.queue = [];
    this.buffer = '';
  }

  /**
   * Parses whole replies out of the buffer.
   *
   * Only the four types this needs: simple string, error, integer, and bulk
   * string. An array reply would mean a command this does not send.
   */
  private onData(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const end = this.buffer.indexOf(CRLF);
      if (end < 0) return;

      const line = this.buffer.slice(0, end);
      const type = line[0];

      if (type === '$') {
        const length = Number(line.slice(1));
        if (length === -1) {
          this.buffer = this.buffer.slice(end + 2);
          this.deliver('');
          continue;
        }
        const needed = end + 2 + length + 2;
        if (this.buffer.length < needed) return; // wait for the rest
        const value = this.buffer.slice(end + 2, end + 2 + length);
        this.buffer = this.buffer.slice(needed);
        this.deliver(value);
        continue;
      }

      this.buffer = this.buffer.slice(end + 2);
      if (type === '-') this.deliver(line.slice(1), true);
      else this.deliver(line.slice(1));
    }
  }

  private pending: string[] = [];

  private deliver(value: string, isError = false): void {
    const waiter = this.queue[0];
    if (!waiter) return;
    if (isError) {
      this.queue.shift();
      waiter.reject(new Error(value));
      this.pending = [];
      return;
    }
    this.pending.push(value);
    if (this.pending.length >= waiter.expect) {
      this.queue.shift();
      waiter.resolve(this.pending);
      this.pending = [];
    }
  }

  /** Sends one or more commands and waits for `expect` replies. */
  async send(...args: [string[], number] | [string[][], number]): Promise<string[]> {
    const [commands, expect] = args;
    const list = (Array.isArray(commands[0]) ? commands : [commands]) as string[][];
    const socket = await this.connect();

    const wire = list
      .map((cmd) => `*${cmd.length}${CRLF}${cmd.map((a) => `$${Buffer.byteLength(a)}${CRLF}${a}`).join(CRLF)}${CRLF}`)
      .join('');

    return new Promise<string[]>((resolve, reject) => {
      this.queue.push({ resolve, reject, expect });
      socket.write(wire, (err) => {
        if (err) {
          this.drop();
          reject(err);
        }
      });
      // A counter that never answers must not hold a request open.
      setTimeout(() => reject(new Error('redis timed out')), 2000).unref?.();
    });
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

export class RedisCounter implements RedisLike {
  private resp: Resp;
  private warned = false;

  constructor(url: string) {
    const parsed = new URL(url);
    this.resp = new Resp(parsed.hostname, Number(parsed.port || 6379), parsed.password || undefined);
  }

  get connected(): boolean {
    return this.resp.connected;
  }

  /**
   * INCR and EXPIRE, pipelined.
   *
   * Two commands in one round trip, and EXPIRE is unconditional rather than
   * `NX` because setting it on an existing key would extend the window. `EXPIRE
   * key ttl NX` only sets it when there is none, which is exactly the fixed
   * window this wants — a counter that never expires is a memory leak, and one
   * whose expiry keeps moving is a limit that never resets.
   */
  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    const replies = await this.resp.send([['INCR', key], ['EXPIRE', key, String(ttlSeconds), 'NX']], 2);
    return Number(replies[0]);
  }

  warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(message);
  }

  close(): void {
    this.resp.close();
  }
}

let shared: RedisCounter | null = null;

/** Null when REDIS_URL is not set, which is the ordinary single-process case. */
export function redis(): RedisCounter | null {
  if (!process.env.REDIS_URL) return null;
  shared ??= new RedisCounter(process.env.REDIS_URL);
  return shared;
}
