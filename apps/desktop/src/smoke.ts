/*
 * The checks of a packaged build that run in the sidecar: the server answers, both SDKs load with
 * their native parts, and a call with a bogus key reaches the provider and fails authentication
 * rather than failing to load. The shell checks the window itself; see src-tauri/src/smoke.rs.
 */
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface Check {
  name: string;
  run: () => Promise<string>;
}

const BOGUS_KEY = 'pr-quest-smoke-test-invalid-key';
const CHECK_TIMEOUT_MS = 30_000;

/** The server answers its health check, and nothing else without the request secret. */
export function serverChecks(url: string): Array<Check> {
  return [
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
      name: 'request-secret',
      run: async () => {
        const res = await fetch(new URL('/api/player', url));
        if (res.status !== 403) {
          throw new Error(`a request without the secret got ${res.status}`);
        }
        return 'a request without the secret is refused';
      },
    },
  ];
}

/** Both SDKs load with their native parts and reach their provider. */
export function sdkChecks(): Array<Check> {
  return [
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
        accessSync(sandbox, constants.X_OK);
        return 'tree-sitter binding loaded; cursorsandbox is executable';
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
}

/** Runs each check in turn, printing one line for each, and resolves whether all of them passed. */
export async function runChecks(
  checks: ReadonlyArray<Check>,
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<boolean> {
  let ok = true;
  for (const check of checks) {
    try {
      print(`[smoke] ok   ${check.name}: ${await withDeadline(check.run())}`);
    } catch (error) {
      ok = false;
      print(`[smoke] FAIL ${check.name}: ${describe(error)}`);
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

async function withDeadline(check: Promise<string>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer in ${CHECK_TIMEOUT_MS} ms`));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
