import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  API_ROUTES,
  type ApiErrorCode,
  type ApiErrorResponse,
  type HttpMethod,
  type ResponseBody,
  type RouteName,
  type RouteParams,
} from '../../shared/api.ts';
import { type AppConfig, LOOPBACK_HOSTNAMES } from './config.ts';
import { createStaticHandler, type StaticHandler } from './staticFiles.ts';

const MAX_BODY_BYTES = 1024 * 1024;

/** Extra fields of an error body beyond `code` and `message`. */
export type ApiErrorDetails = Omit<ApiErrorResponse['error'], 'code' | 'message'>;

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly details: ApiErrorDetails;

  public constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RouteContext<TName extends RouteName> {
  params: RouteParams<TName>;
  /** Parsed JSON body, or `undefined` when the request has none. Validate before use. */
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

type JsonRouteName = Exclude<RouteName, 'events'>;

export type RouteHandler<TName extends JsonRouteName> = (
  context: RouteContext<TName>,
) => ResponseBody<TName> | Promise<ResponseBody<TName>>;

/** Owns the response: writes SSE headers and keeps the connection open until the client leaves. */
export type EventsHandler = (context: RouteContext<'events'>) => void;

export type RouteHandlers = { [TName in JsonRouteName]?: RouteHandler<TName> } & {
  events?: EventsHandler;
};

export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * A route outside the JSON API, such as an OAuth sign-in redirect or its callback. The handler
 * writes the whole response; an `ApiError` it throws before writing is answered as JSON.
 */
export interface RawRoute {
  /** A POST must carry an allowed Origin, since its body needn't be JSON. */
  method: 'GET' | 'POST';
  /** The exact path, matched without the query string. It can't be a JSON API route. */
  path: string;
  /**
   * Skips the Origin and `Sec-Fetch-Site` checks, which a top-level navigation back from another
   * site fails, such as an OAuth callback from github.com. The Host is still checked, so the
   * handler must prove the request is genuine itself, for example with the OAuth `state`. Only a
   * GET route can be cross-site, and only in hosted mode.
   */
  crossSite?: boolean;
  handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface RouterOptions {
  /** Exact origins (`http://127.0.0.1:4318`) a browser may call from; any other Origin gets 403. */
  allowedOrigins?: ReadonlyArray<string>;
  /** Lower-cased host names the Host header may name, whatever its port. Defaults to loopback. */
  allowedHosts?: ReadonlyArray<string>;
  /** Routes answered whatever the Host header says, such as a load balancer's health check. */
  hostCheckExempt?: ReadonlyArray<RouteName>;
  /** Serves the built UI from this directory to GET and HEAD requests outside `/api`. */
  staticDir?: string;
  /** Answered before the JSON API and the built UI. */
  routes?: ReadonlyArray<RawRoute>;
  onUnexpectedError?: (error: unknown) => void;
}

export type TrustOptions = Required<
  Pick<RouterOptions, 'allowedOrigins' | 'allowedHosts' | 'hostCheckExempt'>
>;

/** The `127.0.0.1` and `localhost` origins of each port, e.g. the API and the UI. */
export function loopbackOrigins(ports: ReadonlyArray<number>): Array<string> {
  return ports.flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

export interface TrustedRequestOptions {
  /** Local mode only: also trust the UI dev server on `config.uiPort`, which proxies `/api` here. */
  devUiOrigin?: boolean;
}

/**
 * Who the router trusts for `config` once the server listens on `port`. Local mode trusts only
 * loopback names and its own origin, plus the UI dev server's in development. Hosted mode trusts
 * its public origin and allowed hosts, and answers `/api/health` on any Host so the platform can
 * check it by IP address.
 */
export function trustedRequests(
  config: AppConfig,
  port: number,
  options: TrustedRequestOptions = {},
): TrustOptions {
  if (config.mode === 'hosted') {
    return {
      allowedHosts: [...config.allowedHosts],
      allowedOrigins: [config.publicOrigin],
      hostCheckExempt: ['health'],
    };
  }
  return {
    allowedHosts: [...config.allowedHosts],
    allowedOrigins: loopbackOrigins(options.devUiOrigin ? [port, config.uiPort] : [port]),
    hostCheckExempt: [],
  };
}

interface CompiledRoute {
  name: RouteName;
  method: HttpMethod;
  pattern: RegExp;
  paramNames: Array<string>;
}

type JsonHandlerContext = Omit<RouteContext<RouteName>, 'params'> & {
  params: Record<string, string>;
};

const isRouteName = (value: string): value is RouteName => Object.hasOwn(API_ROUTES, value);

const COMPILED_ROUTES: Array<CompiledRoute> = Object.keys(API_ROUTES)
  .filter(isRouteName)
  .map((name) => {
    const { method, path } = API_ROUTES[name];
    const paramNames: Array<string> = [];
    const source = path.replace(/:(\w+)/g, (_match, paramName: string) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    return { name, method, pattern: new RegExp(`^${source}$`), paramNames };
  });

/** Builds the HTTP listener. Routes without a handler respond 501 so the contract stays complete. */
export function createRouter(
  handlers: RouteHandlers,
  options: RouterOptions = {},
): RequestListener {
  const trust: Trust = {
    allowedOrigins: new Set(options.allowedOrigins),
    allowedHosts: [...(options.allowedHosts ?? LOOPBACK_HOSTNAMES)],
    hostCheckExempt: COMPILED_ROUTES.filter(({ name }) => options.hostCheckExempt?.includes(name)),
  };
  const serveStatic =
    options.staticDir === undefined ? undefined : createStaticHandler(options.staticDir);
  const rawRoutes = compileRawRoutes(options.routes ?? []);
  return (req, res) => {
    handle({ handlers, rawRoutes, trust, serveStatic }, req, res).catch((error: unknown) => {
      if (error instanceof ApiError) {
        sendError(res, error.status, {
          ...error.details,
          code: error.code,
          message: error.message,
        });
        return;
      }
      options.onUnexpectedError?.(error);
      sendError(res, 500, { code: 'internal', message: 'Internal server error' });
    });
  };
}

interface Trust {
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlyArray<string>;
  hostCheckExempt: ReadonlyArray<CompiledRoute>;
}

interface Routing {
  handlers: RouteHandlers;
  rawRoutes: ReadonlyMap<string, RawRoute>;
  trust: Trust;
  serveStatic: StaticHandler | undefined;
}

const rawRouteKey = (method: string, path: string): string => `${method} ${path}`;

function compileRawRoutes(routes: ReadonlyArray<RawRoute>): ReadonlyMap<string, RawRoute> {
  const compiled = new Map<string, RawRoute>();
  for (const route of routes) {
    const key = rawRouteKey(route.method, route.path);
    if (!route.path.startsWith('/')) {
      throw new Error(`Raw route path "${route.path}" must start with /`);
    }
    if (matchRoute(route.method, route.path)) {
      throw new Error(`Raw route ${key} would shadow a JSON API route`);
    }
    if (compiled.has(key)) {
      throw new Error(`Raw route ${key} is registered twice`);
    }
    if (route.crossSite && route.method !== 'GET') {
      throw new Error(
        `Raw route ${key} can't be cross-site: only a GET may come from another site`,
      );
    }
    compiled.set(key, route);
  }
  return compiled;
}

async function handle(
  { handlers, rawRoutes, trust, serveStatic }: Routing,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  const raw = rawRoutes.get(rawRouteKey(method, url.pathname));
  if (raw) {
    if (raw.crossSite) {
      assertTrustedHost(req, trust.allowedHosts);
    } else {
      assertTrustedRequest(req, trust, false);
    }
    // A raw POST takes any body, so a missing Origin stands in for the JSON API's content-type check.
    if (method === 'POST' && req.headers.origin === undefined) {
      throw new ApiError(403, 'forbidden', 'POST requests must carry an Origin header');
    }
    await raw.handle(req, res);
    return;
  }
  if (serveStatic && !isApiPath(url.pathname) && (method === 'GET' || method === 'HEAD')) {
    // The UI's files are public and change nothing, so a link from another site may open them.
    assertTrustedHost(req, trust.allowedHosts);
    if (!(await serveStatic(req, res, url.pathname))) {
      throw new ApiError(404, 'notFound', `No file at ${url.pathname}`);
    }
    return;
  }

  const skipHostCheck = trust.hostCheckExempt.some(
    (route) => route.method === method && route.pattern.test(url.pathname),
  );
  assertTrustedRequest(req, trust, skipHostCheck);

  const match = matchRoute(method, url.pathname);
  if (!match) {
    throw new ApiError(404, 'notFound', `No route for ${req.method} ${url.pathname}`);
  }

  const changesState = isStateChanging(req.method);
  if (changesState && !isJsonContentType(req.headers['content-type'])) {
    throw new ApiError(415, 'badRequest', `${req.method} bodies must be application/json`);
  }

  const context: JsonHandlerContext = {
    params: match.params,
    body: changesState ? await readJsonBody(req) : undefined,
    req,
    res,
  };

  if (match.name === 'events') {
    if (!handlers.events) {
      throw notImplemented(match.name);
    }
    handlers.events(context);
    return;
  }

  // The route's own pattern produced `params`, so they always fit the handler keyed by that route.
  const handler = handlers[match.name] as ((context: JsonHandlerContext) => unknown) | undefined;
  if (!handler) {
    throw notImplemented(match.name);
  }
  sendJson(res, 200, await handler(context));
}

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
}

export function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  for (const route of COMPILED_ROUTES) {
    if (route.method !== method) {
      continue;
    }
    const groups = route.pattern.exec(pathname);
    if (!groups) {
      continue;
    }
    const params: Record<string, string> = {};
    route.paramNames.forEach((paramName, index) => {
      params[paramName] = decodeParam(groups[index + 1] ?? '');
    });
    return { name: route.name, params };
  }
  return undefined;
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'badRequest', 'Malformed path parameter');
  }
}

