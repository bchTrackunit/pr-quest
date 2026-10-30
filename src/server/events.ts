import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ServerEvent } from '../shared/api.ts';

const DEFAULT_HEARTBEAT_MS = 25_000;
const RECONNECT_DELAY_MS = 3000;

/** Fan-out of `ServerEvent`s to every open `GET /api/events` stream. */
export class EventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeatMs: number;
  private heartbeat?: NodeJS.Timeout;

  public constructor(options: { heartbeatMs?: number } = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  public get clientCount(): number {
    return this.clients.size;
  }

  /** Takes over the response and keeps it open; `snapshot` events go to this client only. */
  public connect(
    req: IncomingMessage,
    res: ServerResponse,
    snapshot: Array<ServerEvent> = [],
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${RECONNECT_DELAY_MS}\n\n`);
    snapshot.forEach((event) => res.write(format(event)));
    this.clients.add(res);
    this.ensureHeartbeat();

    const disconnect = (): void => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.stopHeartbeat();
      }
    };
    req.on('close', disconnect);
    res.on('error', disconnect);
  }

  public broadcast(event: ServerEvent): void {
    const message = format(event);
    this.clients.forEach((client) => client.write(message));
  }

  public close(): void {
    this.stopHeartbeat();
    this.clients.forEach((client) => client.end());
    this.clients.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => {
      this.clients.forEach((client) => client.write(': heartbeat\n\n'));
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

function format(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
