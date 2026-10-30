import { z } from 'zod';

import type { Quest, RepoRef } from '../shared/api.ts';
import { GitHubApiError, type GitHubApi } from './githubApi.ts';
import type { LinearReviewInfo } from './linear.ts';
import { difficultyFor, formatQuestId, type QuestRef } from './quests.ts';
import { isRateLimitError, parseRateLimitReset } from './rateLimit.ts';
import { renderReview, type ReviewDraft } from './reviewPayload.ts';

const SEARCH_ALL_QUERY = 'is:pr is:open review-requested:@me';
const SEARCH_DIRECT_QUERY = 'is:pr is:open user-review-requested:@me';
const SEARCH_LIMIT = '100';
const VIEW_CONCURRENCY = 4;
const REPO_URL_PATTERN = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/;
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
  html_url: z.string(),
  repository_url: z.string(),
  user: z.object({ login: z.string() }).nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  draft: z.boolean().nullish(),
});

const SearchResponseSchema = z.object({ items: z.array(SearchItemSchema) });

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

const PullRequestHeadSchema = z.object({ head: z.object({ sha: z.string().min(1) }) });

const ViewerSchema = z.object({
  login: z.string().min(1),
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});

/** The signed-in GitHub user. */
export interface GitHubViewer {
  login: string;
  name?: string;
  avatarUrl?: string;
}

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
export class IncompleteQuestListError extends GitHubApiError {
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
    throw new GitHubApiError(`Unexpected GitHub ${what} response: not JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GitHubApiError(
      `Unexpected GitHub ${what} response: ${parsed.error.issues.at(0)?.message ?? 'invalid shape'}`,
    );
  }
  return parsed.data;
}

/** Items of a `GET /search/issues` response, skipping any whose repository can't be read. */
export function parseSearchResults(text: string): Array<SearchItem> {
  return parseJson(text, SearchResponseSchema, 'search').items.flatMap((raw) => {
    const [, owner, name] = REPO_URL_PATTERN.exec(raw.repository_url) ?? [];
    if (!owner || !name) {
      return [];
    }
    return [
      {
        number: raw.number,
        title: raw.title,
        url: raw.html_url,
        repo: { owner: decodeURIComponent(owner), name: decodeURIComponent(name) },
        authorLogin: raw.user?.login,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
        isDraft: raw.draft ?? false,
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
  const { data, errors } = parseJson(text, BatchResponseSchema, 'GraphQL');
  if (!data) {
    throw new GitHubApiError(
      `GitHub GraphQL returned no data: ${errors?.at(0)?.message ?? 'no reason'}`,
      { body: text },
    );
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

/** GitHub access as the player, through the REST and GraphQL APIs. */
export class GitHubClient {
  private readonly api: Pick<GitHubApi, 'request' | 'graphql'>;
  private readonly onWarning: (message: string) => void;

  public constructor(
    api: Pick<GitHubApi, 'request' | 'graphql'>,
    options: GitHubClientOptions = {},
  ) {
    this.api = api;
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
      this.search(SEARCH_ALL_QUERY),
      this.search(SEARCH_DIRECT_QUERY),
    ]);
    const items = parseSearchResults(allText);
    const directUrls = new Set(parseSearchResults(directText).map((entry) => entry.url));
    if (items.length === 0) {
      return [];
    }

    let viewerLogin: string | undefined;
    const batches = await mapWithConcurrency(
      chunk(items, DETAILS_BATCH_SIZE),
      BATCH_CONCURRENCY,
      async (batch) => {
        const result = await this.detailsFor(batch);
        viewerLogin ??= result.viewerLogin;
        return result.details;
      },
    );
    const details = batches.flat();
    const skipped = details.filter((entry) => entry === undefined).length;
    if (skipped * 2 > items.length) {
      throw new IncompleteQuestListError(skipped, items.length);
    }
    viewerLogin ??= await this.viewerLoginOrWarn();
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

  /** Details for every ref in one GraphQL query; GitHub returns the PRs it could read. */
  public async viewPullRequests(refs: ReadonlyArray<QuestRef>): Promise<PullRequestBatch> {
    const { query, variables } = buildPullRequestBatchQuery(refs);
    return parsePullRequestBatch(await this.api.graphql(query, variables), refs.length);
  }

  /**
   * When the exhausted quota resets, from `GET /rate_limit` (which doesn't count against any
   * quota). Used when the failed response's headers had no reset time.
   */
  public async fetchRateLimitReset(): Promise<Date | undefined> {
    try {
      return parseRateLimitReset(await this.api.request('GET', '/rate_limit'));
    } catch (error) {
      this.onWarning(`Could not read the GitHub rate limit: ${errorMessage(error)}`);
      return undefined;
    }
  }

  public async fetchViewer(): Promise<GitHubViewer> {
    const raw = parseJson(await this.api.request('GET', '/user'), ViewerSchema, 'user');
    const viewer: GitHubViewer = { login: raw.login };
    if (raw.name) {
      viewer.name = raw.name;
    }
    if (raw.avatar_url) {
      viewer.avatarUrl = raw.avatar_url;
    }
    return viewer;
  }

  /** The PR's current head commit, lower-cased. */
  public async fetchHeadSha(ref: QuestRef): Promise<string> {
    const text = await this.api.request('GET', pullPath(ref));
    return parseJson(text, PullRequestHeadSchema, 'pull request').head.sha.toLowerCase();
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
        !(error instanceof GitHubApiError) ||
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

  private search(q: string): Promise<string> {
    return this.api.request('GET', '/search/issues', { query: { q, per_page: SEARCH_LIMIT } });
  }

  /** One batch of details aligned with `items`; `undefined` marks a PR that was skipped. */
  private async detailsFor(
    items: ReadonlyArray<SearchItem>,
  ): Promise<{ details: Array<PullRequestDetails | undefined>; viewerLogin?: string }> {
    let batch: PullRequestBatch;
    try {
      batch = await this.viewPullRequests(items);
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      this.onWarning(
        `Batched PR lookup failed, falling back to one query per PR: ${errorMessage(error)}`,
      );
      return { details: await this.detailsOneByOne(items) };
    }
    const details = batch.entries.map((entry, index) => {
      if ('details' in entry) {
        return entry.details;
      }
      const item = items.at(index);
      if (item) {
        this.skip(item, entry.error);
      }
      return undefined;
    });
    return batch.viewerLogin ? { details, viewerLogin: batch.viewerLogin } : { details };
  }

  private detailsOneByOne(
    items: ReadonlyArray<SearchItem>,
  ): Promise<Array<PullRequestDetails | undefined>> {
    return mapWithConcurrency(items, VIEW_CONCURRENCY, async (item) => {
      try {
        const [entry] = (await this.viewPullRequests([item])).entries;
        if (entry && 'details' in entry) {
          return entry.details;
        }
        this.skip(item, entry?.error ?? 'GitHub returned no pull request');
      } catch (error) {
        if (isRateLimitError(error)) {
          throw error;
        }
        this.skip(item, errorMessage(error));
      }
      return undefined;
    });
  }

  /** The player's login when no batch returned it, from one `GET /user` call. */
  private async viewerLoginOrWarn(): Promise<string | undefined> {
    try {
      return (await this.fetchViewer()).login;
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      this.onWarning(`Could not read your GitHub login: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private skip(item: SearchItem, reason: string): void {
    this.onWarning(`Skipping ${formatQuestId(item.repo, item.number)}: ${reason}`);
  }

  private async postReview(ref: QuestRef, payload: unknown): Promise<string> {
    const text = await this.api.request('POST', `${pullPath(ref)}/reviews`, { body: payload });
    return parseJson(text, CreatedReviewSchema, 'review').html_url;
  }
}

/** `/repos/<owner>/<repo>`, with both names encoded so they can't change the path. */
export const repoPath = (repo: RepoRef): string =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

const pullPath = (ref: QuestRef): string => `${repoPath(ref.repo)}/pulls/${ref.number}`;

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
