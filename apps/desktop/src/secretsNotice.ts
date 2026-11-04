import {
  type DesktopSecrets,
  ENCRYPTED_SECRETS_FILE,
  plaintextAllowedOn,
  type SecretsStorage,
} from './keychainSecrets.ts';

export const NOTICE_ACTIONS = [
  'continue',
  'retry',
  'keepInMemory',
  'savePlaintext',
  'startOver',
] as const;
export type NoticeAction = (typeof NOTICE_ACTIONS)[number];

/** A startup dialog about where saved keys go. The first button is the default. */
export interface SecretsNotice {
  message: string;
  detail: string;
  buttons: Array<{ label: string; action: NoticeAction }>;
}

/** How to get a working keychain on `platform`. */
function noKeychain(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'Unlock your login keychain in Keychain Access, and allow PR Quest to use it if macOS asks, then restart PR Quest.';
    case 'win32':
      return 'Make sure the Windows Credential Manager works for your account, then restart PR Quest.';
    case 'linux':
      return 'Install and unlock a keyring such as GNOME Keyring or KWallet, then restart PR Quest.';
    default:
      return 'Make sure the OS keychain is available, then restart PR Quest.';
  }
}

const RETRY_OR_CONTINUE: SecretsNotice['buttons'] = [
  { label: 'Try Again', action: 'retry' },
  { label: 'Continue Without Saved Keys', action: 'continue' },
];

/**
 * What to tell the player at startup about their saved keys, or `undefined` when there's nothing
 * to say. `plaintextChoice` is their earlier answer to saving keys unencrypted, if any.
 */
export function secretsNotice(
  storage: SecretsStorage,
  plaintextChoice: boolean | undefined,
  platform: NodeJS.Platform = process.platform,
): SecretsNotice | undefined {
  switch (storage) {
    case 'memory': {
      const plaintext = plaintextAllowedOn(platform);
      // Where saving them unencrypted isn't offered, an earlier choice to do so doesn't count.
      if (plaintextChoice === false || (plaintextChoice === true && plaintext)) {
        return undefined;
      }
      const message = "PR Quest can't use the OS keychain to encrypt your saved keys";
      return plaintext
        ? {
            message,
            detail: `Keys and the GitHub sign-in you save last only until you quit, unless you save them unencrypted in the state folder, where any program running as you can read them. ${noKeychain(platform)}`,
            buttons: [
              { label: 'Keep Them Until I Quit', action: 'keepInMemory' },
              { label: 'Save Them Unencrypted', action: 'savePlaintext' },
            ],
          }
        : {
            message,
            detail: `Keys and the GitHub sign-in you save last only until you quit. ${noKeychain(platform)}`,
            buttons: [{ label: 'Keep Them Until I Quit', action: 'keepInMemory' }],
          };
    }
    case 'locked':
      return {
        message: "Your saved keys are encrypted with the OS keychain, which isn't available",
        detail: `PR Quest starts without them, and keys you save now won't be saved. ${noKeychain(platform)}`,
        buttons: [{ label: 'Continue', action: 'continue' }],
      };
    case 'undecryptable':
      return {
        message: 'The file with your saved keys was changed or damaged',
        detail: `${ENCRYPTED_SECRETS_FILE} in the state folder names the OS keychain's data key, but doesn't decrypt with it. Restore it from a backup and restart PR Quest to get your keys back. If you continue, PR Quest starts without saved keys, and saving a key moves that file aside. Start Over moves it aside in the state folder and saves keys with the current data key.`,
        // Closing the dialog chooses the last button, which leaves the file alone.
        buttons: [
          { label: 'Start Over', action: 'startOver' },
          { label: 'Continue Without Saved Keys', action: 'continue' },
        ],
      };
    case 'wrongKey':
      return {
        message: 'Your saved keys were encrypted with a data key the OS keychain no longer has',
        detail: `The keychain entry com.prquest.desktop was deleted or replaced, as resetting the keychain or copying the state folder from another computer does. Restore that entry and restart PR Quest to get your keys back. If you continue, PR Quest leaves ${ENCRYPTED_SECRETS_FILE} alone, and keys you save last only until you quit. Start Over moves it aside in the state folder and saves keys with the current data key.`,
        // Closing the dialog chooses the last button, which leaves the file alone.
        buttons: [
          { label: 'Start Over', action: 'startOver' },
          { label: 'Continue Without Saved Keys', action: 'continue' },
        ],
      };
    case 'corrupt':
      return {
        message: 'The file with your saved keys is damaged',
        detail: `PR Quest can't read ${ENCRYPTED_SECRETS_FILE} in the state folder. Restore it from a backup and try again. If you continue, PR Quest starts without saved keys, and saving a key moves the damaged file aside in the state folder.`,
        buttons: RETRY_OR_CONTINUE,
      };
    case 'importFailed':
      return {
        message: "PR Quest couldn't move your keys from secrets.json into the OS keychain",
        detail:
          "The keychain didn't give back the keys PR Quest encrypted, so secrets.json and your encrypted keys are unchanged. Try again, or continue without saved keys; keys you save then last only until you quit.",
        buttons: RETRY_OR_CONTINUE,
      };
    default:
      return undefined;
  }
}

export interface OpenWithNoticesOptions {
  /** Opens the saved keys; `allowPlaintext` is whether they may be saved unencrypted. */
  open: (allowPlaintext: boolean) => Promise<DesktopSecrets>;
  /** Shows the notice and resolves the action of the button the player chose. */
  ask: (notice: SecretsNotice) => Promise<NoticeAction>;
  /** The player's earlier answer to saving keys unencrypted, if any. */
  plaintextChoice: boolean | undefined;
  /** Remembers the player's answer to saving keys unencrypted. */
  save: (plaintextChoice: boolean) => Promise<void>;
  /** Moves aside the encrypted keys the keychain's data key can't read, for Start Over. */
  startOver: () => Promise<void>;
  /** Whether to tell the player anything; off after a restart, which they already heard about. */
  notices?: boolean;
  /** The OS, `process.platform` unless a test says otherwise. */
  platform?: NodeJS.Platform;
}

/**
 * Opens the saved keys and tells the player when they can't be encrypted, saved or read, asking
 * once whether to save them unencrypted without a keychain.
 */
export async function openWithNotices(options: OpenWithNoticesOptions): Promise<DesktopSecrets> {
  const platform = options.platform ?? process.platform;
  let plaintextChoice = options.plaintextChoice;
  for (;;) {
    const opened = await options.open(plaintextChoice === true && plaintextAllowedOn(platform));
    const notice =
      options.notices === false
        ? undefined
        : secretsNotice(opened.storage, plaintextChoice, platform);
    if (!notice) {
      return opened;
    }
    const action = await options.ask(notice);
    if (action === 'retry') {
      continue;
    }
    if (action === 'startOver') {
      await options.startOver();
      continue;
    }
    if (action === 'keepInMemory' || action === 'savePlaintext') {
      plaintextChoice = action === 'savePlaintext';
      await options.save(plaintextChoice);
      if (plaintextChoice) {
        continue;
      }
    }
    return opened;
  }
}
