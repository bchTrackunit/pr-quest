import { z } from 'zod';

import type { ReviewRun, ServerEvent } from '../shared/api.ts';
import type { AppConfig } from './config.ts';
import type { EventHub } from './events.ts';
import type { GameService } from './game.ts';
import type { GitHubClient } from './github.ts';
import { GitHubApiError, NotSignedInError } from './githubApi.ts';
import { RateLimitedError, type QuestService } from './questService.ts';
import { parseQuestId, type QuestRef } from './quests.ts';
import type { ReviewDraft } from './reviewPayload.ts';
import type { ReviewRunService } from './reviewRuns.ts';
import { ApiError, type RouteHandlers } from './router.ts';
import { ModelIdSchema, parseBody } from './validation.ts';

const MAX_COMMENT_LENGTH = 65_536;

export interface AppServices {
  quests: QuestService;
  runs: ReviewRunService;
  game: GameService;
  github: Pick<GitHubClient, 'approve' | 'fetchHeadSha' | 'submitReview'>;
  events: EventHub;
}

const StartReviewSchema = z.object({ model: ModelIdSchema.optional() });

const ApproveSchema = z.object({
  confirm: z.literal(true, { error: 'Set confirm: true after the player confirms the approval' }),
  headSha: z
    .string({ error: 'Send the head commit the player saw' })
    .regex(/^[0-9a-f]{40}$/i, 'Must be a 40-character commit SHA')
    .transform((sha) => sha.toLowerCase()),
  body: z.string().max(MAX_COMMENT_LENGTH).optional(),
});

const PostReviewSchema = z.object({
  event: z.enum(['comment', 'requestChanges']).optional(),
  findingIndexes: z.array(z.number().int().nonnegative()).max(1000).optional(),
});

function requireQuestRef(id: string): QuestRef {
  const ref = parseQuestId(id);
  if (!ref) {
    throw new ApiError(400, 'badRequest', 'Quest ids look like <owner>/<repo>#<number>');
  }
  return ref;
}

/** Turns GitHub failures into 502s (503 when rate limited) so the UI can tell them from server bugs. */
async function upstream<TResult>(action: () => Promise<TResult>): Promise<TResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof RateLimitedError) {
      throw new ApiError(503, 'rateLimited', error.message);
    }
    if (error instanceof NotSignedInError) {
      throw new ApiError(401, 'notSignedIn', error.message);
    }
    if (error instanceof GitHubApiError && error.httpStatus === 401) {
      throw new ApiError(
        401,
        'notSignedIn',
        'GitHub rejected the sign-in (it may have been revoked). Sign in again in Settings.',
      );
    }
    if (error instanceof GitHubApiError) {
      throw new ApiError(502, 'upstreamFailed', error.message);
    }
    throw error;
  }
}

