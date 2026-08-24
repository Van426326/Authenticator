export const GITHUB_API_BASE_URL = "https://api.github.com";

const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 256;

export interface GitHubCredentials {
  token: string;
}

export type GitHubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface GitHubRateLimit {
  limit?: number;
  remaining?: number;
  used?: number;
  reset?: number;
}

export interface GitHubResponseMeta {
  rateLimit: GitHubRateLimit;
  etag?: string;
  retryAfter?: number;
  /**
   * Value of the X-Accepted-GitHub-Permissions response header when present.
   * Downstream code can use this to distinguish "token lacks Contents write"
   * from other permission failures without embedding the raw message.
   */
  acceptedPermissions?: string;
}

export interface GitHubJsonResult<T> extends GitHubResponseMeta {
  value?: T;
  notModified: boolean;
}

export interface GitHubRequestOptions {
  etag?: string;
  maximumBytes?: number;
  query?: Record<string, string | number | boolean>;
}

export interface GitHubHttpErrorOptions {
  status: number;
  method: string;
  path: string;
  githubMessage?: string;
  documentationUrl?: string;
  rateLimit: GitHubRateLimit;
  retryAfter?: number;
  acceptedPermissions?: string;
}

export class GitHubHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly githubMessage?: string;
  readonly documentationUrl?: string;
  readonly rateLimit: GitHubRateLimit;
  readonly retryAfter?: number;
  readonly acceptedPermissions?: string;

  constructor(options: GitHubHttpErrorOptions) {
    const detail = options.githubMessage ? `: ${options.githubMessage}` : "";
    super(
      `GitHub ${options.method} failed with status ${options.status}${detail}`
    );
    this.name = "GitHubHttpError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.githubMessage = options.githubMessage;
    this.documentationUrl = options.documentationUrl;
    this.rateLimit = options.rateLimit;
    this.retryAfter = options.retryAfter;
    this.acceptedPermissions = options.acceptedPermissions;
  }
}

export class GitHubRedirectError extends Error {
  constructor() {
    super("GitHub API redirects are not allowed");
    this.name = "GitHubRedirectError";
  }
}

export class GitHubResponseTooLargeError extends Error {
  constructor() {
    super("GitHub API response exceeds the size limit");
    this.name = "GitHubResponseTooLargeError";
  }
}

export class GitHubMalformedResponseError extends Error {
  constructor() {
    super("GitHub API response is not valid JSON");
    this.name = "GitHubMalformedResponseError";
  }
}

function urlOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    throw new GitHubRedirectError();
  }
}

function decodeLenient(bytes: Uint8Array) {
  return new TextDecoder("utf-8").decode(bytes);
}

function combineChunks(chunks: Uint8Array[]) {
  let totalBytes = 0;
  for (const chunk of chunks) {
    totalBytes += chunk.byteLength;
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function parseRateLimit(headers: Headers): GitHubRateLimit {
  const read = (name: string) => {
    const value = headers.get(name);
    if (value === null) {
      return undefined;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };
  return {
    limit: read("x-ratelimit-limit"),
    remaining: read("x-ratelimit-remaining"),
    used: read("x-ratelimit-used"),
    reset: read("x-ratelimit-reset"),
  };
}

export function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  }
  return undefined;
}

export function validateOwner(value: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)
  ) {
    throw new Error("GitHub owner is invalid");
  }
}

export function validateRepository(value: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z0-9_.-]+$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("GitHub repository is invalid");
  }
}

function assertEncodable(value: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SEGMENT_LENGTH ||
    hasForbiddenChars(value) ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%")
  ) {
    throw new Error("GitHub path segment is invalid");
  }
}

export function encodePathSegment(value: string) {
  assertEncodable(value);
  if (value.includes("/")) {
    throw new Error("GitHub path segment is invalid");
  }
  return encodeURIComponent(value);
}

export function encodeBranchRef(value: string) {
  assertEncodable(value);
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("%2F");
}

function hasForbiddenChars(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) {
      return true;
    }
  }
  return false;
}

function assertSafePathSegment(segment: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error("GitHub API path is invalid");
  }
  if (decoded === "." || decoded === "..") {
    throw new Error("GitHub API path is invalid");
  }
}

export function assertGitHubPath(path: string) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > MAX_PATH_LENGTH ||
    hasForbiddenChars(path) ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new Error("GitHub API path is invalid");
  }
  for (const segment of path.split("/")) {
    assertSafePathSegment(segment);
  }
}

function buildQueryString(
  query: Record<string, string | number | boolean> | undefined
) {
  if (query === undefined) {
    return "";
  }
  const params = new URLSearchParams();
  for (const key of Object.keys(query)) {
    if (key.length === 0) {
      throw new Error("GitHub query key is invalid");
    }
    const value = query[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error("GitHub query value is invalid");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("GitHub query value is invalid");
    }
    params.append(key, String(value));
  }
  return params.toString();
}

