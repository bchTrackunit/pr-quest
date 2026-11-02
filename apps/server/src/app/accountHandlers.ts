import { z } from 'zod';

import {
  API_KEY_NAMES,
  type AuthStatusResponse,
  type GitHubAccount,
  type SettingsResponse,
} from '@pr-quest/contract/api';
import type { ApiKeys, ModelCatalog, SettingsStore } from '../features/settings/index.ts';
import type { DeviceFlow } from '../features/auth/index.ts';
import type { RouteHandlers } from '../platform/router.ts';
import { ModelIdSchema, parseBody, parseOrReject } from '../platform/validation.ts';

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
    /** Forgets the OAuth token and the cached identity; names the OAuth account it signed out of. */
    signOut: () => Promise<{ signedOutLogin?: string }>;
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
      const { signedOutLogin } = await auth.signOut();
      const status = await authStatus();
      const now = status.account;
      if (
        signedOutLogin &&
        now?.tokenSource === 'gh' &&
        now.login.toLowerCase() !== signedOutLogin.toLowerCase()
      ) {
        status.fellBackFrom = signedOutLogin;
      }
      return status;
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
