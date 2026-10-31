import { z } from 'zod';

import {
  API_KEY_NAMES,
  type AuthStatusResponse,
  type GitHubAccount,
  type SettingsResponse,
} from '../shared/api.ts';
import type { ApiKeys } from './apiKeys.ts';
import type { DeviceFlow } from './deviceFlow.ts';
import type { ModelCatalog } from './models.ts';
import type { RouteHandlers } from './router.ts';
import type { SettingsStore } from './settings.ts';
import { ModelIdSchema, parseBody, parseOrReject } from './validation.ts';

const MAX_KEY_LENGTH = 1000;

const ProviderSchema = z.enum(['cursor', 'claude'], {
  error: 'Must be "cursor" or "claude"',
});

const UpdateSettingsSchema = z.strictObject(
  {
    reviewProvider: ProviderSchema.optional(),
    models: z.partialRecord(ProviderSchema, ModelIdSchema.nullable()).optional(),
  },
  { error: 'Send a JSON object with reviewProvider and/or models' },
);

/** The value's content never appears in an error, only which rule it broke. */
const SetApiKeySchema = z.strictObject({
  value: z
    .string({ error: 'Send the key as a string' })
    .max(MAX_KEY_LENGTH, `An API key is at most ${MAX_KEY_LENGTH} characters`),
});

const KeyNameSchema = z.enum(API_KEY_NAMES, {
  error: `Key names are ${API_KEY_NAMES.join(', ')}`,
});

const EmptyBodySchema = z.strictObject({}, { error: 'This route takes no body' });

export interface AccountServices {
  apiKeys: Pick<ApiKeys, 'statuses' | 'set' | 'remove'>;
  settings: Pick<SettingsStore, 'get' | 'update'>;
  models: Pick<ModelCatalog, 'list'>;
  deviceFlow: Pick<DeviceFlow, 'start' | 'status' | 'cancel' | 'acknowledgeComplete'>;
  auth: {
    clientIdConfigured: boolean;
    /** The token owner, or why the token didn't resolve to one. */
    current: () => Promise<{ account?: GitHubAccount; error?: string }>;
    /** Forgets the OAuth token and the cached identity. */
    signOut: () => Promise<void>;
  };
}

/** Sign-in, settings, API key and model routes. None of them return or log a secret. */
export function createAccountHandlers(services: AccountServices): RouteHandlers {
  const { apiKeys, settings, models, deviceFlow, auth } = services;

  const settingsResponse = (): SettingsResponse => {
    const current = settings.get();
    return {
      reviewProvider: current.reviewProvider,
      models: current.models,
      keys: apiKeys.statuses(),
    };
  };

  const authStatus = async (): Promise<AuthStatusResponse> => {
    const { account, error } = await auth.current();
    const device = deviceFlow.status();
    if (account) {
      deviceFlow.acknowledgeComplete();
    }
    return {
      clientIdConfigured: auth.clientIdConfigured,
      ...(account ? { account } : {}),
      ...(error ? { error } : {}),
      device,
    };
  };

  return {
    authStatus,

    startDeviceFlow: async ({ body }) => {
      parseBody(EmptyBodySchema, body);
      return { device: await deviceFlow.start() };
    },

    getDeviceFlow: () => ({ device: deviceFlow.status() }),

    cancelDeviceFlow: ({ body }) => {
      parseBody(EmptyBodySchema, body);
      deviceFlow.cancel();
      return { device: deviceFlow.status() };
    },

    signOut: async ({ body }) => {
      parseBody(EmptyBodySchema, body);
      await auth.signOut();
      return authStatus();
    },

    getSettings: settingsResponse,

    updateSettings: async ({ body }) => {
      const patch = parseOrReject(UpdateSettingsSchema, body, 'Invalid settings');
      await settings.update(patch);
      return settingsResponse();
    },

    setApiKey: async ({ params, body }) => {
      const name = parseOrReject(KeyNameSchema, params.name, 'Unknown key');
      const { value } = parseOrReject(SetApiKeySchema, body, 'Send { "value": "<key>" }');
      await apiKeys.set(name, value);
      return settingsResponse();
    },

    removeApiKey: async ({ params, body }) => {
      const name = parseOrReject(KeyNameSchema, params.name, 'Unknown key');
      parseBody(EmptyBodySchema, body);
      await apiKeys.remove(name);
      return settingsResponse();
    },

    listModels: ({ req }) => {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      const provider = parseOrReject(ProviderSchema, query.get('provider'), 'Unknown provider');
      return models.list(provider);
    },
  };
}
