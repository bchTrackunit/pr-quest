import { ENCRYPTED_SECRETS_FILE, type SecretsStorage } from './keychainSecrets.ts';

export type NoticeAction = 'continue' | 'retry' | 'keepInMemory' | 'savePlaintext';

/** A startup dialog about where saved keys go. The first button is the default. */
export interface SecretsNotice {
  message: string;
  detail: string;
  buttons: Array<{ label: string; action: NoticeAction }>;
}

const NO_KEYCHAIN =
  'On Linux, install and unlock a keyring such as GNOME Keyring or KWallet, then restart PR Quest.';

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
): SecretsNotice | undefined {
  switch (storage) {
    case 'memory':
      return plaintextChoice === undefined
        ? {
            message: "PR Quest can't use the OS keychain to encrypt your saved keys",
            detail: `Keys and the GitHub sign-in you save last only until you quit, unless you save them unencrypted in the state folder, where any program running as you can read them. ${NO_KEYCHAIN}`,
            buttons: [
              { label: 'Keep Them Until I Quit', action: 'keepInMemory' },
              { label: 'Save Them Unencrypted', action: 'savePlaintext' },
            ],
          }
        : undefined;
    case 'locked':
      return {
        message: "Your saved keys are encrypted with the OS keychain, which isn't available",
        detail: `PR Quest starts without them, and keys you save now won't be saved. ${NO_KEYCHAIN}`,
        buttons: [{ label: 'Continue', action: 'continue' }],
      };
    case 'undecryptable':
      return {
        message: "The OS keychain couldn't decrypt your saved keys",
        detail:
          "This happens when keychain access was denied, or the keys were saved on another computer or account. Try again to allow access. If you continue, PR Quest starts without saved keys, and saving a key replaces the ones it couldn't decrypt.",
        buttons: RETRY_OR_CONTINUE,
      };
    case 'corrupt':
      return {
        message: 'The file with your saved keys is damaged',
        detail: `PR Quest can't read ${ENCRYPTED_SECRETS_FILE} in the state folder. Restore it from a backup and try again. If you continue, PR Quest starts without saved keys, and saving a key replaces the damaged file.`,
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
