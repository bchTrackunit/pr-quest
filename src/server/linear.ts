import { z } from 'zod';

/** What Linear adds to a GitHub PR: its review page and whether it needs the player's attention. */
export interface LinearReviewInfo {
  appUrl?: string;
  needsAttention: boolean;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LinearReviewClientOptions {
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  onWarning?: (message: string) => void;
  endpoint?: string;
}

export const LINEAR_MCP_ENDPOINT = 'https://mcp.linear.app/mcp';
const DEFAULT_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const PROTOCOL_VERSION = '2025-03-26';

const JsonRpcResponseSchema = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const ToolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const DiffPageSchema = z.object({
  diffs: z.array(
    z.object({
      url: z.string(),
      appUrl: z.string().nullish(),
      needsAttention: z.boolean().nullish(),
    }),
  ),
  hasNextPage: z.boolean().optional(),
  cursor: z.string().nullish(),
});

type ReviewInfoMap = Map<string, LinearReviewInfo>;

/**
 * Optional enrichment from Linear's MCP server (`list_diffs`), which the public GraphQL API lacks.
 * Any failure degrades to `undefined` so quests still load from GitHub alone.
 */
export class LinearReviewClient {
  private readonly apiKey?: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly onWarning: (message: string) => void;
  private readonly endpoint: string;
  private cache?: { expiresAt: number; value: ReviewInfoMap | undefined };
  private inFlight?: Promise<ReviewInfoMap | undefined>;
  private warned = false;
  private nextId = 1;

  public constructor(options: LinearReviewClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.onWarning = options.onWarning ?? (() => undefined);
    this.endpoint = options.endpoint ?? LINEAR_MCP_ENDPOINT;
  }

  /** Pending reviews keyed by normalized GitHub PR URL, or `undefined` when Linear is unavailable. */
  public async getReviewInfo(): Promise<ReviewInfoMap | undefined> {
    if (!this.apiKey) {
      return undefined;
    }
    if (this.cache && this.now() < this.cache.expiresAt) {
      return this.cache.value;
    }
    this.inFlight ??= this.load(this.apiKey).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public lookup(info: ReviewInfoMap | undefined, githubUrl: string): LinearReviewInfo | undefined {
    return info?.get(normalizeGitHubUrl(githubUrl));
  }

  private async load(apiKey: string): Promise<ReviewInfoMap | undefined> {
    let value: ReviewInfoMap | undefined;
    try {
      value = await this.listPendingReviews(apiKey);
      this.warned = false;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        const reason = error instanceof Error ? error.message : String(error);
        this.onWarning(`Linear enrichment unavailable, using GitHub only: ${reason}`);
      }
    }
    this.cache = { expiresAt: this.now() + this.ttlMs, value };
    return value;
  }

  private async listPendingReviews(apiKey: string): Promise<ReviewInfoMap> {
    const initialized = await this.post(apiKey, undefined, {
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'pr-quest', version: '0.1.0' },
      },
    });
    const sessionId = initialized.sessionId;
    await this.post(
      apiKey,
      sessionId,
      { method: 'notifications/initialized' },
      { notification: true },
    );

    const info: ReviewInfoMap = new Map();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = {
        reviewer: 'me',
        reviewState: 'pending',
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      };
      const { result } = await this.post(apiKey, sessionId, {
        method: 'tools/call',
        params: { name: 'list_diffs', arguments: args },
      });
      const diffPage = parseDiffPage(result);
      for (const diff of diffPage.diffs) {
        info.set(normalizeGitHubUrl(diff.url), {
          appUrl: diff.appUrl ?? undefined,
          needsAttention: diff.needsAttention ?? false,
        });
      }
      if (!diffPage.hasNextPage || !diffPage.cursor) {
        break;
      }
      cursor = diffPage.cursor;
    }
    return info;
  }

  private async post(
    apiKey: string,
    sessionId: string | undefined,
    message: { method: string; params?: unknown },
    options: { notification?: boolean } = {},
  ): Promise<{ result: unknown; sessionId?: string }> {
    const id = options.notification ? undefined : this.nextId++;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), ...message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Linear MCP ${message.method} failed with HTTP ${response.status}`);
    }
    const nextSessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (id === undefined) {
      return { result: undefined, sessionId: nextSessionId };
    }
    const rpc = await readRpcResponse(response, id);
    if (rpc.error) {
      throw new Error(`Linear MCP ${message.method} failed: ${rpc.error.message}`);
    }
    return { result: rpc.result, sessionId: nextSessionId };
  }
}

async function readRpcResponse(
  response: Response,
  id: number,
): Promise<z.infer<typeof JsonRpcResponseSchema>> {
  const text = await response.text();
  const isEventStream = response.headers.get('content-type')?.includes('text/event-stream');
  const candidates = isEventStream
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
    : [text];
  for (const candidate of candidates) {
    const parsed = JsonRpcResponseSchema.safeParse(safeJson(candidate));
    if (parsed.success && parsed.data.id === id) {
      return parsed.data;
    }
  }
  throw new Error('Linear MCP returned no matching JSON-RPC response');
}

function parseDiffPage(result: unknown): z.infer<typeof DiffPageSchema> {
  const tool = ToolResultSchema.safeParse(result);
  if (!tool.success) {
    throw new Error('Linear list_diffs returned an unexpected result');
  }
  const text = tool.data.content.find((item) => item.type === 'text')?.text ?? '';
  if (tool.data.isError) {
    throw new Error(`Linear list_diffs failed: ${text.slice(0, 200)}`);
  }
  const page = DiffPageSchema.safeParse(safeJson(text));
  if (!page.success) {
    throw new Error('Linear list_diffs returned an unexpected payload');
  }
  return page.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function normalizeGitHubUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}
