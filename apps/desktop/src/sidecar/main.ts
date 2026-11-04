/*
 * The PR Quest server as a sidecar of the Tauri shell in src-tauri/, which has no Node of its own.
 * The shell starts it with the Node binary it bundles; protocol.ts says how the two talk.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  type AppConfig,
  BOOTSTRAP_PATH,
  loadConfig,
  type RunningServer,
} from '@pr-quest/server/server';
import { startDesktopServer } from '../desktopServer.ts';
import {
  type DesktopSecrets,
  ENCRYPTED_SECRETS_FILE,
  openDesktopSecrets,
  setAsideEncryptedSecrets,
} from '../keychainSecrets.ts';
import { readPreferences, writePreferences } from '../preferences.ts';
import { type NoticeAction, openWithNotices, type SecretsNotice } from '../secretsNotice.ts';
import { type Check, runChecks, sdkChecks, serverChecks } from '../smoke.ts';
import { dataKeyEncryptor } from './dataKeyEncryptor.ts';
import { ownProcessGroup } from './processGroup.ts';
import {
  bootstrapLine,
  exitAfterPrinting,
  fatalLine,
  type Launch,
  noticeLine,
  parseCommand,
  parseLaunch,
  readyLine,
  SMOKE_DONE_PREFIX,
  takeStdoutForProtocol,
} from './protocol.ts';

const protocol = takeStdoutForProtocol();
const group = ownProcessGroup();
/** Ends the stdin loop, which stops the server as closing stdin does. */
let stopReading = (): void => undefined;
// Linux sends SIGTERM when the shell dies (see `isolate` in src-tauri/src/sidecar.rs). Stopping the
// rest of the group sends this process one too, which it ignores.
process.on('SIGTERM', () => {
  if (!group?.signalledItself()) {
    stopReading();
  }
});

/** How long stopping waits for the server to close before it gives up on a stuck connection. */
const CLOSE_TIMEOUT_MS = 5000;
/** dist/ and node_modules/ sit next to this bundle in the app's resources. */
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const smokeTest = process.env.PR_QUEST_SMOKE_TEST === '1';

const info = (message: string): void => {
  process.stderr.write(`[pr-quest] ${message}\n`);
};
const warn = (message: string): void => {
  process.stderr.write(`[pr-quest] warning: ${message}\n`);
};
const print = (line: string): void => {
  protocol.write(`${line}\n`);
};

interface Started {
  config: AppConfig;
  server: RunningServer;
  secrets: DesktopSecrets;
}

/** The lines the shell writes to stdin, in order; `undefined` once it closed stdin. */
type NextLine = () => Promise<string | undefined>;

