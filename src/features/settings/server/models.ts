import { Cursor, type SDKModel } from '@cursor/sdk';
import { z } from 'zod';

import type {
  ApiKeyName,
  ListModelsResponse,
  ModelOption,
  ReviewProvider,
} from '../../../shared/api.ts';
import { ANTHROPIC_API_URL } from '../../../platform/server/config.ts';
import type { FetchLike } from '../../../platform/server/githubApi.ts';

const ANTHROPIC_MODELS_URL = `${ANTHROPIC_API_URL}/v1/models?limit=1000`;
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_LENGTH = 300;

/** Shown when Cursor can't be asked; Cursor picks its default model when none is chosen. */
export const CURSOR_FALLBACK_MODELS: ReadonlyArray<ModelOption> = [
  { id: 'composer-2', displayName: 'Composer 2' },
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { id: 'gpt-5.6', displayName: 'GPT-5.6' },
];

export const CLAUDE_FALLBACK_MODELS: ReadonlyArray<ModelOption> = [
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
];

const AnthropicModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional() })),
});

const KEY_NAMES: Record<ReviewProvider, ApiKeyName> = { cursor: 'cursor', claude: 'anthropic' };
const KEY_LABELS: Record<ReviewProvider, string> = {
  cursor: 'Cursor API key',
  claude: 'Anthropic API key',
};
const FALLBACKS: Record<ReviewProvider, ReadonlyArray<ModelOption>> = {
  cursor: CURSOR_FALLBACK_MODELS,
  claude: CLAUDE_FALLBACK_MODELS,
};

export interface ModelCatalogOptions {
  apiKey: (name: ApiKeyName) => string | undefined;
  listCursorModels?: (apiKey: string) => Promise<Array<SDKModel>>;
  fetch?: FetchLike;
}

/** The models each review provider offers, or a built-in list when the provider can't be asked. */
export class ModelCatalog {
  private readonly apiKey: (name: ApiKeyName) => string | undefined;
  private readonly listCursorModels: (apiKey: string) => Promise<Array<SDKModel>>;
  private readonly fetch: FetchLike;

  public constructor(options: ModelCatalogOptions) {
    this.apiKey = options.apiKey;
    this.listCursorModels =
      options.listCursorModels ?? ((apiKey) => Cursor.models.list({ apiKey }));
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  public async list(provider: ReviewProvider): Promise<ListModelsResponse> {
    const key = this.apiKey(KEY_NAMES[provider]);
    if (!key) {
      return fallback(provider, `no ${KEY_LABELS[provider]} yet`);
    }
    try {
      const models =
        provider === 'cursor' ? await this.cursorModels(key) : await this.claudeModels(key);
      return { provider, source: 'api', models };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error))
        .replaceAll(key, '***')
        .slice(0, MAX_ERROR_LENGTH);
      return fallback(provider, message);
    }
  }

  private async cursorModels(apiKey: string): Promise<Array<ModelOption>> {
    const models = await this.listCursorModels(apiKey);
    return models.map(({ id, displayName }) => ({ id, displayName }));
  }

  private async claudeModels(apiKey: string): Promise<Array<ModelOption>> {
    const response = await this.fetch(ANTHROPIC_MODELS_URL, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) {
      throw new Error('Anthropic rejected the API key');
    }
    if (!response.ok) {
      throw new Error(`Anthropic answered HTTP ${response.status}`);
    }
    const parsed = AnthropicModelsSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new Error('Anthropic sent an unexpected model list');
    }
    return parsed.data.data.map(({ id, display_name }) => ({
      id,
      displayName: display_name ?? id,
    }));
  }
}

function fallback(provider: ReviewProvider, error: string): ListModelsResponse {
  return { provider, source: 'fallback', models: [...FALLBACKS[provider]], error };
}