export function repoPath(owner: string, repository: string, suffix = "") {
  validateOwner(owner);
  validateRepository(repository);
  const cleanSuffix = suffix.replace(/^\/+/, "");
  const encodedSuffix = cleanSuffix ? `/${cleanSuffix}` : "";
  const path = `/repos/${owner}/${repository}${encodedSuffix}`;
  assertGitHubPath(path);
  return path;
}

export type GitHubErrorKind =
  | "network"
  | "redirect"
  | "malformed"
  | "tokenInvalid"
  | "permissionDenied"
  | "rateLimited"
  | "resourceNotFound"
  | "conflict"
  | "unprocessable"
  | "serverError"
  | "unknown";

export interface GitHubErrorClassification {
  kind: GitHubErrorKind;
  retryable: boolean;
  rateLimited: boolean;
}

export function classifyGitHubError(error: unknown): GitHubErrorClassification {
  if (error instanceof GitHubHttpError) {
    if (error.status === 401) {
      return { kind: "tokenInvalid", retryable: false, rateLimited: false };
    }
    if (error.status === 429) {
      return { kind: "rateLimited", retryable: true, rateLimited: true };
    }
    if (error.status === 403) {
      const rateLimitExhausted = error.rateLimit.remaining === 0;
      const messageMentionsRateLimit =
        error.githubMessage?.toLowerCase().includes("rate limit") ?? false;
      const hasRetryAfter = error.retryAfter !== undefined;
      if (rateLimitExhausted || messageMentionsRateLimit || hasRetryAfter) {
        return { kind: "rateLimited", retryable: true, rateLimited: true };
      }
      return { kind: "permissionDenied", retryable: false, rateLimited: false };
    }
    if (error.status === 404) {
      return { kind: "resourceNotFound", retryable: false, rateLimited: false };
    }
    if (error.status === 409) {
      return { kind: "conflict", retryable: true, rateLimited: false };
    }
    if (error.status === 422) {
      return { kind: "unprocessable", retryable: true, rateLimited: false };
    }
    if (error.status >= 500) {
      return { kind: "serverError", retryable: true, rateLimited: false };
    }
    return { kind: "unknown", retryable: false, rateLimited: false };
  }
  if (error instanceof GitHubRedirectError) {
    return { kind: "redirect", retryable: false, rateLimited: false };
  }
  if (
    error instanceof GitHubMalformedResponseError ||
    error instanceof GitHubResponseTooLargeError
  ) {
    return { kind: "malformed", retryable: false, rateLimited: false };
  }
  if (error instanceof TypeError) {
    return { kind: "network", retryable: true, rateLimited: false };
  }
  return { kind: "unknown", retryable: false, rateLimited: false };
}

const REDACTED = "[REDACTED]";

export class GitHubApiClient {
  private readonly token: string;
  private readonly authorization: string;
  private readonly fetch: GitHubFetch;
  private lastMeta?: GitHubResponseMeta;

  constructor(
    credentials: GitHubCredentials,
    fetchImpl: GitHubFetch = (input, init) => globalThis.fetch(input, init)
  ) {
    if (
      typeof credentials.token !== "string" ||
      credentials.token.length === 0 ||
      hasForbiddenChars(credentials.token)
    ) {
      throw new Error("GitHub token is invalid");
    }
    this.token = credentials.token;
    this.authorization = `Bearer ${credentials.token}`;
    this.fetch = fetchImpl;
  }

  /**
   * Read-only access to the response metadata (rate limit, etag, retry-after,
   * accepted permissions) of the most recent request. Safe to persist: it
   * contains no request bodies and no secret material.
   */
  getLastResponseMeta(): GitHubResponseMeta | undefined {
    if (this.lastMeta === undefined) {
      return undefined;
    }
    return {
      ...this.lastMeta,
      rateLimit: { ...this.lastMeta.rateLimit },
    };
  }

  private redact(value: string) {
    return value
      .split(`Bearer ${this.token}`)
      .join(REDACTED)
      .split(this.token)
      .join(REDACTED);
  }

  getJson<T>(
    path: string,
    options: GitHubRequestOptions = {}
  ): Promise<GitHubJsonResult<T>> {
    return this.request<T>("GET", path, undefined, options);
  }

  postJson<T>(
    path: string,
    body: unknown,
    options: GitHubRequestOptions = {}
  ): Promise<GitHubJsonResult<T>> {
    return this.request<T>("POST", path, body, options);
  }

  patchJson<T>(
    path: string,
    body: unknown,
    options: GitHubRequestOptions = {}
  ): Promise<GitHubJsonResult<T>> {
    return this.request<T>("PATCH", path, body, options);
  }