/** Route implementations. Without `services` only `health` exists; every other route responds 501. */
export function createHandlers(config: AppConfig, services?: AppServices): RouteHandlers {
  const health: RouteHandlers['health'] = () => ({
    ok: true,
    config: {
      linearApiKey: config.linearApiKey !== undefined,
      cursorApiKey: config.cursorApiKey !== undefined,
      anthropicApiKey: config.anthropicApiKey !== undefined,
    },
  });
  if (!services) {
    return { health };
  }
  const { quests, runs, game, github, events } = services;

  const findQuest = async (id: string) => {
    const quest = await upstream(() => quests.findOrRefresh(id));
    if (!quest) {
      throw new ApiError(404, 'notFound', `${id} is not in your review queue`);
    }
    return quest;
  };

  return {
    health,

    listQuests: ({ req }) => {
      const force = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === '1';
      return upstream(() => quests.list({ force }));
    },

    startReview: async ({ params, body }) => {
      requireQuestRef(params.id);
      const { model } = parseBody(StartReviewSchema, body);
      runs.assertReady();
      const quest = await findQuest(params.id);
      return { run: await runs.start(quest, { model }) };
    },

    approveQuest: async ({ params, body }) => {
      const ref = requireQuestRef(params.id);
      const request = parseBody(ApproveSchema, body);
      const quest = await findQuest(params.id);
      const currentHead = await upstream(() => github.fetchHeadSha(ref));
      if (currentHead !== request.headSha) {
        await quests.updateHeadSha(quest.id, currentHead);
        throw new ApiError(
          409,
          'headChanged',
          `New commits were pushed to ${quest.id} (now at ${currentHead.slice(0, 7)}). Re-check them before approving.`,
        );
      }
      const comment = request.body?.trim();
      await upstream(() =>
        github.approve(
          ref,
          comment ? { commitId: currentHead, body: comment } : { commitId: currentHead },
        ),
      );
      const outcome = await game.recordReviewAction({
        kind: 'approved',
        questId: quest.id,
        difficulty: quest.difficulty,
        requestKind: quest.requestKind,
        requestedAt: quest.requestedAt,
      });
      await quests.markActedOn(quest.id);
      return { questId: quest.id, approvedVia: 'github', outcome };
    },

    listRuns: () => ({ runs: runs.list() }),

    getRun: ({ params }) => {
      const stored = runs.get(params.id);
      if (!stored) {
        throw new ApiError(404, 'notFound', `No review run ${params.id}`);
      }
      return { run: stored.run };
    },

    postRun: async ({ params, body }) => {
      const request = parseBody(PostReviewSchema, body);
      const { stored, release } = runs.claimForPosting(params.id);
      try {
        const draft = buildDraft(stored.run, stored.quest.headSha, request);
        const ref = requireQuestRef(stored.quest.id);
        const submitted = await upstream(() => github.submitReview(ref, draft));
        const run = await runs.markPosted(stored.run.id, submitted.url);
        const outcome = await game.recordReviewAction({
          kind: draft.event === 'requestChanges' ? 'changesRequested' : 'reviewPosted',
          questId: stored.quest.id,
          difficulty: stored.quest.difficulty,
          requestKind: stored.quest.requestKind,
          requestedAt: stored.quest.requestedAt,
        });
        await quests.markActedOn(stored.quest.id);
        return { run, reviewUrl: submitted.url, outcome };
      } finally {
        release();
      }
    },

    discardRun: async ({ params }) => ({ run: await runs.discard(params.id) }),

    getPlayer: () => ({ player: game.player() }),

    listAchievements: () => ({ achievements: game.achievements() }),

    events: ({ req, res }) => {
      const snapshot: Array<ServerEvent> = [];
      const questsEvent = quests.snapshotEvent();
      if (questsEvent) {
        snapshot.push(questsEvent);
      }
      events.connect(req, res, snapshot);
    },
  };
}

function buildDraft(
  run: ReviewRun,
  headSha: string | undefined,
  request: z.infer<typeof PostReviewSchema>,
): ReviewDraft {
  const { result } = run;
  if (!result) {
    throw new ApiError(409, 'conflict', 'This review has no result to post');
  }
  const indexes = request.findingIndexes
    ? [...new Set(request.findingIndexes)].sort((a, b) => a - b)
    : undefined;
  const outOfRange = indexes?.find((index) => index >= result.findings.length);
  if (outOfRange !== undefined) {
    throw new ApiError(400, 'badRequest', `findingIndexes: ${outOfRange} is out of range`);
  }
  const findings = indexes
    ? indexes.flatMap((index) => result.findings[index] ?? [])
    : result.findings;
  const draft: ReviewDraft = {
    event: request.event ?? 'comment',
    summary: result.summary,
    verdict: result.verdict,
    findings,
    provider: run.provider,
  };
  if (run.model) {
    draft.model = run.model;
  }
  if (result.omitted && result.omitted.length > 0) {
    draft.omitted = result.omitted;
  }
  if (headSha) {
    draft.commitId = headSha;
  }
  return draft;
}
