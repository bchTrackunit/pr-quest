import { z } from 'zod';

import type { Quest, RepoRef } from '@pr-quest/contract/api';
import type {
  DiscussionComment,
  DiscussionThread,
  PullRequestDiscussion,
} from '@pr-quest/contract/discussion';
import { GitHubApiError, type GitHubApi } from '../../platform/githubApi.ts';
import type { LinearReviewInfo } from './linear.ts';
import {
  type AuthoredPullRequest,
  buildMyPullRequestsQuery,
  MAX_OPEN_PRS,
  parseMyPullRequestsPage,
} from './myPullRequests.ts';
import { difficultyFor, formatQuestId, type QuestRef } from './quests.ts';
import { isRateLimitError, parseRateLimitReset } from '../../platform/rateLimit.ts';
import {
  renderReview,
  type GitHubReviewComment,
  type RenderedFinding,
  type RenderedReview,
  type ReviewDraft,
} from './reviewPayload.ts';

/** The player's own PRs belong on My PRs, even when a team they're on is asked to review. */
const SEARCH_ALL_QUERY = 'is:pr is:open review-requested:@me -author:@me';
const SEARCH_DIRECT_QUERY = 'is:pr is:open user-review-requested:@me -author:@me';
const SEARCH_LIMIT = '100';
const VIEW_CONCURRENCY = 4;
const REPO_URL_PATTERN = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/;
const DIFF_MEDIA_TYPE = 'application/vnd.github.diff';
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
  authorAssociation
  isCrossRepository
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
  authorAssociation: z.string().nullish(),
  isCrossRepository: z.boolean().nullish(),
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

const COMMENT_FIELDS = 'body authorAssociation author { __typename login }';

