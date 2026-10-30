import { z } from 'zod';

import type { Quest, RepoRef } from '../shared/api.ts';
import { GhError, type GhRunner } from './gh.ts';
import type { LinearReviewInfo } from './linear.ts';
import { difficultyFor, formatQuestId, type QuestRef } from './quests.ts';
import { renderReview, type ReviewDraft } from './reviewPayload.ts';

const SEARCH_FIELDS = 'number,title,url,repository,author,createdAt,updatedAt,isDraft';
const VIEW_FIELDS =
  'headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,reviewRequests,createdAt,url,title,author,isDraft';
const SEARCH_LIMIT = '100';
const VIEW_CONCURRENCY = 4;

const SearchItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  author: z.object({ login: z.string() }).nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
});

const DirectSearchSchema = z.array(z.object({ url: z.string() }));

const PullRequestDetailsSchema = z.object({
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  author: z.object({ login: z.string(), name: z.string().nullish() }).nullish(),
  reviewRequests: z.array(z.object({ __typename: z.string(), slug: z.string().nullish() })),
});

const CreatedReviewSchema = z.object({ html_url: z.string() });

export interface SearchItem {
  number: number;
  title: string;
  url: string;
  repo: RepoRef;
  authorLogin?: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
}

export interface PullRequestDetails {
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  authorName?: string;
  /** Team slugs without the org prefix, e.g. `team-gluon`. */
  requestedTeams: Array<string>;
}

export interface ReviewRequestData {
  item: SearchItem;
  details: PullRequestDetails;
  /** The player was requested by name, not only through a team. */
  direct: boolean;
}

export interface QuestInput extends ReviewRequestData {
  linear?: LinearReviewInfo;
}

export interface SubmittedReview {
  url: string;
  /** GitHub rejected the inline comments (lines outside the diff), so they went in the body. */
  inlineCommentsDropped: boolean;
}

export interface GitHubClientOptions {
  onWarning?: (message: string) => void;
}

