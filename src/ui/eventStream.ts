import type { ServerEvent, ServerEventType } from '../shared/api.ts';
import type { ConnectionStatus } from './gameState.ts';

export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
}

export interface EventStreamOptions {
  url: string;
  onEvent: (event: ServerEvent) => void;
  /** `reconnected` is true when the stream opens after a drop, so callers can resync. */
  onStatusChange: (status: ConnectionStatus, reconnected: boolean) => void;
  createSource?: (url: string) => EventSourceLike;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const EVENT_TYPES: ReadonlyArray<ServerEventType> = [
  'questsUpdated',
  'runUpdated',
  'achievementUnlocked',
  'xpGained',
];

function isServerEventType(value: unknown): value is ServerEventType {
  return EVENT_TYPES.some((type) => type === value);
}

/** Parses one SSE `data:` payload; returns `undefined` for anything that is not a known event. */
export function parseServerEvent(data: string): ServerEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === 'object' &&
      parsed &&
      'type' in parsed &&
      isServerEventType(parsed.type)
    ) {
      // The server is the other half of this contract; payload fields are trusted.
      return parsed as ServerEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface EventStream {
  /** Closes the stream for good. */
  close: () => void;
  /**
   * Drops the current connection and opens a new one right away, skipping any backoff, e.g. after
   * the GitHub account changed and the old stream belongs to another player. The caller resyncs
   * itself, so the new open is not reported as a reconnect.
   */
  reconnectNow: () => void;
}

/**
 * Opens the event stream and keeps it open. The browser's built-in retry uses a fixed delay, so
 * on error the source is closed and reopened with exponential backoff instead.
 */
export function connectEventStream({
  url,
  onEvent,
  onStatusChange,
  createSource = (target) => new EventSource(target),
  initialDelayMs = 1000,
  maxDelayMs = 30_000,
}: EventStreamOptions): EventStream {
  let source: EventSourceLike | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let delay = initialDelayMs;
  let hasDropped = false;
  let closed = false;

  const open = (): void => {
    onStatusChange(hasDropped ? 'reconnecting' : 'connecting', false);
    const current = createSource(url);
    source = current;
    current.onopen = () => {
      delay = initialDelayMs;
      onStatusChange('open', hasDropped);
    };
    current.onmessage = (message) => {
      const event = parseServerEvent(message.data);
      if (event) {
        onEvent(event);
      }
    };
    current.onerror = () => {
      current.close();
      if (closed || source !== current) {
        return;
      }
      hasDropped = true;
      onStatusChange('reconnecting', false);
      retryTimer = setTimeout(open, delay);
      delay = Math.min(delay * 2, maxDelayMs);
    };
  };

  const stop = (): void => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    const current = source;
    source = undefined;
    current?.close();
  };

  open();

  return {
    close: () => {
      closed = true;
      stop();
    },
    reconnectNow: () => {
      if (closed) {
        return;
      }
      stop();
      delay = initialDelayMs;
      hasDropped = false;
      open();
    },
  };
}
