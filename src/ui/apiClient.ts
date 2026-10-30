import {
  API_ROUTES,
  buildApiPath,
  isApiErrorResponse,
  type RequestBody,
  type ResponseBody,
  type RouteName,
  type RouteParams,
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
  body?: RequestBody<TName>;
  signal?: AbortSignal;
}

/** Calls a JSON route from the contract. Rejects with `ApiRequestError` on non-2xx responses. */
export async function apiRequest<TName extends JsonRouteName>(
  name: TName,
  options: ApiRequestOptions<TName>,
): Promise<ResponseBody<TName>> {
  const { method } = API_ROUTES[name];
  const response = await fetch(buildApiPath(name, options.params), {
    method,
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