/**
 * Binding to 127.0.0.1 alone does not stop a web page from reaching the server. The Host check
 * stops DNS rebinding. The exact-origin and `Sec-Fetch-Site` checks stop pages on other origins,
 * including other localhost ports, which browsers count as same-site. `Sec-Fetch-Site` applies to
 * every method, because an `<img>` or `<script>` GET carries no Origin yet can still open a
 * session or spend the player's API quota.
 */
function assertTrustedRequest(req: IncomingMessage, trust: Trust, skipHostCheck: boolean): void {
  if (!skipHostCheck) {
    assertTrustedHost(req, trust.allowedHosts);
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !trust.allowedOrigins.has(origin)) {
    throw new ApiError(403, 'forbidden', 'Cross-origin requests are not allowed');
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new ApiError(403, 'forbidden', 'Cross-site requests are not allowed');
  }
}

/** Everything but GET must be JSON and same-origin; GET routes never change anything. */
function isStateChanging(method: string | undefined): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/** Browsers can only send JSON cross-origin after a CORS preflight, which this server never grants. */
function isJsonContentType(header: string | undefined): boolean {
  return header?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function assertTrustedHost(req: IncomingMessage, allowedHosts: ReadonlyArray<string>): void {
  if (!isAllowedHost(req.headers.host, allowedHosts)) {
    throw new ApiError(403, 'forbidden', `Host must be ${allowedHosts.join(' or ')}`);
  }
}

function isAllowedHost(host: string | undefined, allowedHosts: ReadonlyArray<string>): boolean {
  if (!host) {
    return false;
  }
  try {
    return allowedHosts.includes(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'badRequest', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'badRequest', 'Request body must be valid JSON');
  }
}

function notImplemented(name: RouteName): ApiError {
  return new ApiError(501, 'notImplemented', `Route "${name}" is not implemented yet`);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: ApiErrorResponse['error']): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body: ApiErrorResponse = { error };
  sendJson(res, status, body);
}
