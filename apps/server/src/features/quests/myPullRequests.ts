import { z } from 'zod';

import type {
  CiState,
  MergeState,
  MyPullRequest,
  MyPullRequestReviewState,
  RepoRef,
} from '@pr-quest/contract/api';
import type { AuthorObservation } from '../game/index.ts';
import { GitHubApiError } from '../../platform/githubApi.ts';
import { difficultyFor, formatQuestId } from './quests.ts';

/** PRs per page; each brings up to 100 review threads. */
export const MY_PRS_PAGE_SIZE = 50;
/** The open list stops here, with a warning. */
export const MAX_OPEN_PRS = 500;
export const MAX_THREADS = 100;

/** The error type GitHub gives PRs in an organization that hasn't approved the OAuth app. */
const FORBIDDEN = 'FORBIDDEN';
const CHANGES_REQUESTED = 'CHANGES_REQUESTED';
const APPROVED = 'APPROVED';

const MINE_FIELDS = `
  number title url createdAt updatedAt state mergedAt
  repository { owner { login } name }
  headRefName baseRefName headRefOid isDraft additions deletions changedFiles
  author { login ... on User { name } }
  authorAssociation isCrossRepository
  mergeable mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  latestOpinionatedReviews(first: 100) { nodes { state author { login } } }
  approvals: reviews(first: 20, states: [APPROVED]) { nodes { submittedAt author { login } } }
  reviewThreads(first: ${MAX_THREADS}) { totalCount nodes { id isResolved } }`;

/** Only merged and closed PRs need to know about change requests that were later dismissed. */
const DONE_FIELDS = `
  ...Mine
  changesRequested: reviews(states: [CHANGES_REQUESTED]) { totalCount }
  dismissals: timelineItems(first: 50, itemTypes: [REVIEW_DISMISSED_EVENT]) {
    nodes { ... on ReviewDismissedEvent { previousReviewState } }
  }`;

const nodesOf = <TSchema extends z.ZodType>(schema: TSchema) =>
  z.object({ nodes: z.array(schema.nullish()) });

const LoginSchema = z.object({ login: z.string() }).nullish();

const MineSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  state: z.string(),
  mergedAt: z.string().nullish(),
  repository: z.object({ owner: z.object({ login: z.string() }), name: z.string() }),
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
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  commits: nodesOf(
    z.object({
      commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullish() }),
    }),
  ).nullish(),
  latestOpinionatedReviews: nodesOf(z.object({ state: z.string(), author: LoginSchema })).nullish(),
  approvals: nodesOf(
    z.object({ submittedAt: z.string().nullish(), author: LoginSchema }),
  ).nullish(),
  reviewThreads: z
    .object({
      totalCount: z.number().int().nonnegative(),
      nodes: z.array(z.object({ id: z.string(), isResolved: z.boolean() }).nullish()),
    })
    .nullish(),
  changesRequested: z.object({ totalCount: z.number().int().nonnegative() }).nullish(),
  dismissals: nodesOf(z.object({ previousReviewState: z.string().nullish() })).nullish(),
});

type MineNode = z.infer<typeof MineSchema>;

const PageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() });

const ConnectionSchema = z.object({
  pageInfo: PageInfoSchema,
  nodes: z.array(z.unknown()),
});

const PageResponseSchema = z.object({
  data: z
    .object({
      viewer: z
        .object({
          login: z.string(),
          open: ConnectionSchema.nullish(),
          done: ConnectionSchema.nullish(),
        })
        .nullish(),
    })
    .nullish(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        type: z.string().nullish(),
        path: z.array(z.union([z.string(), z.number()])).nullish(),
      }),
    )
    .nullish(),
});