  putJson<T>(
    path: string,
    body: unknown,
    options: GitHubRequestOptions = {}
  ): Promise<GitHubJsonResult<T>> {
    return this.request<T>("PUT", path, body, options);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options: GitHubRequestOptions
  ): Promise<GitHubJsonResult<T>> {
    assertGitHubPath(path);
    if (
      options.maximumBytes !== undefined &&
      (typeof options.maximumBytes !== "number" ||
        !Number.isFinite(options.maximumBytes) ||
        options.maximumBytes <= 0)
    ) {
      throw new Error("GitHub maximumBytes is invalid");
    }
    const queryString = buildQueryString(options.query);
    const url = `${GITHUB_API_BASE_URL}${path}${
      queryString ? `?${queryString}` : ""
    }`;
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Authenticator-Sync/1",
    });
    if (options.etag) {
      headers.set("If-None-Match", options.etag);
    }
    headers.set("Authorization", this.authorization);

    const response = await this.fetch.call(globalThis, url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      redirect: "manual",
    });

    if (
      !response.status ||
      response.type === "opaque" ||
      response.redirected ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304) ||
      (response.url && urlOrigin(response.url) !== urlOrigin(url))
    ) {
      throw new GitHubRedirectError();
    }

    const rateLimit = parseRateLimit(response.headers);
    const retryAfter = parseRetryAfter(response.headers);
    const etag = response.headers.get("etag") || undefined;
    const acceptedPermissions =
      response.headers.get("x-accepted-github-permissions") || undefined;
    const meta: GitHubResponseMeta = {
      rateLimit,
      etag,
      retryAfter,
      acceptedPermissions,
    };
    this.lastMeta = meta;

    if (response.status === 304) {
      return { ...meta, notModified: true };
    }

    if (response.status >= 400) {
      const text = await this.readBody(
        response,
        MAX_ERROR_BODY_BYTES,
        false,
        true
      );
      const parsed = tryParseJson(text);
      throw new GitHubHttpError({
        status: response.status,
        method,
        path,
        githubMessage:
          typeof parsed?.message === "string"
            ? this.redact(parsed.message)
            : this.redact(trimTo(text, 300)),
        documentationUrl:
          typeof parsed?.documentation_url === "string"
            ? this.redact(parsed.documentation_url)
            : undefined,
        rateLimit,
        retryAfter,
        acceptedPermissions,
      });
    }

    const text = await this.readBody(
      response,
      options.maximumBytes ?? DEFAULT_MAX_JSON_BYTES,
      true
    );
    if (text === "") {
      return { ...meta, notModified: false };
    }
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw new GitHubMalformedResponseError();
    }
    return { ...meta, value, notModified: false };
  }

  private async readBody(
    response: Response,
    maximumBytes: number,
    strictDecode: boolean,
    truncateOnExceed = false
  ) {
    const contentLength = response.headers.get("Content-Length");
    const declaredLength = contentLength === null ? NaN : Number(contentLength);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maximumBytes &&
      !truncateOnExceed
    ) {
      await response.body?.cancel();
      throw new GitHubResponseTooLargeError();
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maximumBytes) {
        if (truncateOnExceed) {
          return bytesToText(bytes.slice(0, maximumBytes), strictDecode);
        }
        throw new GitHubResponseTooLargeError();
      }
      return bytesToText(bytes, strictDecode);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (done) {
        continue;
      }
      const chunk = result.value;
      if (!chunk) {
        throw new Error("GitHub API response stream returned an empty chunk");
      }
      const remaining = maximumBytes - totalBytes;
      if (remaining <= 0) {
        await reader.cancel();
        if (truncateOnExceed) {
          break;
        }
        throw new GitHubResponseTooLargeError();
      }
      if (chunk.byteLength > remaining) {
        if (truncateOnExceed) {
          chunks.push(chunk.slice(0, remaining));
          totalBytes += remaining;
        } else {
          totalBytes += chunk.byteLength;
        }
        await reader.cancel();
        if (truncateOnExceed) {
          break;
        }
        throw new GitHubResponseTooLargeError();
      }
      totalBytes += chunk.byteLength;
      chunks.push(chunk);
    }
    return bytesToText(combineChunks(chunks), strictDecode);
  }
}

function bytesToText(bytes: Uint8Array, strictDecode: boolean) {
  if (strictDecode) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubMalformedResponseError();
    }
  }
  return decodeLenient(bytes);
}

function tryParseJson(
  text: string
): { message?: unknown; documentation_url?: unknown } | undefined {
  if (text === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as { message?: unknown; documentation_url?: unknown };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function trimTo(value: string, maximumLength: number) {
  const trimmed = value.trim();
  return trimmed.length <= maximumLength
    ? trimmed
    : `${trimmed.slice(0, maximumLength)}...`;
}
