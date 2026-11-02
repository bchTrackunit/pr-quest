import type { ApiKeyName, ApiKeyStatus } from '@pr-quest/contract/api';
import { ApiError } from '../../platform/router.ts';
import type { SecretStore } from '../../platform/secrets.ts';

const MAX_KEY_LENGTH = 1000;
/** Shorter keys show no characters at all, because four of them would be a large part. */
const MIN_LENGTH_FOR_LAST4 = 12;

export const API_KEY_ENV_NAMES: Record<ApiKeyName, string> = {
  cursor: 'CURSOR_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  linear: 'LINEAR_API_KEY',
};

export interface ApiKeysOptions {
  /** Keys from the environment or `.env.local`; they win over saved ones and can't be edited. */
  env: Partial<Record<ApiKeyName, string>>;
  secrets: Pick<SecretStore, 'get' | 'set' | 'delete'>;
  onChange?: (name: ApiKeyName) => void;
}

/** The Cursor, Anthropic and Linear keys: from the environment first, then from the settings. */
export class ApiKeys {
  private readonly env: Partial<Record<ApiKeyName, string>>;
  private readonly secrets: Pick<SecretStore, 'get' | 'set' | 'delete'>;
  private readonly onChange: (name: ApiKeyName) => void;

  public constructor(options: ApiKeysOptions) {
    this.env = options.env;
    this.secrets = options.secrets;
    this.onChange = options.onChange ?? (() => undefined);
  }

  public get(name: ApiKeyName): string | undefined {
    return this.env[name] ?? this.secrets.get(name);
  }

  public status(name: ApiKeyName): ApiKeyStatus {
    const fromEnv = this.env[name];
    const value = fromEnv ?? this.secrets.get(name);
    if (!value) {
      return { set: false };
    }
    const status: ApiKeyStatus = { set: true, source: fromEnv ? 'env' : 'settings' };
    if (value.length >= MIN_LENGTH_FOR_LAST4) {
      status.last4 = value.slice(-4);
    }
    return status;
  }

  public statuses(): Record<ApiKeyName, ApiKeyStatus> {
    return {
      cursor: this.status('cursor'),
      anthropic: this.status('anthropic'),
      linear: this.status('linear'),
    };
  }

  public async set(name: ApiKeyName, value: string): Promise<void> {
    this.assertEditable(name);
    const key = value.trim();
    if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
      throw new ApiError(
        400,
        'badRequest',
        `value: an API key is 1 to ${MAX_KEY_LENGTH} characters without spaces or line breaks`,
      );
    }
    await this.secrets.set(name, key);
    this.onChange(name);
  }

  public async remove(name: ApiKeyName): Promise<void> {
    this.assertEditable(name);
    await this.secrets.delete(name);
    this.onChange(name);
  }

  private assertEditable(name: ApiKeyName): void {
    if (this.env[name]) {
      throw new ApiError(
        409,
        'conflict',
        `${API_KEY_ENV_NAMES[name]} is set in the environment or .env.local. Change it there and restart PR Quest.`,
      );
    }
  }
}
