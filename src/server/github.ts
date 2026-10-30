import { z } from 'zod';

import type { Quest, RepoRef } from '../shared/api.ts';
import { GhError, type GhRunner } from './gh.ts';
import type { LinearReviewInfo } from './linear.ts';
import { difficultyFor, formatQuestId, type QuestRef } from './quests.ts';
import { isRateLimitError, parseRateLimitReset } from './rateLimit.ts';
import { renderReview, type ReviewDraft } from './reviewPayload.ts';

const SEARCH_FIELDS = 'number,title,url,repository,author,createdAt,updatedAt,isDraft';
const VIEW_FIELDS =
  'headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,reviewRequests,latestReviews,createdAt,url,title,author,isDraft';
const SEARCH_LIMIT = '100';
const VIEW_CONCURRENCY = 4;
/** PRs per GraphQL query; GitHub's cost limits leave plenty of room at this size. */
export const DETAILS_BATCH_SIZE = 25;
const BATCH_CONCURRENCY = 2;

const BATCH_FIELDS = `
  headRefName
  baseRefName
  headRefOid
  isDraft
  additions
  deletions
  changedFiles
  author { login ... on User { name } }
  reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on Team { slug } } } }
  latestReviews(first: 100) { nodes { state author { login } } }`;

const APPROVED = 'APPROVED';

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

const ReviewerSchema = z.object({ __typename: z.string(), slug: z.string().nullish() });

const LatestReviewSchema = z.object({
  state: z.string(),
  author: z.object({ login: z.string() }).nullish(),
});

const PullRequestCoreSchema = z.object({
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  isDraft: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  author: z.object({ login: z.string(), name: z.string().nullish() }).nullish(),
});

const PullRequestDetailsSchema = PullRequestCoreSchema.extend({
  reviewRequests: z.array(ReviewerSchema),
  latestReviews: z.array(LatestReviewSchema),
});

const BatchPullRequestSchema = PullRequestCoreSchema.extend({
  reviewRequests: z.object({
    nodes: z.array(z.object({ requestedReviewer: ReviewerSchema.nullish() }).nullish()),
  }),
  latestReviews: z.object({ nodes: z.array(LatestReviewSchema.nullish()) }),
});

const BatchResponseSchema = z.object({
  data: z
    .object({ viewer: z.object({ login: z.string() }).nullish() })
    .catchall(z.object({ pullRequest: BatchPullRequestSchema.nullish() }).nullish())
    .nullish(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        path: z.array(z.union([z.string(), z.number()])).nullish(),
      }),
    )
    .nullish(),
});

const CreatedReviewSchema = z.object({ html_url: z.string() });

const HeadShaSchema = z.object({ headRefOid: z.string().min(1) });

export interface ApproveOptions {
  /** The commit the player reviewed; GitHub attaches the approval to it, not to the branch tip. */
  commitId: string;
  body?: string;
}

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
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  authorName?: string;
  /** Team slugs without the org prefix, e.g. `team-gluon`. */
  requestedTeams: Array<string>;
  /** Logins whose latest review is `APPROVED`, the player included. */
  approvedBy: Array<string>;
}

