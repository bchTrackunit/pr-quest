import { describe, expect, test, vi } from 'vitest';

import { LinearReviewClient } from './linear.ts';

const PAGE_ONE = {
  diffs: [
    {
      id: 'e2f9bdff',
      fullIdentifier: 'Trackunit/manager#26944',
      url: 'https://github.com/Trackunit/manager/pull/26944',
      appUrl: 'https://linear.app/trackunit/review/her-16-3969f7503317',
      needsAttention: true,
      diffStats: { fileCount: 21, additions: 2919, changes: 0, deletions: 20 },
    },
  ],
  hasNextPage: true,
  cursor: 'e2f9bdff',
};

const PAGE_TWO = {
  diffs: [
    {
      id: 'a1c9bce1',
      url: 'https://github.com/Trackunit/circleci-configuration/pull/930/',
      appUrl: 'https://linear.app/trackunit/review/chore-ebd9a2893861',
      needsAttention: false,
    },
  ],
  hasNextPage: false,
};

type JsonRpcRequest = { id?: number; method: string; params?: { arguments?: { cursor?: string } } };

function rpcResponse(id: number | undefined, result: unknown, sse = false): Response {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  return sse
    ? new Response(`event: message\ndata: ${body}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    : new Response(body, {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' },
      });
}

function toolResult(page: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(page) }] };
}

/** A fake Linear MCP endpoint serving two pages of pending reviews. */
function fakeLinear(options: { sse?: boolean } = {}) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
    if (request.method === 'initialize') {
      return rpcResponse(request.id, { protocolVersion: '2025-03-26', capabilities: {} });
    }
    if (request.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    const page = request.params?.arguments?.cursor ? PAGE_TWO : PAGE_ONE;
    return rpcResponse(request.id, toolResult(page), options.sse);
  });
}

const sentRequests = (fetchMock: ReturnType<typeof fakeLinear>): Array<JsonRpcRequest> =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as JsonRpcRequest);

describe('LinearReviewClient', () => {
  test('returns nothing and makes no request without an API key', async () => {
    const fetchMock = fakeLinear();
    const client = new LinearReviewClient({ fetch: fetchMock });

    await expect(client.getReviewInfo()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reads the key on each call, so a key saved in Settings is picked up', async () => {
    const fetchMock = fakeLinear();
    const saved: { key?: string } = {};
    const client = new LinearReviewClient({ apiKey: () => saved.key, fetch: fetchMock });
    await expect(client.getReviewInfo()).resolves.toBeUndefined();

    saved.key = 'lin_api_saved';
    await client.getReviewInfo();

    const toolHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(toolHeaders.get('authorization')).toBe('Bearer lin_api_saved');
  });

  test('maps pending reviews by normalized GitHub URL across pages', async () => {
    const client = new LinearReviewClient({ apiKey: 'lin_api_x', fetch: fakeLinear() });

    const info = await client.getReviewInfo();

    expect(info?.get('https://github.com/trackunit/manager/pull/26944')).toEqual({
      appUrl: 'https://linear.app/trackunit/review/her-16-3969f7503317',
      needsAttention: true,
    });
    expect(
      client.lookup(info, 'https://github.com/Trackunit/circleci-configuration/pull/930'),
    ).toEqual({
      appUrl: 'https://linear.app/trackunit/review/chore-ebd9a2893861',
      needsAttention: false,
    });
  });

  test('initializes a session and calls list_diffs for my pending reviews', async () => {
    const fetchMock = fakeLinear();
    await new LinearReviewClient({ apiKey: 'lin_api_x', fetch: fetchMock }).getReviewInfo();

    const requests = sentRequests(fetchMock);
    expect(requests.at(0)?.method).toBe('initialize');
    expect(requests.at(1)?.method).toBe('notifications/initialized');
    expect(requests.at(2)).toMatchObject({
      method: 'tools/call',
      params: { name: 'list_diffs', arguments: { reviewer: 'me', reviewState: 'pending' } },
    });
    const toolHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers);
    expect(toolHeaders.get('authorization')).toBe('Bearer lin_api_x');
    expect(toolHeaders.get('mcp-session-id')).toBe('session-1');
  });

  test('reads responses framed as server-sent events', async () => {
    const client = new LinearReviewClient({
      apiKey: 'lin_api_x',
      fetch: fakeLinear({ sse: true }),
    });

    const info = await client.getReviewInfo();

    expect(info?.size).toBe(2);
  });

  test('caches results for the TTL', async () => {
    let now = 0;
    const fetchMock = fakeLinear();
    const client = new LinearReviewClient({
      apiKey: 'k',
      fetch: fetchMock,
      now: () => now,
      ttlMs: 1000,
    });

    await client.getReviewInfo();
    const callsAfterFirst = fetchMock.mock.calls.length;
    now = 999;
    await client.getReviewInfo();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    now = 1000;
    await client.getReviewInfo();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test('degrades to nothing and warns once when Linear rejects the key', async () => {
    let now = 0;
    const onWarning = vi.fn();
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid_token"}', { status: 401 }));
    const client = new LinearReviewClient({
      apiKey: 'bad',
      fetch: fetchMock,
      now: () => now,
      ttlMs: 10,
      onWarning,
    });

    await expect(client.getReviewInfo()).resolves.toBeUndefined();
    now = 100;
    await expect(client.getReviewInfo()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('HTTP 401'));
  });

  test('degrades when the tool reports an error', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
      if (request.method === 'tools/call') {
        return rpcResponse(request.id, {
          isError: true,
          content: [{ type: 'text', text: 'nope' }],
        });
      }
      return rpcResponse(request.id, {});
    });
    const client = new LinearReviewClient({ apiKey: 'k', fetch: fetchMock, onWarning: vi.fn() });

    await expect(client.getReviewInfo()).resolves.toBeUndefined();
  });
});