async function main(): Promise<void> {
  if (smokeTest && process.env.PR_QUEST_STATE_DIR === undefined) {
    throw new Error('The smoke test needs PR_QUEST_STATE_DIR, so it leaves ~/.pr-quest alone');
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  stopReading = () => input.close();
  const lines = input[Symbol.asyncIterator]();
  const next: NextLine = async () => {
    const line = await lines.next();
    return line.done === true ? undefined : line.value;
  };
  let started: Started | undefined;
  try {
    const first = await next();
    if (first === undefined) {
      return;
    }
    const launch = parseLaunch(first);
    started = await start(launch, next);
    print(readyLine({ port: started.server.port, storage: started.secrets.storage }));
    // Ends when stdin closes, which is how the shell stops the sidecar, and what happens if it dies.
    for (let line = await next(); line !== undefined; line = await next()) {
      const command = parseCommand(line)?.command;
      const code = command === 'rebootstrap' ? started.server.issueBootstrapCode?.() : undefined;
      if (code !== undefined) {
        print(bootstrapLine(code));
      }
      if (smokeTest && command === 'smoke') {
        const ok = await runChecks(
          [...serverChecks(started.server.url), ...sidecarChecks(started, launch), ...sdkChecks()],
          print,
        );
        print(`${SMOKE_DONE_PREFIX}${JSON.stringify({ ok })}`);
      }
    }
  } finally {
    if (started) {
      await Promise.race([started.server.close(), delay(CLOSE_TIMEOUT_MS)]);
    }
  }
}

async function start(launch: Launch, next: NextLine): Promise<Started> {
  // State stays in ~/.pr-quest (or PR_QUEST_STATE_DIR), shared with the CLI.
  const config = loadConfig({ onWarning: warn });
  const preferences = await readPreferences(launch.preferencesFile);
  const secrets = await openWithNotices({
    open: (allowPlaintext) =>
      openDesktopSecrets(config.stateDir, {
        encryptor: encryptorFor(launch),
        allowPlaintext,
        info,
        warn,
      }),
    ask: (notice) => ask(notice, next),
    plaintextChoice: preferences.plaintextSecrets,
    save: async (plaintextChoice) => {
      preferences.plaintextSecrets = plaintextChoice;
      await writePreferences(launch.preferencesFile, preferences);
    },
    startOver: async () => {
      const name = await setAsideEncryptedSecrets(config.stateDir);
      if (name !== undefined) {
        info(`Moved the keys the keychain's data key can't read aside to ${name}`);
      }
    },
    // Nobody answers in a test run.
    notices: launch.showNotices && !smokeTest,
  });
  const server = await startDesktopServer(config, preferences.port, {
    secrets: secrets.store,
    staticDir: join(APP_DIR, 'dist'),
    requestSecret: launch.requestSecret,
    bootstrapCode: launch.bootstrapCode,
    info,
    warn,
  });
  preferences.port = server.port;
  await writePreferences(launch.preferencesFile, preferences);
  return { config, server, secrets };
}

/** Has the shell show `notice` and waits for the button the player chose. */
async function ask(notice: SecretsNotice, next: NextLine): Promise<NoticeAction> {
  print(noticeLine(notice));
  for (let line = await next(); line !== undefined; line = await next()) {
    const command = parseCommand(line);
    if (command?.command === 'notice') {
      return command.action;
    }
  }
  throw new Error('The shell closed before answering');
}

function encryptorFor(launch: Launch) {
  return launch.dataKey === null
    ? undefined
    : dataKeyEncryptor(Buffer.from(launch.dataKey, 'base64'));
}

/** What only the Tauri build has: the one-time bootstrap link and the keychain's data key. */
function sidecarChecks({ config, server, secrets }: Started, launch: Launch): Array<Check> {
  return [
    {
      name: 'bootstrap-once',
      run: async () => {
        // The window opened the link before the shell asked for the smoke test.
        const res = await fetch(`${server.url}${BOOTSTRAP_PATH}?code=${launch.bootstrapCode}`, {
          redirect: 'manual',
        });
        if (res.status !== 403) {
          throw new Error(`opening the start-up link again got ${res.status}`);
        }
        return 'the start-up link worked once, for the window';
      },
    },
    {
      name: 'secrets-data-key',
      run: async () => {
        const value = 'pr-quest-smoke-test-saved-key';
        // A runner without a keychain (desktop-smoke --no-keychain) still keeps keys off disk.
        if (process.env.PR_QUEST_SMOKE_NO_KEYCHAIN && secrets.storage === 'memory') {
          await secrets.store.set('linear', value);
          const written = (await readdir(config.stateDir)).filter((name) =>
            name.startsWith('secrets.'),
          );
          await secrets.store.delete('linear');
          if (written.length > 0) {
            throw new Error(`a key saved without a keychain reached ${written.join(', ')}`);
          }
          return 'no keychain: a saved key stays in memory and nothing reaches the state folder';
        }
        if (secrets.storage !== 'keychain') {
          throw new Error(`saved keys go to ${secrets.storage}, not the keychain's data key`);
        }
        await secrets.store.set('linear', value);
        const file = await readFile(join(config.stateDir, ENCRYPTED_SECRETS_FILE), 'utf8');
        const reopened = await openDesktopSecrets(config.stateDir, {
          encryptor: encryptorFor(launch),
          allowPlaintext: false,
          info,
          warn,
        });
        await secrets.store.delete('linear');
        if (file.includes(value) || reopened.store.get('linear') !== value) {
          throw new Error(`${ENCRYPTED_SECRETS_FILE} didn't hold the key encrypted`);
        }
        return `a saved key is AES-GCM encrypted in ${ENCRYPTED_SECRETS_FILE} and reads back`;
      },
    },
  ];
}

// What the server started would otherwise outlive it when the shell was killed.
main().then(
  () => {
    group?.stopOthers();
    process.exit(0);
  },
  (error: unknown) => {
    group?.stopOthers();
    // Only the message: nothing here may print the launch message, which holds the secrets.
    const message = error instanceof Error ? error.message : String(error);
    warn(`stopped: ${message}`);
    exitAfterPrinting(fatalLine(message), 1, protocol);
  },
);