/** The newest 100 of each, which is what GitHub allows per connection. Drafts are left out. */
const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 100, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
        nodes { ${COMMENT_FIELDS} }
      }
      reviewThreads(last: 100) {
        nodes {
          path line isResolved isOutdated
          comments(first: 50) { nodes { state ${COMMENT_FIELDS} } }
        }
      }
      comments(last: 100) { nodes { ${COMMENT_FIELDS} } }
    }
  }
}`;

const PENDING = 'PENDING';
const PUSH_PERMISSIONS: ReadonlySet<string> = new Set(['admin', 'write']);
const PERMISSION_CONCURRENCY = 4;

const PermissionSchema = z.object({ permission: z.string() });

const CommentSchema = z.object({
  body: z.string(),
  authorAssociation: z.string().nullish(),
  author: z.object({ __typename: z.string(), login: z.string() }).nullish(),
});

const nodesOf = <TSchema extends z.ZodType>(schema: TSchema) =>
  z.object({ nodes: z.array(schema.nullish()) });

const DiscussionResponseSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviews: nodesOf(CommentSchema),
              reviewThreads: nodesOf(
                z.object({
                  path: z.string(),
                  line: z.number().int().nullish(),
                  isResolved: z.boolean(),
                  isOutdated: z.boolean(),
                  comments: nodesOf(CommentSchema.extend({ state: z.string() })),
                }),
              ),
              comments: nodesOf(CommentSchema),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

const CreatedReviewSchema = z.object({ html_url: z.string() });

const PendingReviewSchema = z.object({ id: z.number().int(), node_id: z.string().min(1) });

const ADD_THREAD_MUTATION = `mutation($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id } }
}`;

/** A refused thread comes back as GraphQL errors, or as no thread at all. */
const AddThreadResponseSchema = z.object({
  data: z
    .object({
      addPullRequestReviewThread: z
        .object({ thread: z.object({ id: z.string() }).nullish() })
        .nullish(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string(), type: z.string().nullish() })).nullish(),
});

/** GraphQL error types that say nothing about where a comment can go, so the post stops. */
const FATAL_THREAD_ERRORS: ReadonlySet<string> = new Set(['FORBIDDEN', 'RATE_LIMITED']);

/** GitHub allows one pending review per person and PR, including one started in its own UI. */
const PENDING_REVIEW_EXISTS = /one pending review/i;

const MAX_UNANCHORED_LISTED = 5;

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
  /** GitHub's `CommentAuthorAssociation` for the PR author, e.g. `MEMBER` or `CONTRIBUTOR`. */
  authorAssociation?: string;
  /** The head branch lives in a fork rather than the base repo. */
  isCrossRepository?: boolean;
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
}

/** A review GitHub has submitted, or one left pending for the findings still to add. */
type OpenedReview =
  | { submitted: true; url: string }
  | { submitted: false; id: number; nodeId: string; remaining: Array<RenderedFinding> };

/** GitHub took nothing of the review, for a reason the player can fix before posting again. */
export class ReviewNotPostedError extends GitHubApiError {
  public constructor(message: string) {
    super(message);
    this.name = 'ReviewNotPostedError';
  }
}

/**
 * GitHub took some findings neither on their lines nor on their file, usually because the file
 * isn't part of the PR. Nothing was posted, since the only place left for them is the review body.
 */
export class UnanchoredFindingsError extends ReviewNotPostedError {
  public constructor(files: ReadonlyArray<string>, reason: string) {
    const unique = [...new Set(files)];
    const listed = unique.slice(0, MAX_UNANCHORED_LISTED).join(', ');
    const more =
      unique.length > MAX_UNANCHORED_LISTED
        ? ` and ${unique.length - MAX_UNANCHORED_LISTED} more`
        : '';
    super(
      `GitHub would not attach ${files.length === 1 ? 'a finding' : `${files.length} findings`} on ${listed}${more} to the pull request (${reason}). Deselect ${files.length === 1 ? 'it' : 'them'} and post again.`,
    );
    this.name = 'UnanchoredFindingsError';
  }
}

export interface GitHubClientOptions {
  onWarning?: (message: string) => void;
}

/** What one read of the player's PRs found, with how much of it couldn't be read. */
export interface AuthoredPullRequests {
  viewerLogin: string;
  open: Array<AuthoredPullRequest>;
  /** Merged and closed PRs updated since the asked-for time, newest-updated first. */
  done: Array<AuthoredPullRequest>;
  openSkipped: number;
  doneSkipped: number;
  /** Errors reading merged and closed PRs, other than access GitHub will never grant. */
  doneErrors: number;
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
    authorAssociation: raw.authorAssociation || undefined,
    isCrossRepository: raw.isCrossRepository ?? undefined,
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

/** Throws when GitHub returned no pull request, e.g. because the player can't read the repo. */
export function parseDiscussion(text: string): PullRequestDiscussion {
  const { data, errors } = parseJson(text, DiscussionResponseSchema, 'GraphQL');
  const pullRequest = data?.repository?.pullRequest;
  if (!pullRequest) {
    throw new GitHubApiError(
      `GitHub returned no pull request: ${errors?.at(0)?.message ?? 'no reason'}`,
      { body: text },
    );
  }
  const present = <TNode>(nodes: ReadonlyArray<TNode | null | undefined>): Array<TNode> =>
    nodes.flatMap((node) => node ?? []);
  const withBody = (comments: Array<z.infer<typeof CommentSchema>>): Array<DiscussionComment> =>
    comments.flatMap((comment) => (comment.body.trim() ? [toDiscussionComment(comment)] : []));
  return {
    reviews: withBody(present(pullRequest.reviews.nodes)),
    threads: present(pullRequest.reviewThreads.nodes).flatMap((thread) => {
      const comments = withBody(
        present(thread.comments.nodes).filter((comment) => comment.state !== PENDING),
      );
      if (comments.length === 0) {
        return [];
      }
      const entry: DiscussionThread = {
        file: thread.path,
        resolved: thread.isResolved,
        outdated: thread.isOutdated,
        comments,
      };
      if (typeof thread.line === 'number') {
        entry.line = thread.line;
      }
      return [entry];
    }),
    conversation: withBody(present(pullRequest.comments.nodes)),
  };
}

/** GitHub shows a deleted account as `ghost`. */
function toDiscussionComment(raw: z.infer<typeof CommentSchema>): DiscussionComment {
  const comment: DiscussionComment = {
    author: raw.author?.login ?? 'ghost',
    isBot: raw.author?.__typename === 'Bot',
    body: raw.body,
  };
  if (raw.authorAssociation) {
    comment.authorAssociation = raw.authorAssociation;
  }
  return comment;
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
  if (details.authorAssociation) {
    quest.authorAssociation = details.authorAssociation;
  }
  if (details.isCrossRepository !== undefined) {
    quest.isCrossRepository = details.isCrossRepository;
  }
  if (linear?.appUrl) {
    quest.linearUrl = linear.appUrl;
  }
  return quest;
}

/** GitHub access as the player, through the REST and GraphQL APIs. */
export class GitHubClient {
  private readonly api: Pick<GitHubApi, 'request' | 'graphql'>;
  private readonly onWarning: (message: string) => void;
  private warnedOpenPrCap = false;

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

  /**
   * The player's open PRs (up to `MAX_OPEN_PRS`), and their merged and closed PRs updated at or
   * after `doneSince`. Each part pages on its own; both share a query while both have pages left.
   */
  public async fetchMyPullRequests(doneSince: Date): Promise<AuthoredPullRequests> {
    const result: AuthoredPullRequests = {
      viewerLogin: '',
      open: [],
      done: [],
      openSkipped: 0,
      doneSkipped: 0,
      doneErrors: 0,
    };
    let open: { after?: string } | undefined = {};
    let done: { after?: string } | undefined = {};
    while (open || done) {
      const { query, variables } = buildMyPullRequestsQuery({ open, done });
      const page = parseMyPullRequestsPage(await this.api.graphql(query, variables));
      if ((open && !page.open) || (done && !page.done)) {
        throw new GitHubApiError(
          `GitHub returned no list of your ${open && !page.open ? 'open' : 'merged and closed'} PRs`,
        );
      }
      result.viewerLogin = page.viewerLogin;
      open = undefined;
      if (page.open) {
        result.open.push(...page.open.pullRequests);
        result.openSkipped += page.open.skipped;
        const read = result.open.length + result.openSkipped;
        if (page.open.nextCursor && read >= MAX_OPEN_PRS) {
          if (!this.warnedOpenPrCap) {
            this.warnedOpenPrCap = true;
            this.onWarning(`You have more than ${MAX_OPEN_PRS} open PRs; showing the newest ones`);
          }
        } else if (page.open.nextCursor) {
          open = { after: page.open.nextCursor };
        }
      }
      done = undefined;
      if (page.done) {
        const recent = page.done.pullRequests.filter(
          (pr) => Date.parse(pr.updatedAt) >= doneSince.getTime(),
        );
        result.done.push(...recent);
        result.doneSkipped += page.done.skipped;
        result.doneErrors += page.done.otherErrors;
        const reachedSince = recent.length < page.done.pullRequests.length;
        if (page.done.nextCursor && !reachedSince) {
          done = { after: page.done.nextCursor };
        }
      }
    }
    return result;
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

  /**
   * The unified diff of `headSha` against its merge base with `base`, the same changes the PR
   * shows. If the compare API can't answer, the PR's own diff is used, but only while the PR's
   * head is still `headSha`, so findings never point at lines from a different commit.
   */
  public async fetchDiff(
    ref: QuestRef,
    { base, headSha }: { base: string; headSha: string },
  ): Promise<string> {
    const basePath = base.split('/').map(encodeURIComponent).join('/');
    try {
      return await this.api.request(
        'GET',
        `${repoPath(ref.repo)}/compare/${basePath}...${encodeURIComponent(headSha)}`,
        { accept: DIFF_MEDIA_TYPE },
      );
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      this.onWarning(
        `Comparing ${base}...${headSha.slice(0, 7)} failed, using the PR diff: ${errorMessage(error)}`,
      );
    }
    await this.assertHead(ref, headSha);
    const diff = await this.api.request('GET', pullPath(ref), { accept: DIFF_MEDIA_TYPE });
    await this.assertHead(ref, headSha);
    return diff;
  }

  /** Reviews, inline threads and conversation comments already on the PR, in one query. */
  public async fetchDiscussion(ref: QuestRef): Promise<PullRequestDiscussion> {
    const text = await this.api.graphql(DISCUSSION_QUERY, {
      owner: ref.repo.owner,
      name: ref.repo.name,
      number: ref.number,
    });
    return parseDiscussion(text);
  }

  /**
   * The lower-cased `logins` that can push to the repo, one call each. A login GitHub doesn't
   * confirm, for example because the player may not see the repo's collaborators, can't.
   */
  public async pushersAmong(ref: QuestRef, logins: ReadonlyArray<string>): Promise<Set<string>> {
    const checked = await mapWithConcurrency(logins, PERMISSION_CONCURRENCY, async (login) => {
      try {
        const text = await this.api.request(
          'GET',
          `${repoPath(ref.repo)}/collaborators/${encodeURIComponent(login)}/permission`,
        );
        const { permission } = parseJson(text, PermissionSchema, 'permission');
        return PUSH_PERMISSIONS.has(permission) ? [login.toLowerCase()] : [];
      } catch (error) {
        this.onWarning(`Could not check whether ${login} can push: ${errorMessage(error)}`);
        return [];
      }
    });
    return new Set(checked.flat());
  }

  public async approve(ref: QuestRef, { commitId, body }: ApproveOptions): Promise<void> {
    const payload: Record<string, string> = { event: 'APPROVE', commit_id: commitId };
    if (body) {
      payload.body = body;
    }
    await this.postReview(ref, payload);
  }

  /**
   * Posts one review with every finding as a comment on its lines, or on its file when it has no
   * line or GitHub refuses the line. Findings never go in the review body; if GitHub takes a
   * finding nowhere, the review is deleted and nothing is posted.
   */
  public async submitReview(ref: QuestRef, draft: ReviewDraft): Promise<SubmittedReview> {
    const review = renderReview(draft);
    const opened = await this.openReview(ref, review);
    if (opened.submitted) {
      return { url: opened.url };
    }
    try {
      await this.addFindings(opened.nodeId, opened.remaining);
    } catch (error) {
      await this.deletePendingReview(ref, opened.id);
      throw error;
    }
    let text: string;
    try {
      text = await this.api.request('POST', `${pullPath(ref)}/reviews/${opened.id}/events`, {
        body: { event: review.event, body: review.body },
      });
    } catch (error) {
      // Without an answer from GitHub the review may have gone out, and a retry would post it twice.
      if (error instanceof GitHubApiError && error.httpStatus !== undefined) {
        await this.deletePendingReview(ref, opened.id);
      }
      throw error;
    }
    return { url: parseJson(text, CreatedReviewSchema, 'review').html_url };
  }

  private async addFindings(reviewId: string, findings: Array<RenderedFinding>): Promise<void> {
    const unanchored: Array<string> = [];
    let reason = '';
    for (const finding of findings) {
      const refusal = await this.addFinding(reviewId, finding);
      if (refusal !== undefined) {
        unanchored.push(finding.onFile.path);
        reason ||= refusal;
      }
    }
    if (unanchored.length > 0) {
      throw new UnanchoredFindingsError(unanchored, reason);
    }
  }

  /**
   * Creates the review with every finding that has a line as an inline comment, submitted at once
   * when no finding needs more. One refused line fails the whole request, so after a 422 the review
   * starts pending and empty, and every finding is added on its own.
   */
  private async openReview(ref: QuestRef, review: RenderedReview): Promise<OpenedReview> {
    const onLines = review.findings.flatMap((finding) => finding.onLines ?? []);
    const complete = onLines.length === review.findings.length;
    try {
      const text = await this.createReview(ref, review, onLines, complete);
      if (complete) {
        return { submitted: true, url: parseJson(text, CreatedReviewSchema, 'review').html_url };
      }
      return pendingReview(
        text,
        review.findings.filter((finding) => !finding.onLines),
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.httpStatus !== 422 || onLines.length === 0) {
        throw error;
      }
      this.onWarning(
        `GitHub refused an inline comment on ${formatQuestId(ref.repo, ref.number)}; adding the findings one at a time`,
      );
    }
    return pendingReview(await this.createReview(ref, review, [], false), review.findings);
  }

  /** Without `submit` the review stays pending, and its body and event come when it's submitted. */
  private async createReview(
    ref: QuestRef,
    review: RenderedReview,
    comments: Array<GitHubReviewComment>,
    submit: boolean,
  ): Promise<string> {
    const payload: Record<string, unknown> = { comments };
    if (submit) {
      payload.event = review.event;
      payload.body = review.body;
    }
    if (review.commitId) {
      payload.commit_id = review.commitId;
    }
    try {
      return await this.api.request('POST', `${pullPath(ref)}/reviews`, { body: payload });
    } catch (error) {
      if (error instanceof GitHubApiError && PENDING_REVIEW_EXISTS.test(error.body ?? '')) {
        throw new ReviewNotPostedError(
          `You have a review on ${formatQuestId(ref.repo, ref.number)} that isn't submitted yet. Submit or discard it on GitHub, then post again.`,
        );
      }
      throw error;
    }
  }

  /** Adds a finding to a pending review on its lines, else on its file; returns why GitHub refused both. */
  private async addFinding(
    reviewId: string,
    finding: RenderedFinding,
  ): Promise<string | undefined> {
    const { onLines, onFile } = finding;
    if (onLines) {
      const refusal = await this.addThread({
        pullRequestReviewId: reviewId,
        path: onLines.path,
        body: onLines.body,
        line: onLines.line,
        side: onLines.side,
        ...(onLines.start_line === undefined
          ? {}
          : { startLine: onLines.start_line, startSide: onLines.start_side ?? 'RIGHT' }),
      });
      if (refusal === undefined) {
        return undefined;
      }
      this.onWarning(`GitHub refused line ${onLines.line} of ${onLines.path}: ${refusal}`);
    }
    return this.addThread({
      pullRequestReviewId: reviewId,
      path: onFile.path,
      body: onFile.body,
      subjectType: 'FILE',
    });
  }

  /**
   * Why GitHub refused the thread's place, or `undefined` once it's added. Failed requests,
   * permission errors and rate limits throw instead, since another place can't fix them.
   */
  private async addThread(input: Record<string, unknown>): Promise<string | undefined> {
    const text = await this.api.graphql(ADD_THREAD_MUTATION, { input });
    const { data, errors } = parseJson(text, AddThreadResponseSchema, 'GraphQL');
    if (data?.addPullRequestReviewThread?.thread) {
      return undefined;
    }
    const first = errors?.at(0);
    const reason = first?.message ?? 'GitHub added no comment';
    const failure = new GitHubApiError(`GitHub GraphQL failed: ${reason}`, { body: text });
    if ((first?.type && FATAL_THREAD_ERRORS.has(first.type)) || isRateLimitError(failure)) {
      throw failure;
    }
    return reason;
  }

  private async deletePendingReview(ref: QuestRef, reviewId: number): Promise<void> {
    try {
      await this.api.request('DELETE', `${pullPath(ref)}/reviews/${reviewId}`);
    } catch (error) {
      this.onWarning(
        `Could not delete the pending review on ${formatQuestId(ref.repo, ref.number)}: ${errorMessage(error)}`,
      );
    }
  }

  private async assertHead(ref: QuestRef, headSha: string): Promise<void> {
    const currentHead = await this.fetchHeadSha(ref);
    if (currentHead !== headSha.toLowerCase()) {
      throw new GitHubApiError(
        `${formatQuestId(ref.repo, ref.number)} moved on to ${currentHead.slice(0, 7)} while its diff was read; refresh and send the review again`,
      );
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

function pendingReview(text: string, remaining: Array<RenderedFinding>): OpenedReview {
  const { id, node_id: nodeId } = parseJson(text, PendingReviewSchema, 'review');
  return { submitted: false, id, nodeId, remaining };
}

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
  // oxlint-disable-next-line unicorn/no-new-array -- one slot per item; the workers fill them by index
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
