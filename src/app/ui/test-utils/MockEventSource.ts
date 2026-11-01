import type { ServerEvent } from '../../../shared/api.ts';
import type { EventSourceLike } from '../eventStream.ts';

/** A controllable stand-in for the browser's `EventSource`. */
export class MockEventSource implements EventSourceLike {
  public static instances: Array<MockEventSource> = [];

  public readonly url: string;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public isClosed = false;

  public constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  public static latest(): MockEventSource {
    const latest = MockEventSource.instances.at(-1);
    if (!latest) {
      throw new Error('No EventSource was created');
    }
    return latest;
  }

  public static reset(): void {
    MockEventSource.instances = [];
  }

  public close(): void {
    this.isClosed = true;
  }

  public open(): void {
    this.onopen?.(new Event('open'));
  }

  public fail(): void {
    this.onerror?.(new Event('error'));
  }

  public emit(event: ServerEvent): void {
    this.emitRaw(JSON.stringify(event));
  }

  public emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}