export interface ReviewRequestData {
  item: SearchItem;
  details: PullRequestDetails;
  /** The player was requested by name, not only through a team. */
  direct: boolean;
  /** The player's GitHub login, so their own approval doesn't count as someone else's. */
  viewerLogin?: string;
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

/**
 * The search found PRs but most of their details could not be read, so the list would understate
 * the queue (and could look empty). Callers should keep their previous list.
 */
export class IncompleteQuestListError extends GhError {
  public constructor(skipped: number, total: number) {
    super(`Could not read ${skipped} of ${total} review requests from GitHub`);
    this.name = 'IncompleteQuestListError';
  }
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

function toDetails(
  raw: z.infer<typeof PullRequestCoreSchema>,
  reviewers: ReadonlyArray<z.infer<typeof ReviewerSchema>>,
  latestReviews: ReadonlyArray<z.infer<typeof LatestReviewSchema>>,
): PullRequestDetails {
  return {
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headRefOid: raw.headRefOid,
    isDraft: raw.isDraft,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    authorName: raw.author?.name || undefined,
    requestedTeams: reviewers.flatMap((reviewer) =>
      reviewer.__typename === 'Team' && reviewer.slug
        ? [reviewer.slug.split('/').at(-1) ?? reviewer.slug]
        : [],
    ),
    approvedBy: latestReviews.flatMap((review) =>
      review.state === APPROVED && review.author ? [review.author.login] : [],
    ),
  };
}

export function parsePullRequestDetails(text: string): PullRequestDetails {
  const raw = parseJson(text, PullRequestDetailsSchema, 'gh pr view');
  return toDetails(raw, raw.reviewRequests, raw.latestReviews);
}

export interface PullRequestBatchQuery {
  query: string;
  variables: Record<string, string | number>;
}

/**
 * One aliased `repository { pullRequest }` lookup per ref (`pr0`, `pr1`, ...), as variables, plus
 * the player's login.
 */
export function buildPullRequestBatchQuery(refs: ReadonlyArray<QuestRef>): PullRequestBatchQuery {
  const variables: Record<string, string | number> = {};
  const params: Array<string> = [];
  const lookups: Array<string> = [];
  refs.forEach((ref, index) => {
    variables[`owner${index}`] = ref.repo.owner;
    variables[`name${index}`] = ref.repo.name;
    variables[`number${index}`] = ref.number;
    params.push(`$owner${index}: String!, $name${index}: String!, $number${index}: Int!`);
    lookups.push(
      `  pr${index}: repository(owner: $owner${index}, name: $name${index}) { pullRequest(number: $number${index}) { ...Details } }`,
    );
  });
  return {
    query: [
      `query(${params.join(', ')}) {`,
      '  viewer { login }',
      ...lookups,
      '}',
      `fragment Details on PullRequest {${BATCH_FIELDS}\n}`,
    ].join('\n'),
    variables,
  };
}

/** Details for one ref of a batch, or GitHub's reason for returning none. */
export type BatchEntry = { details: PullRequestDetails } | { error: string };

export interface PullRequestBatch {
  entries: Array<BatchEntry>;
  viewerLogin?: string;
}

/**
 * Splits a batch response into one entry per ref, in request order. Throws when the response has
 * no data at all (bad query, auth, rate limit), so the caller can fall back.
 */
export function parsePullRequestBatch(text: string, count: number): PullRequestBatch {
  const { data, errors } = parseJson(text, BatchResponseSchema, 'gh api graphql');
  if (!data) {
    throw new GhError(`gh api graphql returned no data: ${errors?.at(0)?.message ?? 'no reason'}`);
  }
  const entries = Array.from({ length: count }, (_, index): BatchEntry => {
    const alias = `pr${index}`;
    const pullRequest = data[alias]?.pullRequest;
    if (pullRequest) {
      const reviewers = pullRequest.reviewRequests.nodes.flatMap(
        (node) => node?.requestedReviewer ?? [],
      );
      const latestReviews = pullRequest.latestReviews.nodes.flatMap((node) => node ?? []);
      return { details: toDetails(pullRequest, reviewers, latestReviews) };
    }
    const reason = errors?.find((error) => error.path?.[0] === alias)?.message;
    return { error: reason ?? 'GitHub returned no pull request' };
  });
  const viewerLogin = data.viewer?.login;
  return viewerLogin ? { entries, viewerLogin } : { entries };
}

export function toQuest({ item, details, direct, viewerLogin, linear }: QuestInput): Quest {
  const diffStats = {
    fileCount: details.changedFiles,
    additions: details.additions,
    deletions: details.deletions,
  };
  const viewer = viewerLogin?.toLowerCase();
  const approvalCount = details.approvedBy.filter((login) => login.toLowerCase() !== viewer).length;
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
    status: details.isDraft ? 'draft' : 'open',
    isDraft: details.isDraft,
    approvedByOthers: approvalCount > 0,
    approvalCount,
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
  private viewerLogin?: string;

  public constructor(gh: GhRunner, options: GitHubClientOptions = {}) {
    this.gh = gh;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /**
   * Open PRs requesting the player's review, directly or through a team, with their details.
   * A rate-limited call rejects right away instead of falling back to more calls. PRs whose details
   * can't be read are skipped, unless that is most of them: then it rejects with
   * `IncompleteQuestListError`.
   */
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

    const batches = await mapWithConcurrency(
      chunk(items, DETAILS_BATCH_SIZE),
      BATCH_CONCURRENCY,
      (batch) => this.detailsFor(batch),
    );
    const details = batches.flat();
    const skipped = details.filter((entry) => entry === undefined).length;
    if (skipped * 2 > items.length) {
      throw new IncompleteQuestListError(skipped, items.length);
    }
    const viewerLogin = items.length > 0 ? await this.viewer() : undefined;
    return items.flatMap((item, index): Array<ReviewRequestData> => {
      const found = details[index];
      if (!found) {
        return [];
      }
      const entry: ReviewRequestData = { item, details: found, direct: directUrls.has(item.url) };
      if (viewerLogin) {
        entry.viewerLogin = viewerLogin;
      }
      return [entry];
    });
  }

  /**
   * Details for every ref in one GraphQL query. `gh api graphql` exits non-zero when any lookup
   * fails but still prints the others, so partial data is kept.
   */
  public async viewPullRequests(refs: ReadonlyArray<QuestRef>): Promise<Array<BatchEntry>> {
    const input = JSON.stringify(buildPullRequestBatchQuery(refs));
    let text: string;
    try {
      text = await this.gh(['api', 'graphql', '--input', '-'], { input });
    } catch (error) {
      if (!(error instanceof GhError) || !error.stdout || isRateLimitError(error)) {
        throw error;
      }
      text = error.stdout;
    }
    const batch = parsePullRequestBatch(text, refs.length);
    this.viewerLogin ??= batch.viewerLogin;
    return batch.entries;
  }

  /**
   * When the exhausted quota resets, from `gh api rate_limit` (which doesn't count against any
   * quota). `undefined` when no quota is at zero or the call fails.
   */
  public async fetchRateLimitReset(): Promise<Date | undefined> {
    try {
      return parseRateLimitReset(await this.gh(['api', 'rate_limit']));
    } catch (error) {
      this.onWarning(`Could not read the GitHub rate limit: ${errorMessage(error)}`);
      return undefined;
    }
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

  /** The PR's current head commit, lower-cased. */
  public async fetchHeadSha(ref: QuestRef): Promise<string> {
    const text = await this.gh([
      'pr',
      'view',
      String(ref.number),
      '-R',
      repoArg(ref),
      '--json',
      'headRefOid',
    ]);
    return parseJson(text, HeadShaSchema, 'gh pr view').headRefOid.toLowerCase();
  }

  public async approve(ref: QuestRef, { commitId, body }: ApproveOptions): Promise<void> {
    const payload: Record<string, string> = { event: 'APPROVE', commit_id: commitId };
    if (body) {
      payload.body = body;
    }
    await this.postReview(ref, payload);
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

  /** One batch of details aligned with `items`; `undefined` marks a PR that was skipped. */
  private async detailsFor(
    items: ReadonlyArray<SearchItem>,
  ): Promise<Array<PullRequestDetails | undefined>> {
    let entries: Array<BatchEntry>;
    try {
      entries = await this.viewPullRequests(items);
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      this.onWarning(
        `Batched PR lookup failed, falling back to one gh pr view per PR: ${errorMessage(error)}`,
      );
      return mapWithConcurrency(items, VIEW_CONCURRENCY, async (item) => {
        try {
          return await this.viewPullRequest(item);
        } catch (viewError) {
          if (isRateLimitError(viewError)) {
            throw viewError;
          }
          this.skip(item, errorMessage(viewError));
          return undefined;
        }
      });
    }
    return entries.map((entry, index) => {
      if ('details' in entry) {
        return entry.details;
      }
      const item = items.at(index);
      if (item) {
        this.skip(item, entry.error);
      }
      return undefined;
    });
  }

  /** The player's login: from the batch query, or one `gh api user` call when every batch failed. */
  private async viewer(): Promise<string | undefined> {
    if (this.viewerLogin) {
      return this.viewerLogin;
    }
    try {
      this.viewerLogin = (await this.gh(['api', 'user', '--jq', '.login'])).trim() || undefined;
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      this.onWarning(`Could not read your GitHub login: ${errorMessage(error)}`);
    }
    return this.viewerLogin;
  }

  private skip(item: SearchItem, reason: string): void {
    this.onWarning(`Skipping ${formatQuestId(item.repo, item.number)}: ${reason}`);
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function chunk<TItem>(items: ReadonlyArray<TItem>, size: number): Array<Array<TItem>> {
  const chunks: Array<Array<TItem>> = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

async function mapWithConcurrency<TItem, TResult>(
  items: ReadonlyArray<TItem>,
  limit: number,
  fn: (item: TItem) => Promise<TResult>,
): Promise<Array<TResult>> {
  const results: Array<TResult> = new Array<TResult>(items.length);
  const pending = items.entries();
  let failed = false;
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) {
      if (failed) {
        return;
      }
      try {
        results[index] = await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
