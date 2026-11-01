import type { BrowserWindow } from 'electron';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

interface Check {
  name: string;
  run: () => Promise<string>;
}

const BOGUS_KEY = 'pr-quest-smoke-test-invalid-key';
const UI_RENDER_WAIT_MS = 2000;

/**
 * Checks a packaged build: the UI renders from the bundled files, both SDKs load with their native
 * parts, and a call with a bogus key reaches the provider and fails authentication rather than
 * failing to load. Prints one line per check and resolves whether every check passed.
 */
export async function runSmokeTest(window: BrowserWindow, url: string): Promise<boolean> {
  const checks: Array<Check> = [
    {
      name: 'health',
      run: async () => {
        const res = await fetch(new URL('/api/health', url));
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        return `status ${res.status}`;
      },
    },
    {
      name: 'ui',
      run: async () => {
        const children: unknown = await window.webContents.executeJavaScript(
          `new Promise((resolve) => setTimeout(() => resolve(document.getElementById('root')?.childElementCount ?? 0), ${UI_RENDER_WAIT_MS}))`,
        );
        if (typeof children !== 'number' || children === 0) {
          throw new Error('the UI root rendered nothing');
        }
        return `"${window.webContents.getTitle()}" rendered`;
      },
    },
    {
      name: 'cursor-sdk',
      run: async () => {
        const { Agent, AuthenticationError, Cursor } = await import('@cursor/sdk');
        const models = await authFailure(
          Cursor.models.list({ apiKey: BOGUS_KEY }),
          AuthenticationError,
        );
        // Creating the agent is local; the first send is what reaches Cursor's cloud.
        const agent = await Agent.create({
          apiKey: BOGUS_KEY,
          name: 'PR Quest smoke test',
          cloud: {
            repos: [{ url: 'https://github.com/octocat/Hello-World' }],
            autoCreatePR: false,
            skipReviewerRequest: true,
          },
        });
        try {
          const send = await authFailure(agent.send('smoke test'), AuthenticationError);
          return `models.list: ${models}; cloud agent send: ${send}`;
        } finally {
          agent.close();
        }
      },
    },
    {
      name: 'cursor-sdk-natives',
      run: async () => {
        const require = createRequire(import.meta.url);
        const root = dirname(
          require.resolve(`@cursor/sdk-${process.platform}-${process.arch}/package.json`),
        );
        require(join(root, 'vendor', 'tree-sitter', 'index.js'));
        const sandbox = join(
          root,
          'bin',
          process.platform === 'win32' ? 'cursorsandbox.exe' : 'cursorsandbox',
        );
        // A program inside app.asar can't be started, so it has to be in the unpacked copy.
        const unpacked = sandbox.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
        accessSync(unpacked, constants.X_OK);
        return 'tree-sitter binding loaded; cursorsandbox is unpacked and executable';
      },
    },
    {
      name: 'anthropic-sdk',
      run: async () => {
        const { default: Anthropic, AuthenticationError } = await import('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey: BOGUS_KEY, maxRetries: 0 });
        return `models.list: ${await authFailure(client.models.list(), AuthenticationError)}`;
      },
    },
  ];

  let ok = true;
  for (const check of checks) {
    try {
      process.stdout.write(`[smoke] ok   ${check.name}: ${await check.run()}\n`);
    } catch (error) {
      ok = false;
      process.stdout.write(`[smoke] FAIL ${check.name}: ${describe(error)}\n`);
    }
  }
  return ok;
}

/** Resolves the message of the expected authentication error; anything else fails the check. */
async function authFailure(
  call: Promise<unknown>,
  expected: abstract new (...args: Array<never>) => Error,
): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof expected) {
      return `${error.name}: ${error.message}`;
    }
    throw new Error(`expected ${expected.name}, got ${describe(error)}`, { cause: error });
  }
  throw new Error('the call succeeded with a bogus key');
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
