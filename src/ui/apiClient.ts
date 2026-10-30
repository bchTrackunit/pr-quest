import {
  API_ROUTES,
  buildApiPath,
  isApiErrorResponse,
  type ApproveRequest,
  type ApproveResponse,
  type HealthResponse,
  type ListAchievementsResponse,
  type ListQuestsResponse,
  type ListRunsResponse,
  type PlayerResponse,
  type PostReviewRequest,
  type PostReviewResponse,
  type RequestBody,
  type ResponseBody,
  type RouteName,
  type RouteParams,
  type RunResponse,
  type StartReviewRequest,
} from '../shared/api.ts';

type JsonRouteName = Exclude<RouteName, 'events'>;

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiRequestOptions<TName extends JsonRouteName> {
  params: RouteParams<TName>;
  query?: Record<string, string>;
  body?: RequestBody<TName>;
  signal?: AbortSignal;
}

/**
 * Calls a JSON route from the contract. Rejects with `ApiRequestError` on non-2xx responses.
 * Every POST is JSON, even without a body: the server rejects other content types.
 */
export async function apiRequest<TName extends JsonRouteName>(
  name: TName,
  options: ApiRequestOptions<TName>,
): Promise<ResponseBody<TName>> {
  const { method } = API_ROUTES[name];
  const isPost = method === 'POST';
  const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
  const response = await fetch(`${buildApiPath(name, options.params)}${search}`, {
    method,
    headers: isPost ? { 'Content-Type': 'application/json' } : undefined,
    body: isPost ? JSON.stringify(options.body ?? {}) : undefined,
    signal: options.signal,
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      throw new ApiRequestError(response.status, payload.error.code, payload.error.message);
    }
    throw new ApiRequestError(response.status, 'internal', `Request failed: ${response.status}`);
  }
  // The server is the other half of this contract; responses are not re-validated here.
  return payload as ResponseBody<TName>;
}

/** Turns any rejection into a message fit for the UI. */
export function describeError(reason: unknown): string {
  if (reason instanceof ApiRequestError && reason.code === 'notImplemented') {
    return 'The server does not support this yet.';
  }
  if (reason instanceof ApiRequestError && reason.code === 'headChanged') {
    return 'New commits were pushed to this PR. Re-check them before approving.';
  }
  return reason instanceof Error ? reason.message : String(reason);
}

export const eventsUrl = API_ROUTES.events.path;

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest('health', { params: {}, signal });
}

/** `refresh` bypasses the server's short-lived quest cache. */
export function fetchQuests(
  signal?: AbortSignal,
  options: { refresh?: boolean } = {},
): Promise<ListQuestsResponse> {
  return apiRequest('listQuests', {
    params: {},
    query: options.refresh ? { refresh: '1' } : undefined,
    signal,
  });
}

export function fetchRuns(signal?: AbortSignal): Promise<ListRunsResponse> {
  return apiRequest('listRuns', { params: {}, signal });
}

export function fetchRun(runId: string, signal?: AbortSignal): Promise<RunResponse> {
  return apiRequest('getRun', { params: { id: runId }, signal });
}

export function fetchPlayer(signal?: AbortSignal): Promise<PlayerResponse> {
  return apiRequest('getPlayer', { params: {}, signal });
}

export function fetchAchievements(signal?: AbortSignal): Promise<ListAchievementsResponse> {
  return apiRequest('listAchievements', { params: {}, signal });
}

export function startReview(questId: string, body: StartReviewRequest = {}): Promise<RunResponse> {
  return apiRequest('startReview', { params: { id: questId }, body });
}

/**
 * Only call after the player confirmed; the `confirm: true` flag is part of the contract.
 * `headSha` is the commit the player saw; the server refuses with `headChanged` if it moved on.
 */
export function approveQuest(
  questId: string,
  headSha: string,
  comment?: string,
): Promise<ApproveResponse> {
  const body: ApproveRequest = comment
    ? { confirm: true, headSha, body: comment }
    : { confirm: true, headSha };
  return apiRequest('approveQuest', { params: { id: questId }, body });
}

export function postRun(runId: string, body: PostReviewRequest = {}): Promise<PostReviewResponse> {
  return apiRequest('postRun', { params: { id: runId }, body });
}

export function discardRun(runId: string): Promise<RunResponse> {
  return apiRequest('discardRun', { params: { id: runId } });
}
