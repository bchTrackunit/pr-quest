import {
  API_ROUTES,
  buildApiPath,
  isApiErrorResponse,
  type ApiKeyName,
  type ApproveRequest,
  type ApproveResponse,
  type AuthStatusResponse,
  type DecideFindingsRequest,
  type DeviceFlowResponse,
  type HealthResponse,
  type ListAchievementsResponse,
  type ListModelsResponse,
  type ListQuestsResponse,
  type ListRunsResponse,
  type PlayerResponse,
  type PostReviewRequest,
  type PostReviewResponse,
  type RequestBody,
  type ResponseBody,
  type ReviewProvider,
  type RouteName,
  type RouteParams,
  type RunResponse,
  type SettingsResponse,
  type StartReviewRequest,
  type UpdateSettingsRequest,
} from '../../shared/api.ts';

type JsonRouteName = Exclude<RouteName, 'events'>;

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly code: string;
  /** With `missingConfig`: the review provider that needs a key. */
  public readonly provider?: ReviewProvider;

  public constructor(status: number, code: string, message: string, provider?: ReviewProvider) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.provider = provider;
  }
}

function isReviewProvider(value: unknown): value is ReviewProvider {
  return value === 'cursor' || value === 'claude';
}

export interface ApiRequestOptions<TName extends JsonRouteName> {
  params: RouteParams<TName>;
  query?: Record<string, string>;
  body?: RequestBody<TName>;
  signal?: AbortSignal;
}

/**
 * Calls a JSON route from the contract. Rejects with `ApiRequestError` on non-2xx responses.
 * Every POST, PUT and DELETE is JSON, even without a body: the server rejects other content types.
 */
export async function apiRequest<TName extends JsonRouteName>(
  name: TName,
  options: ApiRequestOptions<TName>,
): Promise<ResponseBody<TName>> {
  const { method } = API_ROUTES[name];
  const isWrite = method !== 'GET';
  const search = options.query ? `?${new URLSearchParams(options.query).toString()}` : '';
  const response = await fetch(`${buildApiPath(name, options.params)}${search}`, {
    method,
    headers: isWrite ? { 'Content-Type': 'application/json' } : undefined,
    body: isWrite ? JSON.stringify(options.body ?? {}) : undefined,
    signal: options.signal,
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (isApiErrorResponse(payload)) {
      const { code, message, provider } = payload.error;
      throw new ApiRequestError(
        response.status,
        code,
        message,
        isReviewProvider(provider) ? provider : undefined,
      );
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

export function saveFindingDecisions(
  runId: string,
  body: DecideFindingsRequest,
): Promise<RunResponse> {
  return apiRequest('decideFindings', { params: { id: runId }, body });
}

export function discardRun(runId: string): Promise<RunResponse> {
  return apiRequest('discardRun', { params: { id: runId } });
}

export function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatusResponse> {
  return apiRequest('authStatus', { params: {}, signal });
}

/** Starts, or restarts, "Sign in with GitHub". */
export function startDeviceFlow(): Promise<DeviceFlowResponse> {
  return apiRequest('startDeviceFlow', { params: {} });
}

export function fetchDeviceFlow(signal?: AbortSignal): Promise<DeviceFlowResponse> {
  return apiRequest('getDeviceFlow', { params: {}, signal });
}

export function cancelDeviceFlow(): Promise<DeviceFlowResponse> {
  return apiRequest('cancelDeviceFlow', { params: {} });
}

/** Forgets the OAuth token; a logged-in gh CLI's token still works afterwards. */
export function signOut(): Promise<AuthStatusResponse> {
  return apiRequest('signOut', { params: {} });
}

export function fetchSettings(signal?: AbortSignal): Promise<SettingsResponse> {
  return apiRequest('getSettings', { params: {}, signal });
}

export function updateSettings(body: UpdateSettingsRequest): Promise<SettingsResponse> {
  return apiRequest('updateSettings', { params: {}, body });
}

export function setApiKey(name: ApiKeyName, value: string): Promise<SettingsResponse> {
  return apiRequest('setApiKey', { params: { name }, body: { value } });
}

export function removeApiKey(name: ApiKeyName): Promise<SettingsResponse> {
  return apiRequest('removeApiKey', { params: { name } });
}

export function fetchModels(
  provider: ReviewProvider,
  signal?: AbortSignal,
): Promise<ListModelsResponse> {
  return apiRequest('listModels', { params: {}, query: { provider }, signal });
}