/** One of the player's PRs as GitHub reported it, with GitHub's own words turned into ours. */
export interface AuthoredPullRequest {
  id: string;
  title: string;
  repo: RepoRef;
  number: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** `OPEN`, `MERGED` or `CLOSED`. */
  state: string;
  mergedAt?: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  authorLogin?: string;
  authorName?: string;
  authorAssociation?: string;
  isCrossRepository?: boolean;
  reviewState: MyPullRequestReviewState;
  ciState: CiState;
  mergeState: MergeState;
  resolvedThreads: Array<string>;
  unresolvedThreads: number;
  moreThreads: boolean;
  /** Approvals, oldest first. */
  approvals: Array<{ login?: string; submittedAt: string }>;
  /** Only read for merged and closed PRs. */
  everChangesRequested?: boolean;
}

export type MyPrsPart = 'open' | 'done';

export interface MyPullRequestsPageQuery {
  query: string;
  variables: Record<string, string | number>;
}

/**
 * One page of the player's open PRs and, newest-updated first, their merged and closed ones. A
 * cursor continues that part; a part left out is not read.
 */
export function buildMyPullRequestsQuery(parts: {
  open?: { after?: string };
  done?: { after?: string };
}): MyPullRequestsPageQuery {
  const variables: Record<string, string | number> = { first: MY_PRS_PAGE_SIZE };
  const params = ['$first: Int!'];
  const connections: Array<string> = [];
  if (parts.open) {
    params.push('$openAfter: String');
    if (parts.open.after) {
      variables.openAfter = parts.open.after;
    }
    connections.push(
      '    open: pullRequests(first: $first, after: $openAfter, states: [OPEN], orderBy: { field: CREATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ...Mine } }',
    );
  }
  if (parts.done) {
    params.push('$doneAfter: String');
    if (parts.done.after) {
      variables.doneAfter = parts.done.after;
    }
    connections.push(
      '    done: pullRequests(first: $first, after: $doneAfter, states: [MERGED, CLOSED], orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ...MineDone } }',
    );
  }
  const fragments = [`fragment Mine on PullRequest {${MINE_FIELDS}\n}`];
  if (parts.done) {
    fragments.push(`fragment MineDone on PullRequest {${DONE_FIELDS}\n}`);
  }
  return {
    query: [
      `query(${params.join(', ')}) {`,
      '  viewer {',
      '    login',
      ...connections,
      '  }',
      '}',
      ...fragments,
    ].join('\n'),
    variables,
  };
}

/** A page of one part: the PRs read, how many couldn't be, and where the next page starts. */
export interface MyPrsPagePart {
  pullRequests: Array<AuthoredPullRequest>;
  /** Nodes GitHub returned no readable PR for. */
  skipped: number;
  /** Errors other than `FORBIDDEN`; a restricted organization can never pay, others may later. */
  otherErrors: number;
  nextCursor?: string;
}

export interface MyPrsPage {
  viewerLogin: string;
  open?: MyPrsPagePart;
  done?: MyPrsPagePart;
}

/** Throws when the response has no data at all (bad query, auth, rate limit). */
export function parseMyPullRequestsPage(text: string): MyPrsPage {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GitHubApiError('Unexpected GitHub GraphQL response: not JSON');
  }
  const parsed = PageResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new GitHubApiError(
      `Unexpected GitHub GraphQL response: ${parsed.error.issues.at(0)?.message ?? 'invalid shape'}`,
    );
  }
  const errors = parsed.data.errors ?? [];
  const viewer = parsed.data.data?.viewer;
  if (!viewer) {
    throw new GitHubApiError(
      `GitHub GraphQL returned no data: ${errors.at(0)?.message ?? 'no reason'}`,
      { body: text },
    );
  }
  const page: MyPrsPage = { viewerLogin: viewer.login };
  if (viewer.open) {
    page.open = parsePart('open', viewer.open, errors);
  }
  if (viewer.done) {
    page.done = parsePart('done', viewer.done, errors);
  }
  return page;
}

/** Fields only the card shows; an error on one never holds back author XP. */
const DISPLAY_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'commits',
  'mergeable',
  'mergeStateStatus',
  'latestOpinionatedReviews',
]);

type GraphQLError = NonNullable<z.infer<typeof PageResponseSchema>['errors']>[number];

