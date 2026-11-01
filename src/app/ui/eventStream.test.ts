import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '../../shared/api.ts';
import { connectEventStream, parseServerEvent } from './eventStream.ts';
import type { ConnectionStatus } from '../../features/game/ui/gameState.ts';
import { makeRun } from '../../platform/ui/test-utils/fixtures.ts';
import { MockEventSource } from './test-utils/MockEventSource.ts';

function connect() {
  const events: Array<ServerEvent> = [];
  const statuses: Array<[ConnectionStatus, boolean]> = [];
  const stream = connectEventStream({
    url: '/api/events',
    onEvent: (event) => events.push(event),
    onStatusChange: (status, reconnected) => statuses.push([status, reconnected]),
    createSource: (url) => new MockEventSource(url),
    initialDelayMs: 1000,
    maxDelayMs: 4000,
  });
  return { events, statuses, stream };
}

describe('parseServerEvent', () => {
  test('accepts known event types', () => {
    const event: ServerEvent = { type: 'runUpdated', run: makeRun() };
    expect(parseServerEvent(JSON.stringify(event))).toEqual(event);
  });

  test('ignores malformed JSON and unknown types', () => {
    expect(parseServerEvent('not json')).toBeUndefined();
    expect(parseServerEvent(JSON.stringify({ type: 'somethingElse' }))).toBeUndefined();
    expect(parseServerEvent('null')).toBeUndefined();
  });
});

describe('connectEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('forwards parsed events and reports the open connection', () => {
    const { events, statuses } = connect();
    const source = MockEventSource.latest();
    expect(source.url).toBe('/api/events');

    source.open();
    source.emit({ type: 'runUpdated', run: makeRun({ status: 'running' }) });
    source.emitRaw('garbage');

    expect(statuses).toEqual([
      ['connecting', false],
      ['open', false],
    ]);
    expect(events).toHaveLength(1);
  });

  test('reconnects with exponential backoff capped at the maximum delay', () => {
    connect();
    MockEventSource.latest().fail();
    expect(MockEventSource.instances.at(0)?.isClosed).toBe(true);

    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);

    MockEventSource.latest().fail();
    vi.advanceTimersByTime(2000);
    expect(MockEventSource.instances).toHaveLength(3);

    MockEventSource.latest().fail();
    vi.advanceTimersByTime(4000);
    expect(MockEventSource.instances).toHaveLength(4);

    MockEventSource.latest().fail();
    vi.advanceTimersByTime(3999);
    expect(MockEventSource.instances).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(5);
  });

  test('flags the first open after a drop as a reconnect and resets the backoff', () => {
    const { statuses } = connect();
    MockEventSource.latest().fail();
    vi.advanceTimersByTime(1000);
    MockEventSource.latest().open();

    expect(statuses.slice(-2)).toEqual([
      ['reconnecting', false],
      ['open', true],
    ]);

    MockEventSource.latest().fail();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(3);
  });

  test('stops reconnecting once closed', () => {
    const { stream } = connect();
    MockEventSource.latest().fail();
    stream.close();
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  test('reconnectNow skips the backoff and does not ask for a resync', () => {
    const { stream, statuses } = connect();
    for (let drop = 0; drop < 3; drop += 1) {
      MockEventSource.latest().fail();
      vi.advanceTimersByTime(4000);
    }
    MockEventSource.latest().fail();
    expect(MockEventSource.instances).toHaveLength(4);
    const waiting = MockEventSource.latest();

    stream.reconnectNow();

    expect(waiting.isClosed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(5);
    MockEventSource.latest().open();
    expect(statuses.slice(-2)).toEqual([
      ['connecting', false],
      ['open', false],
    ]);
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(5);

    MockEventSource.latest().fail();
    vi.advanceTimersByTime(1000);
    expect(MockEventSource.instances).toHaveLength(6);
  });

  test('reconnectNow does nothing once closed', () => {
    const { stream } = connect();
    stream.close();
    stream.reconnectNow();
    expect(MockEventSource.instances).toHaveLength(1);
  });
});
