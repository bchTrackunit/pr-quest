import type { ApiKeyName, ReviewProvider } from '../shared/api.ts';
import { ApiRequestError } from './apiClient.ts';

export type SettingsSection = 'github' | 'provider' | 'keys';

/** Where the settings popup opens, and which key to point at. */
export interface SettingsTarget {
  section: SettingsSection;
  key?: ApiKeyName;
}

export const REVIEW_PROVIDERS: ReadonlyArray<ReviewProvider> = ['cursor', 'claude'];

export const PROVIDER_LABELS: Record<ReviewProvider, string> = {
  cursor: 'Cursor',
  claude: 'Claude',
};

/** The API key each review provider needs. */
export const PROVIDER_KEYS: Record<ReviewProvider, ApiKeyName> = {
  cursor: 'cursor',
  claude: 'anthropic',
};

export const KEY_META: Record<ApiKeyName, { label: string; envName: string; purpose: string }> = {
  cursor: { label: 'Cursor', envName: 'CURSOR_API_KEY', purpose: 'Cursor reviews' },
  anthropic: {
    label: 'Claude (Anthropic)',
    envName: 'ANTHROPIC_API_KEY',
    purpose: 'Claude reviews',
  },
  linear: { label: 'Linear', envName: 'LINEAR_API_KEY', purpose: 'Linear review links' },
};

/** Settings that fix a failed request, or `undefined` when settings can't help. */
export function settingsTargetFor(reason: unknown): SettingsTarget | undefined {
  if (!(reason instanceof ApiRequestError) || reason.code !== 'missingConfig') {
    return undefined;
  }
  return reason.provider
    ? { section: 'keys', key: PROVIDER_KEYS[reason.provider] }
    : { section: 'keys' };
}