function parsePart(
  part: MyPrsPart,
  connection: z.infer<typeof ConnectionSchema>,
  errors: ReadonlyArray<GraphQLError>,
): MyPrsPagePart {
  const partErrors = errors.filter(
    (error) => error.path?.[0] === 'viewer' && error.path[1] === part,
  );
  const fieldsWithErrors = (index: number): Set<string> =>
    new Set(
      partErrors.flatMap((error) =>
        error.path?.[3] === index && typeof error.path[4] === 'string' ? [error.path[4]] : [],
      ),
    );
  const pullRequests: Array<AuthoredPullRequest> = [];
  let skipped = 0;
  connection.nodes.forEach((raw, index) => {
    const node = MineSchema.safeParse(raw);
    if (node.success) {
      pullRequests.push(toAuthored(node.data, fieldsWithErrors(index)));
    } else {
      skipped++;
    }
  });
  const result: MyPrsPagePart = {
    pullRequests,
    skipped,
    otherErrors: partErrors.filter(
      (error) =>
        error.type !== FORBIDDEN &&
        !(typeof error.path?.[4] === 'string' && DISPLAY_ONLY_FIELDS.has(error.path[4])),
    ).length,
  };
  const cursor = connection.pageInfo.endCursor;
  if (connection.pageInfo.hasNextPage && cursor) {
    result.nextCursor = cursor;
  }
  return result;
}

function toAuthored(node: MineNode, failedFields: ReadonlySet<string>): AuthoredPullRequest {
  const repo = { owner: node.repository.owner.login, name: node.repository.name };
  const threads = present(node.reviewThreads?.nodes ?? []);
  const pr: AuthoredPullRequest = {
    id: formatQuestId(repo, node.number),
    title: node.title,
    repo,
    number: node.number,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    state: node.state,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    headRefOid: node.headRefOid,
    isDraft: node.isDraft,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    reviewState: reviewStateOf(present(node.latestOpinionatedReviews?.nodes ?? [])),
    ciState: failedFields.has('commits') ? 'unknown' : ciStateOf(node.commits),
    mergeState:
      failedFields.has('mergeable') || failedFields.has('mergeStateStatus')
        ? 'unknown'
        : mergeStateOf(node.mergeable, node.mergeStateStatus),
    resolvedThreads: threads.filter((thread) => thread.isResolved).map((thread) => thread.id),
    unresolvedThreads: threads.filter((thread) => !thread.isResolved).length,
    moreThreads: (node.reviewThreads?.totalCount ?? 0) > threads.length,
    approvals: present(node.approvals?.nodes ?? []).flatMap((review) =>
      review.submittedAt ? [{ login: review.author?.login, submittedAt: review.submittedAt }] : [],
    ),
  };
  if (node.mergedAt) {
    pr.mergedAt = node.mergedAt;
  }
  if (node.author?.login) {
    pr.authorLogin = node.author.login;
  }
  if (node.author?.name) {
    pr.authorName = node.author.name;
  }
  if (node.authorAssociation) {
    pr.authorAssociation = node.authorAssociation;
  }
  if (typeof node.isCrossRepository === 'boolean') {
    pr.isCrossRepository = node.isCrossRepository;
  }
  if (node.changesRequested || node.dismissals) {
    pr.everChangesRequested =
      (node.changesRequested?.totalCount ?? 0) > 0 ||
      present(node.dismissals?.nodes ?? []).some(
        (event) => event.previousReviewState === CHANGES_REQUESTED,
      );
  }
  return pr;
}

const present = <TNode>(nodes: ReadonlyArray<TNode | null | undefined>): Array<TNode> =>
  nodes.flatMap((node) => node ?? []);

/** Any change request wins over approvals; `latestOpinionatedReviews` ignores later comments. */
export function reviewStateOf(reviews: ReadonlyArray<{ state: string }>): MyPullRequestReviewState {
  if (reviews.some((review) => review.state === CHANGES_REQUESTED)) {
    return 'changesRequested';
  }
  return reviews.some((review) => review.state === APPROVED) ? 'approved' : 'waiting';
}