function parseJson<TValue>(text: string, schema: z.ZodType<TValue>, what: string): TValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GhError(`Unexpected ${what} output: not JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GhError(
      `Unexpected ${what} output: ${parsed.error.issues.at(0)?.message ?? 'invalid shape'}`,
    );
  }
  return parsed.data;
}

export function parseSearchResults(text: string): Array<SearchItem> {
  return parseJson(text, z.array(SearchItemSchema), 'gh search').flatMap((raw) => {
    const [owner, name, ...rest] = raw.repository.nameWithOwner.split('/');
    if (!owner || !name || rest.length > 0) {
      return [];
    }
    return [
      {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        repo: { owner, name },
        authorLogin: raw.author?.login,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        isDraft: raw.isDraft,
      },
    ];
  });
}

export function parsePullRequestDetails(text: string): PullRequestDetails {
  const raw = parseJson(text, PullRequestDetailsSchema, 'gh pr view');
  return {
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headRefOid: raw.headRefOid,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    authorName: raw.author?.name || undefined,
    requestedTeams: raw.reviewRequests.flatMap((request) =>
      request.__typename === 'Team' && request.slug
        ? [request.slug.split('/').at(-1) ?? request.slug]
        : [],
    ),
  };
}

export function toQuest({ item, details, direct, linear }: QuestInput): Quest {
  const diffStats = {
    fileCount: details.changedFiles,
    additions: details.additions,
    deletions: details.deletions,
  };
  const quest: Quest = {
    id: formatQuestId(item.repo, item.number),
    title: item.title,
    repo: item.repo,
    number: item.number,
    author: {
      name: details.authorName ?? item.authorLogin ?? 'unknown',
      githubLogin: item.authorLogin,
    },
    sourceBranch: details.headRefName,
    targetBranch: details.baseRefName,
    headSha: details.headRefOid,
    status: item.isDraft ? 'draft' : 'open',
    diffStats,
    difficulty: difficultyFor(diffStats),
    requestKind: direct ? 'direct' : 'team',
    requestedTeams: direct ? [] : details.requestedTeams,
    needsAttention: linear?.needsAttention ?? false,
    githubUrl: item.url,
    openedAt: item.createdAt,
    updatedAt: item.updatedAt,
    requestedAt: item.createdAt,
    source: linear ? 'linear' : 'github',
  };
  if (linear?.appUrl) {
    quest.linearUrl = linear.appUrl;
  }
  return quest;
}

/** GitHub access through the player's `gh` login. */
export class GitHubClient {
  private readonly gh: GhRunner;
  private readonly onWarning: (message: string) => void;

  public constructor(gh: GhRunner, options: GitHubClientOptions = {}) {
    this.gh = gh;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /** Open PRs requesting the player's review, directly or through a team, with their details. */
  public async fetchReviewRequests(): Promise<Array<ReviewRequestData>> {
    const [allText, directText] = await Promise.all([
      this.gh([
        'search',
        'prs',
        '--review-requested=@me',
        '--state=open',
        '--limit',
        SEARCH_LIMIT,
        '--json',
        SEARCH_FIELDS,
      ]),
      this.gh([
        'search',
        'prs',
        'user-review-requested:@me',
        '--state=open',
        '--limit',
        SEARCH_LIMIT,
        '--json',
        'url',
      ]),
    ]);
    const items = parseSearchResults(allText);
    const directUrls = new Set(
      parseJson(directText, DirectSearchSchema, 'gh search').map((entry) => entry.url),
    );

    const results = await mapWithConcurrency(items, VIEW_CONCURRENCY, async (item) => {
      try {
        const details = await this.viewPullRequest({ repo: item.repo, number: item.number });
        return { item, details, direct: directUrls.has(item.url) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.onWarning(`Skipping ${formatQuestId(item.repo, item.number)}: ${reason}`);
        return undefined;
      }
    });
    return results.filter((result): result is ReviewRequestData => result !== undefined);
  }

  public async viewPullRequest(ref: QuestRef): Promise<PullRequestDetails> {
    const text = await this.gh([
      'pr',
      'view',
      String(ref.number),
      '-R',
      repoArg(ref),
      '--json',
      VIEW_FIELDS,
    ]);
    return parsePullRequestDetails(text);
  }

  public async approve(ref: QuestRef, body?: string): Promise<void> {
    const args = ['pr', 'review', String(ref.number), '-R', repoArg(ref), '--approve'];
    if (body) {
      await this.gh([...args, '--body-file', '-'], { input: body });
      return;
    }
    await this.gh(args);
  }

  /** Posts one review; retries with everything in the body if GitHub rejects the inline lines. */
  public async submitReview(ref: QuestRef, draft: ReviewDraft): Promise<SubmittedReview> {
    const withInline = renderReview(draft, { inline: true });
    try {
      return { url: await this.postReview(ref, withInline), inlineCommentsDropped: false };
    } catch (error) {
      if (
        !(error instanceof GhError) ||
        error.httpStatus !== 422 ||
        withInline.comments.length === 0
      ) {
        throw error;
      }
      this.onWarning(
        `GitHub rejected inline comments on ${formatQuestId(ref.repo, ref.number)}; posting them in the body`,
      );
      return {
        url: await this.postReview(ref, renderReview(draft, { inline: false })),
        inlineCommentsDropped: true,
      };
    }
  }

  private async postReview(ref: QuestRef, payload: unknown): Promise<string> {
    const path = `repos/${ref.repo.owner}/${ref.repo.name}/pulls/${ref.number}/reviews`;
    const text = await this.gh(['api', '-X', 'POST', path, '--input', '-'], {
      input: JSON.stringify(payload),
    });
    return parseJson(text, CreatedReviewSchema, 'gh api review').html_url;
  }
}

const repoArg = (ref: QuestRef): string => `${ref.repo.owner}/${ref.repo.name}`;

async function mapWithConcurrency<TItem, TResult>(
  items: ReadonlyArray<TItem>,
  limit: number,
  fn: (item: TItem) => Promise<TResult>,
): Promise<Array<TResult>> {
  const results: Array<TResult> = new Array<TResult>(items.length);
  const pending = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) {
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
