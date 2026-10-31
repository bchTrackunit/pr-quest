import type { SDKModel } from '@cursor/sdk';
import { describe, expect, test, vi } from 'vitest';

import type { ApiKeyName } from '../shared/api.ts';
import { CLAUDE_FALLBACK_MODELS, CURSOR_FALLBACK_MODELS, ModelCatalog } from './models.ts';

const CURSOR_KEY = 'crsr_0123456789abcdef';
const ANTHROPIC_KEY = 'sk-ant-api03-0123456789abcdef';

function catalog(
  options: {
    keys?: Partial<Record<ApiKeyName, string>>;
    cursorModels?: Array<SDKModel> | Error;
    anthropic?: Response | Error;
  } = {},
) {
  const keys = options.keys ?? { cursor: CURSOR_KEY, anthropic: ANTHROPIC_KEY };
  const listCursorModels = vi.fn(async (_apiKey: string): Promise<Array<SDKModel>> => {
    const reply = options.cursorModels ?? [];
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  });
  const fetch = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
    const reply = options.anthropic ?? Response.json({ data: [] });
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  });
  const models = new ModelCatalog({ apiKey: (name) => keys[name], listCursorModels, fetch });
  return { models, listCursorModels, fetch };
}

describe('ModelCatalog for Cursor', () => {
  test('lists the models the Cursor key may use', async () => {
    const { models, listCursorModels } = catalog({
      cursorModels: [
        { id: 'composer-2', displayName: 'Composer 2' },
        { id: 'gpt-5.6', displayName: 'GPT-5.6', description: 'x' },
      ],
    });

    expect(await models.list('cursor')).toEqual({
      provider: 'cursor',
      source: 'api',
      models: [
        { id: 'composer-2', displayName: 'Composer 2' },
        { id: 'gpt-5.6', displayName: 'GPT-5.6' },
      ],
    });
    expect(listCursorModels).toHaveBeenCalledWith(CURSOR_KEY);
  });

  test('falls back to the built-in list without a key, and says why', async () => {
    const { models, listCursorModels } = catalog({ keys: {} });

    expect(await models.list('cursor')).toEqual({
      provider: 'cursor',
      source: 'fallback',
      models: CURSOR_FALLBACK_MODELS,
      error: expect.stringMatching(/Cursor API key/),
    });
    expect(listCursorModels).not.toHaveBeenCalled();
  });

  test('falls back when Cursor fails, without repeating the key', async () => {
    const { models } = catalog({ cursorModels: new Error(`unauthorized key ${CURSOR_KEY}`) });

    const response = await models.list('cursor');

    expect(response).toMatchObject({ source: 'fallback', models: CURSOR_FALLBACK_MODELS });
    expect(response.error).toContain('unauthorized key');
    expect(JSON.stringify(response)).not.toContain(CURSOR_KEY);
  });
});

describe('ModelCatalog for Claude', () => {
  test("lists Anthropic's models with the key in the x-api-key header", async () => {
    const { models, fetch } = catalog({
      anthropic: Response.json({
        data: [
          { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', type: 'model' },
          { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', type: 'model' },
        ],
        has_more: false,
      }),
    });

    expect(await models.list('claude')).toEqual({
      provider: 'claude',
      source: 'api',
      models: [
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
        { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
      ],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models\b/);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    });
  });

  test('falls back without an Anthropic key', async () => {
    const { models, fetch } = catalog({ keys: { cursor: CURSOR_KEY } });

    expect(await models.list('claude')).toEqual({
      provider: 'claude',
      source: 'fallback',
      models: CLAUDE_FALLBACK_MODELS,
      error: expect.stringMatching(/Anthropic API key/),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('falls back and says the key was rejected on a 401', async () => {
    const { models } = catalog({
      anthropic: Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        { status: 401 },
      ),
    });

    expect(await models.list('claude')).toMatchObject({
      source: 'fallback',
      models: CLAUDE_FALLBACK_MODELS,
      error: expect.stringMatching(/rejected the API key/),
    });
  });

  test('falls back when Anthropic cannot be reached or answers nonsense', async () => {
    const offline = catalog({ anthropic: new TypeError('fetch failed') });
    const nonsense = catalog({ anthropic: new Response('<html>', { status: 200 }) });

    expect(await offline.models.list('claude')).toMatchObject({
      source: 'fallback',
      error: expect.stringContaining('fetch failed'),
    });
    expect(await nonsense.models.list('claude')).toMatchObject({ source: 'fallback' });
  });
});