/** No rollup on the head commit means it has no checks; no head commit at all is unknown. */
export function ciStateOf(commits: MineNode['commits']): CiState {
  const last = commits?.nodes.at(-1);
  if (!last) {
    return 'unknown';
  }
  const state = last.commit.statusCheckRollup?.state;
  switch (state) {
    case undefined:
      return 'none';
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'running';
    default:
      return 'unknown';
  }
}

/** Conflicts first; `BEHIND` only when the repo requires up-to-date branches. */
export function mergeStateOf(
  mergeable: string | null | undefined,
  status: string | null | undefined,
): MergeState {
  if (mergeable === 'CONFLICTING' || status === 'DIRTY') {
    return 'conflicting';
  }
  if (status === 'BEHIND') {
    return 'behind';
  }
  if (!mergeable || mergeable === 'UNKNOWN' || !status || status === 'UNKNOWN') {
    return 'unknown';
  }
  return 'clean';
}

export function toMyPullRequest(pr: AuthoredPullRequest): MyPullRequest {
  const diffStats = {
    fileCount: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
  };
  const card: MyPullRequest = {
    id: pr.id,
    title: pr.title,
    repo: pr.repo,
    number: pr.number,
    githubUrl: pr.url,
    author: {
      name: pr.authorName ?? pr.authorLogin ?? 'you',
      ...(pr.authorLogin ? { githubLogin: pr.authorLogin } : {}),
    },
    sourceBranch: pr.headRefName,
    targetBranch: pr.baseRefName,
    headSha: pr.headRefOid,
    isDraft: pr.isDraft,
    diffStats,
    difficulty: difficultyFor(diffStats),
    openedAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    reviewState: pr.reviewState,
    ciState: pr.ciState,
    mergeState: pr.mergeState,
    unresolvedThreads: pr.unresolvedThreads,
    needsMyAction: pr.reviewState === 'changesRequested' || pr.unresolvedThreads > 0,
  };
  if (pr.moreThreads) {
    card.moreThreads = true;
  }
  if (pr.authorAssociation) {
    card.authorAssociation = pr.authorAssociation;
  }
  if (pr.isCrossRepository !== undefined) {
    card.isCrossRepository = pr.isCrossRepository;
  }
  return card;
}

/**
 * The author events a PR shows: its merge, its earliest approval by someone other than the
 * player, and each resolved thread. The game decides which of them pay.
 */
export function authorObservationsOf(
  pr: AuthoredPullRequest,
  viewerLogin: string | undefined,
): Array<AuthorObservation> {
  const tier = difficultyFor({
    fileCount: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
  });
  const observations: Array<AuthorObservation> = [];
  if (pr.state === 'MERGED' && pr.mergedAt) {
    observations.push({
      kind: 'merged',
      prId: pr.id,
      mergedAt: pr.mergedAt,
      tier,
      resolvedThreads: pr.resolvedThreads.length,
      everChangesRequested: pr.everChangesRequested ?? pr.reviewState === 'changesRequested',
      createdAt: pr.createdAt,
    });
  }
  const viewer = viewerLogin?.toLowerCase();
  const firstApproval = pr.approvals
    .filter((review) => review.login?.toLowerCase() !== viewer)
    .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt))
    .at(0);
  if (firstApproval) {
    observations.push({
      kind: 'approved',
      prId: pr.id,
      submittedAt: firstApproval.submittedAt,
      tier,
    });
  }
  for (const threadId of pr.resolvedThreads) {
    observations.push({
      kind: 'threadResolved',
      prId: pr.id,
      threadId,
      tier,
      prCreatedAt: pr.createdAt,
    });
  }
  return observations;
}

/** Needs my action first, then waiting on others, then the rest; oldest first within each. */
export function sortMyPullRequests(
  pullRequests: ReadonlyArray<MyPullRequest>,
): Array<MyPullRequest> {
  const rank = (pr: MyPullRequest): number => {
    if (pr.needsMyAction) {
      return 0;
    }
    return pr.reviewState === 'waiting' ? 1 : 2;
  };
  return [...pullRequests].sort(
    (left, right) =>
      rank(left) - rank(right) || Date.parse(left.openedAt) - Date.parse(right.openedAt),
  );
}
