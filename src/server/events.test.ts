import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '../shared/api.ts';
import { EventHub } from './events.ts';

class FakeResponse extends EventEmitter {
  public status?: number;
  public headers?: Record<string, string>;
  public chunks: Array<string> = [];
  public ended = false;

  public writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  public end(): this {
    this.ended = true;
    return this;
  }
}

function connect(target: EventHub): { req: EventEmitter; res: FakeResponse } {
  const req = new EventEmitter();
  const res = new FakeResponse();
  target.connect(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { req, res };
}

const event: ServerEvent = {
  type: 'questsUpdated',
  quests: [],
  fetchedAt: '2026-10-30T10:00:00.000Z',
  source: 'github',
  stale: false,
};

let hub: EventHub;

beforeEach(() => {
  vi.useFakeTimers();
  hub = new EventHub({ heartbeatMs: 1000 });
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
});

describe('EventHub', () => {
  test('opens an event stream that is never cached', () => {
    const { res } = connect(hub);

    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
    });
  });

  test('sends each event as one JSON data line to every client', () => {
    const first = connect(hub);
    const second = connect(hub);

    hub.broadcast(event);

    const message = `data: ${JSON.stringify(event)}\n\n`;
    expect(first.res.chunks).toContain(message);
    expect(second.res.chunks).toContain(message);
  });

  test('sends a heartbeat comment on an interval', () => {
    const { res } = connect(hub);

    vi.advanceTimersByTime(1000);

    expect(res.chunks).toContain(': heartbeat\n\n');
  });

  test('stops sending to a client once it disconnects', () => {
    const { req, res } = connect(hub);
    req.emit('close');

    hub.broadcast(event);

    expect(res.chunks.some((chunk) => chunk.startsWith('data:'))).toBe(false);
    expect(hub.clientCount).toBe(0);
  });

  test('can send a snapshot to just the new client', () => {
    const other = connect(hub);
    const req = new EventEmitter();
    const res = new FakeResponse();

    hub.connect(req as unknown as IncomingMessage, res as unknown as ServerResponse, [event]);

    expect(res.chunks).toContain(`data: ${JSON.stringify(event)}\n\n`);
    expect(other.res.chunks.some((chunk) => chunk.startsWith('data:'))).toBe(false);
  });

  test('close ends every stream', () => {
    const { res } = connect(hub);

    hub.close();

    expect(res.ended).toBe(true);
  });

  test('a stream that connects after close ends right away, so the client reconnects', () => {
    hub.close();

    const { res } = connect(hub);
    hub.broadcast(event);

    expect(res.ended).toBe(true);
    expect(res.chunks).toEqual(['retry: 3000\n\n']);
    expect(hub.clientCount).toBe(0);
  });
});
