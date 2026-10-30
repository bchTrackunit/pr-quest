import { createServer } from 'node:http';
import { inspect } from 'node:util';

import { loadConfig } from './config.ts';
import { EventHub } from './events.ts';
import { GameService } from './game.ts';
import { runGh } from './gh.ts';
import { GitHubClient } from './github.ts';
import { createHandlers } from './handlers.ts';
import { LinearReviewClient } from './linear.ts';
import { QuestService } from './questService.ts';
import { ReviewRunService } from './reviewRuns.ts';
import { createRouter } from './router.ts';
import { StateStore } from './store.ts';

const info = (message: string): void => {
  process.stdout.write(`[pr-quest] ${message}\n`);
};
const warn = (message: string): void => {
  process.stderr.write(`[pr-quest] ${message}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await StateStore.open(config.stateDir, { onWarning: warn });
  const events = new EventHub();
  const game = new GameService(store, events);
  const github = new GitHubClient(runGh, { onWarning: warn });
  const linear = new LinearReviewClient({ apiKey: config.linearApiKey, onWarning: warn });
  const runs = new ReviewRunService({
    store,
    events,
    game,
    apiKey: config.cursorApiKey,
    log: info,
  });
  const quests = new QuestService({
    github,
    linear,
    events,
    game,
    activeRunIdFor: (questId) => runs.activeRunIdFor(questId),
    log: warn,
  });

  await runs.resumeInterrupted();

  const server = createServer(
    createRouter(createHandlers(config, { quests, runs, game, github, events }), {
      onUnexpectedError: (error) => {
        warn(`unexpected error ${inspect(error)}`);
      },
    }),
  );

  let stopPolling = (): void => undefined;
  server.listen(config.port, config.host, () => {
    info(`API listening on http://${config.host}:${config.port}`);
    info(`state in ${config.stateDir}`);
    stopPolling = quests.startPolling();
  });

  const shutdown = (): void => {
    stopPolling();
    events.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  warn(`failed to start: ${inspect(error)}`);
  process.exit(1);
});
