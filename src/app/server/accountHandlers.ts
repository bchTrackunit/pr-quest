import { z } from 'zod';

import {
  API_KEY_NAMES,
  type AuthStatusResponse,
  type GitHubAccount,
  type SettingsResponse,
} from '../../shared/api.ts';
import {
  type ApiKeys,
  type ModelCatalog,
  type SettingsStore,
  TimeZoneChangeTooSoon,
} from '../../features/settings/server/index.ts';
import type { DeviceFlow } from '../../features/auth/server/index.ts';
import { ApiError, type RouteHandlers } from '../../platform/server/router.ts';
import { canonicalTimeZone } from '../../platform/server/timeZone.ts';
import { ModelIdSchema, parseBody, parseOrReject } from '../../platform/server/validation.ts';

const MAX_KEY_LENGTH = 1000;

const ProviderSchema = z.enum(['cursor', 'claude'], {
  error: 'Must be "cursor" or "claude"',
});

const TimeZoneSchema = z
  .string({ error: 'Send the time zone as a string' })
  .max(100)
  .transform((value, context) => {
    const zone = canonicalTimeZone(value);
    if (zone === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Must be an IANA time zone such as Europe/Copenhagen',
      });
      return z.NEVER;
    }
    return zone;
  });

const UpdateSettingsSchema = z.strictObject(
  {
    reviewProvider: ProviderSchema.optional(),
    models: z.partialRecord(ProviderSchema, ModelIdSchema.nullable()).optional(),
    timeZone: TimeZoneSchema.nullable().optional(),
  },
  { error: 'Send a JSON object with reviewProvider, models and/or timeZone' },
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

/** Stands in where sign-in works another way: always idle, and starting it is refused. */
const NO_DEVICE_FLOW: NonNullable<AuthServices['deviceFlow']> = {
  start: async () => {
    throw new ApiError(409, 'missingConfig', "This server doesn't sign in with a device code");
  },
  status: () => ({ state: 'idle' }),
  cancel: () => undefined,
  acknowledgeComplete: () => undefined,
  isConfigured: () => false,
};

/** What the settings, API key and model routes act on: one storage scope's. */
export interface SettingsServices {
  apiKeys: Pick<ApiKeys, 'statuses' | 'set' | 'remove'>;
  settings: Pick<SettingsStore, 'get' | 'update'>;
  models: Pick<ModelCatalog, 'list'>;
  /**
   * How often a player may change their time zone, which moves the calendar their streaks and
   * daily achievements count by. Without it, as in local mode, any time.
   */
  timeZoneChanges?: { minIntervalMs: number; now?: () => Date };
}

/** What the sign-in routes act on. */
export interface AuthServices {
  /** Only local mode signs in by device code; without it, those routes say it isn't set up. */
  deviceFlow?: Pick<
    DeviceFlow,
    'start' | 'status' | 'cancel' | 'acknowledgeComplete' | 'isConfigured'
  >;
  auth: {
    /** The token owner, or why the token didn't resolve to one. */
    current: () => Promise<{ account?: GitHubAccount; error?: string }>;
    /** Forgets the OAuth token and the cached identity; names the OAuth account it signed out of. */
    signOut: () => Promise<{ signedOutLogin?: string }>;
  };
}

export interface AccountServices extends SettingsServices, AuthServices {}

/** Sign-in, settings, API key and model routes. None of them return or log a secret. */
export function createAccountHandlers(services: AccountServices): RouteHandlers {
  return { ...createAuthHandlers(services), ...createSettingsHandlers(services) };
}

/** The sign-in routes: who is signed in, the device flow and signing out. */
export function createAuthHandlers(services: AuthServices): RouteHandlers {
  const { auth } = services;
  const deviceFlow = services.deviceFlow ?? NO_DEVICE_FLOW;

  const authStatus = async (): Promise<AuthStatusResponse> => {
    const { account, error } = await auth.current();
    const device = deviceFlow.status();
    if (account) {
      deviceFlow.acknowledgeComplete();
    }
    return {
      clientIdConfigured: deviceFlow.isConfigured(),
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
  };
}

/** The settings, API key and model routes. */
export function createSettingsHandlers(services: SettingsServices): RouteHandlers {
  const { apiKeys, settings, models, timeZoneChanges } = services;

  const settingsResponse = (): SettingsResponse => {
    const current = settings.get();
    return {
      reviewProvider: current.reviewProvider,
      models: current.models,
      ...(current.timeZone ? { timeZone: current.timeZone } : {}),
      keys: apiKeys.statuses(),
    };
  };

  return {
    getSettings: settingsResponse,

    updateSettings: async ({ body }) => {
      const patch = parseOrReject(UpdateSettingsSchema, body, 'Invalid settings');
      try {
        await (timeZoneChanges
          ? settings.update(patch, {
              now: timeZoneChanges.now?.() ?? new Date(),
              minTimeZoneIntervalMs: timeZoneChanges.minIntervalMs,
            })
          : settings.update(patch));
      } catch (error) {
        if (error instanceof TimeZoneChangeTooSoon) {
          throw new ApiError(429, 'rateLimited', error.message);
        }
        throw error;
      }
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
