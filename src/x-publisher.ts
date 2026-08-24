/**
 * Publishing to X, in Node.
 *
 * This module owns OAuth1 signing, image multipart upload, chunked video
 * upload, processing-status polling and tweet creation. All impure operations
 * are injected: HTTP transport, file reads, stat, sleep, nonce and clock. That
 * makes the complete media state machine testable against fakes rather than X.
 *
 * The protocol rules below are load-bearing:
 *
 *   - For the v2 JSON endpoint the signature base string contains ONLY the
 *     oauth_* parameters. The JSON body is NOT signed, and neither is a
 *     multipart body. Form-encoded v1.1 parameters and query parameters ARE.
 *   - The media path is chosen from the EXTENSION, and the declared MIME comes
 *     from the same map, so the classifier and the Content-Type cannot drift.
 *   - 5 MB is X's IMAGE cap; a video's ceiling is 512 MB up the chunked path.
 *     One cap for both rejected every clip before a byte moved.
 *   - A `filename=` value is a header built by interpolation, so a name
 *     carrying CR, LF or a quote is header injection into X's upload endpoint.
 *   - A tweet is never created unless the media is up and processed. A post
 *     that silently loses the video it was written around is worse than a post
 *     that does not go out.
 *   - Transcoding is asynchronous and X says when to look again, so STATUS
 *     polling is bounded in both count and total wait: an upload that never
 *     finishes has to become a failed publish with a reason, not a worker
 *     parked forever.
 *   - Errors are one sanitized line. Credentials never appear in them.
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// The shape of the outside world
// ---------------------------------------------------------------------------

export interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** One request, fully described. The transport does nothing but send it. */
export interface XRequestSpec {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** Present only when the request carries a query string. */
  query?: Record<string, string>;
  body?: string | Uint8Array;
}

/**
 * A non-2xx is a RESPONSE, not an exception: every caller here handles failure
 * the same way, and a transport that throws for a 413 hides the 413.
 */
export interface XResponse {
  status: number;
  body: string;
}

export interface XPublisherDeps {
  credentials: XCredentials;
  request(spec: XRequestSpec): Promise<XResponse>;
  readFile(path: string): Promise<Uint8Array>;
  /** Read at most `length` bytes starting at `offset`. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number }>;
  sleep(ms: number): Promise<void>;
  /** One unpredictable value per request. In production, random hex. */
  nonce(): string;
  /** Epoch milliseconds, as `Date.now` returns. */
  now(): number;
}

export interface XPublishInput {
  text: string;
  /** An image or video on disk, or null for a text-only post. */
  mediaPath?: string | null;
  /** Accessibility description attached to uploaded media, capped by X. */
  altText?: string | null;
}

export interface XPublishResult {
  ok: boolean;
  id: string | null;
  url: string | null;
  mediaId: string | null;
  /** One sanitized line when `ok` is false, null otherwise. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Endpoints and limits
// ---------------------------------------------------------------------------

/** v1.1, because v2 has no media upload. */
export const MEDIA_URL = "https://upload.x.com/1.1/media/upload.json";
export const METADATA_URL = "https://api.x.com/1.1/media/metadata/create.json";
export const TWEETS_URL = "https://api.x.com/2/tweets";

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
/** X caps a segment at 5 MB. 4 MiB leaves room and keeps the arithmetic obvious. */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * What a stalled transcode is allowed to cost.
 *
 * X tells us when to look again, and these bound what it can ask for: an
 * upload that never finishes has to become a failed publish with a reason, not
 * a worker parked until something else kills it.
 */
const MAX_STATUS_POLLS = 40;
const MAX_PROCESSING_WAIT_MS = 300_000;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * The extension decides the path, so it decides the declared type too.
 *
 * A MAP, not a two-way guess: declaring everything-that-is-not-a-PNG as JPEG
 * sent GIFs and WebPs up announced as something they are not, which X
 * sometimes sniffed past and sometimes rejected — a media failure on a file
 * that is fine, at the moment a post is due.
 *
 * Kept to the same list as ALLOWED_VIDEO_TYPES/ALLOWED_IMAGE_TYPES in
 * `src/attachments.ts`, which is this rule on the upload side.
 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export type MediaKind = "image" | "video";

// ---------------------------------------------------------------------------
// OAuth 1.0a
// ---------------------------------------------------------------------------

/**
 * RFC 3986 percent-encoding, which is NOT `encodeURIComponent`.
 *
 * `encodeURIComponent` leaves `!*'()` alone; RFC 3986 reserves them, and a
 * signature computed with them raw is one X answers with 401. Unreserved is
 * exactly `A-Za-z0-9-._~`.
 */
export function percentEncode(value: string | number): string {
  return encodeURIComponent(String(value ?? "")).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface Oauth1Args {
  method: string;
  url: string;
  credentials: XCredentials;
  /**
   * The parameters that are part of the signature — form fields for an
   * `x-www-form-urlencoded` POST, the query for a GET, and NOTHING for a JSON
   * or multipart body. Signing a JSON body produces a signature that is
   * internally consistent and that X rejects.
   */
  params?: Record<string, string>;
  nonce: string;
  /** Epoch SECONDS, which is what oauth_timestamp is. */
  timestamp: number;
}

/** The `Authorization: OAuth …` value for one request. Pure. */
export function oauth1Header(args: Oauth1Args): string {
  const { method, url, credentials, params, nonce, timestamp } = args;

  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };

  const signed: Record<string, string> = { ...(params ?? {}), ...oauth };
  const normalized = Object.keys(signed)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(signed[key])}`)
    .join("&");
  const base = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(normalized),
  ].join("&");

  // The secrets sign the request; they are never in it.
  const key = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessSecret)}`;
  const header: Record<string, string> = {
    ...oauth,
    oauth_signature: createHmac("sha1", key).update(base, "utf8").digest("base64"),
  };

  // The signature is percent-encoded in place — a raw `+` or `/` here is a 401.
  return `OAuth ${Object.keys(header)
    .sort()
    .map((name) => `${percentEncode(name)}="${percentEncode(header[name])}"`)
    .join(", ")}`;
}

// ---------------------------------------------------------------------------
// Naming media
// ---------------------------------------------------------------------------

/**
 * The last path segment.
 *
 * `/` only: a backslash is an ordinary character in a POSIX file name, and
 * treating it as a separator would silently truncate `back\slash.png`.
 */
function basenameOf(path: string | null | undefined): string {
  const text = String(path ?? "");
  return text.slice(text.lastIndexOf("/") + 1);
}

/** The lowercased extension, or "" — alphanumeric only, so it is inert. */
function extensionOf(path: string | null | undefined): string {
  const match = /\.[A-Za-z0-9]+$/.exec(basenameOf(path));
  return match ? match[0].toLowerCase() : "";
}

/** image, video, or null — from the extension, never from the bytes. */
export function mediaKindFor(path: string | null | undefined): MediaKind | null {
  const ext = extensionOf(path);
  if (ext in VIDEO_TYPES) return "video";
  if (ext in IMAGE_TYPES) return "image";
  return null;
}

/** The Content-Type to declare, from the same map as the classification. */
export function mediaMimeFor(path: string | null | undefined): string | null {
  const ext = extensionOf(path);
  return VIDEO_TYPES[ext] ?? IMAGE_TYPES[ext] ?? null;
}

/**
 * A file name that cannot break out of a multipart header.
 *
 * `filename="<name>"` is a HEADER value built by interpolation, so a name
 * carrying CR, LF, a quote or a backslash ends the header early and everything
 * after it is read as more headers or another part — header injection into X's
 * upload endpoint, out of a name an operator types in an upload dialog. A path
 * is one name by the time it is a `filename=` value, so it is reduced to its
 * basename first.
 */
export function safeFilename(name: string | null | undefined): string {
  const stripped = basenameOf(name).replace(/["\\\r\n]/g, "");
  return stripped || "upload";
}

/**
 * The `filename=` X is sent for a file.
 *
 * X ignores this field, so it is GENERATED rather than carried over from the
 * operator's path: the path is the one attacker-controlled string that would
 * otherwise reach a header, and the extension it is built from is alphanumeric
 * by construction. `safeFilename` still runs over the result, because the
 * guarantee should not depend on reading `extensionOf` to know it holds.
 */
function uploadFilenameFor(path: string, kind: MediaKind): string {
  return safeFilename(`post-${kind}${extensionOf(path)}`);
}

// ---------------------------------------------------------------------------
// Failure, sanitized
// ---------------------------------------------------------------------------

/**
 * A publish that did not happen, carrying the one line an operator reads.
 *
 * Every message is built here from a status, a bounded body excerpt and no
 * credential; `sanitize` is the second line of defence over that, because a
 * leaked API secret in a log is not a bug anyone gets to fix quietly.
 */
class PublishFailure extends Error {}

/** A response body, collapsed to one line and bounded. */
function snippet(body: string, max = 200): string {
  const line = String(body ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function sanitize(err: unknown, credentials?: XCredentials): string {
  const raw = err instanceof Error ? err.message : String(err);
  let out = raw.replace(/\s+/g, " ").trim();

  for (const secret of Object.values(credentials ?? {})) {
    // A short value would match half the alphabet; a real credential is long.
    if (typeof secret === "string" && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  out = out.replace(/oauth_\w+/gi, "[redacted]").replace(/OAuth\s/g, "[redacted] ");

  return out.length > 400 ? `${out.slice(0, 399)}…` : out;
}

/** 2xx or a failure naming the step, so "which request" is never a guess. */
function jsonOrFail(response: XResponse, what: string): Record<string, any> {
  if (Math.floor(response.status / 100) !== 2) {
    throw new PublishFailure(
      `${what} failed HTTP ${response.status}: ${snippet(response.body)}`,
    );
  }
  const body = String(response.body ?? "");
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as Record<string, any>;
  } catch {
    throw new PublishFailure(`${what} returned unreadable body: ${snippet(body)}`);
  }
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

interface MultipartFile {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * A multipart body.
 *
 * Field values are written without a Content-Type line, the file part with one
 * — the same shape X's own examples use.
 */
function multipartBody(
  boundary: string,
  fields: Record<string, string>,
  file: MultipartFile | null,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const ascii = (text: string) => Buffer.from(text, "utf8");

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      ascii(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
      ),
    );
  }
  if (file) {
    chunks.push(
      ascii(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="media"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(file.bytes);
    chunks.push(ascii("\r\n"));
  }
  chunks.push(ascii(`--${boundary}--\r\n`));

  return Buffer.concat(chunks);
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/**
 * The nonce and clock reading for ONE request.
 *
 * Taken once and used for both the signature and the multipart boundary: the
 * nonce is already unpredictable and already public in the Authorization
 * header, so it makes a boundary that cannot collide across requests without
 * inventing a second source of randomness to inject and to fake.
 */
interface Ticket {
  nonce: string;
  timestamp: number;
}

function ticketFor(deps: XPublisherDeps): Ticket {
  return { nonce: deps.nonce(), timestamp: Math.floor(deps.now() / 1000) };
}

const boundaryFor = (ticket: Ticket): string =>
  `----paperclip${ticket.nonce.replace(/[^A-Za-z0-9-]/g, "")}`;

function authorization(
  deps: XPublisherDeps,
  ticket: Ticket,
  method: "GET" | "POST",
  url: string,
  params: Record<string, string> = {},
): string {
  return oauth1Header({
    method,
    url,
    credentials: deps.credentials,
    params,
    nonce: ticket.nonce,
    timestamp: ticket.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Image upload — one multipart POST
// ---------------------------------------------------------------------------

async function uploadImage(
  deps: XPublisherDeps,
  path: string,
  bytes: Uint8Array,
): Promise<string> {
  const ticket = ticketFor(deps);
  const boundary = boundaryFor(ticket);
  const body = multipartBody(boundary, {}, {
    filename: uploadFilenameFor(path, "image"),
    contentType: mediaMimeFor(path) as string,
    bytes,
  });

  const response = await deps.request({
    method: "POST",
    url: MEDIA_URL,
    headers: {
      // Multipart bodies are NOT signed — only the oauth_* parameters are.
      Authorization: authorization(deps, ticket, "POST", MEDIA_URL),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const payload = jsonOrFail(response, "media upload");
  const mediaId = payload.media_id_string;
  if (!mediaId) {
    throw new PublishFailure(
      `media upload returned no media_id: ${snippet(response.body)}`,
    );
  }
  return String(mediaId);
}

// ---------------------------------------------------------------------------
// Video upload — INIT, APPEND, FINALIZE, STATUS
// ---------------------------------------------------------------------------

async function uploadVideo(
  deps: XPublisherDeps,
  path: string,
  total: number,
): Promise<string> {

  // --- INIT ---------------------------------------------------------------
  // Form-encoded, so unlike the multipart and JSON cases these parameters ARE
  // part of the signature base string.
  const init: Record<string, string> = {
    command: "INIT",
    total_bytes: String(total),
    media_type: mediaMimeFor(path) as string,
    media_category: "tweet_video",
  };
  const initTicket = ticketFor(deps);
  const initResponse = await deps.request({
    method: "POST",
    url: MEDIA_URL,
    headers: {
      Authorization: authorization(deps, initTicket, "POST", MEDIA_URL, init),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody(init),
  });
  const started = jsonOrFail(initResponse, "media INIT");
  const mediaId = started.media_id_string ? String(started.media_id_string) : "";
  if (!mediaId) {
    throw new PublishFailure(
      `media INIT returned no media_id: ${snippet(initResponse.body)}`,
    );
  }

  // --- APPEND -------------------------------------------------------------
  // Ordered segments, numbered 0..n-1 as they are sent. X reassembles by
  // segment_index, so the number and the bytes must not come apart.
  let index = 0;
  for (let at = 0; at < total; at += CHUNK_BYTES) {
    const expected = Math.min(CHUNK_BYTES, total - at);
    const chunk = await deps.readRange(path, at, expected);
    if (chunk.length !== expected) {
      throw new PublishFailure(
        `media file changed while reading segment ${index}: expected ${expected} bytes, got ${chunk.length}`,
      );
    }
    const ticket = ticketFor(deps);
    const boundary = boundaryFor(ticket);
    const response = await deps.request({
      method: "POST",
      url: MEDIA_URL,
      headers: {
        Authorization: authorization(deps, ticket, "POST", MEDIA_URL),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody(
        boundary,
        { command: "APPEND", media_id: mediaId, segment_index: String(index) },
        {
          filename: uploadFilenameFor(path, "video"),
          // A segment is a slice of a video, not a video.
          contentType: "application/octet-stream",
          bytes: chunk,
        },
      ),
    });
    if (Math.floor(response.status / 100) !== 2) {
      throw new PublishFailure(
        `media APPEND segment ${index} failed HTTP ${response.status}: ` +
          snippet(response.body),
      );
    }
    index += 1;
  }

  // --- FINALIZE -----------------------------------------------------------
  const final: Record<string, string> = { command: "FINALIZE", media_id: mediaId };
  const finalTicket = ticketFor(deps);
  const finalResponse = await deps.request({
    method: "POST",
    url: MEDIA_URL,
    headers: {
      Authorization: authorization(deps, finalTicket, "POST", MEDIA_URL, final),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody(final),
  });
  const finished = jsonOrFail(finalResponse, "media FINALIZE");

  return awaitProcessing(deps, mediaId, finished.processing_info);
}

/**
 * How long to wait before the next STATUS check, in milliseconds.
 *
 * `check_after_secs` comes off the wire, so it is clamped at both ends: a
 * missing value must not become a busy loop and an absurd one must not become
 * an absurd sleep. The remaining budget is the hard ceiling.
 */
function pollDelayMs(info: Record<string, any>, waitedMs: number): number {
  const asked = Number(info?.check_after_secs);
  const delay =
    Number.isFinite(asked) && asked > 0 ? asked * 1000 : DEFAULT_POLL_INTERVAL_MS;
  return Math.min(
    delay,
    MAX_POLL_INTERVAL_MS,
    Math.max(MAX_PROCESSING_WAIT_MS - waitedMs, 0),
  );
}

/**
 * Poll STATUS until X says the video is usable, or give up with a reason.
 *
 * NO processing_info AT ALL MEANS DONE. X only returns that block when there
 * is asynchronous work to wait for; for an upload it finished inline it simply
 * answers with the media object. Treating its absence as "not ready" fails a
 * video that is already usable, which is the same broken post as a transcode
 * that really did fail — with no way to tell the two apart.
 */
async function awaitProcessing(
  deps: XPublisherDeps,
  mediaId: string,
  initial: Record<string, any> | undefined,
): Promise<string> {
  let info: Record<string, any> | undefined = initial;
  if (!info) return mediaId;
  let waitedMs = 0;
  let polls = 0;

  while (info) {
    const state = String(info.state ?? "").toLowerCase();
    if (state === "succeeded") return mediaId;
    if (state === "failed") {
      const error = info.error ?? {};
      const reason =
        error.message || error.name || snippet(JSON.stringify(info) ?? "");
      throw new PublishFailure(`X failed to process the video: ${reason}`);
    }
    if (state !== "pending" && state !== "in_progress") {
      throw new PublishFailure(`unexpected media processing state "${state}"`);
    }
    if (polls >= MAX_STATUS_POLLS || waitedMs >= MAX_PROCESSING_WAIT_MS) break;

    const delay = pollDelayMs(info, waitedMs);
    if (delay <= 0) break;
    await deps.sleep(delay);
    waitedMs += delay;
    polls += 1;

    const query: Record<string, string> = { command: "STATUS", media_id: mediaId };
    const ticket = ticketFor(deps);
    const response = await deps.request({
      method: "GET",
      url: MEDIA_URL,
      // A query-string request signs its query parameters.
      headers: { Authorization: authorization(deps, ticket, "GET", MEDIA_URL, query) },
      query,
    });
    const payload = jsonOrFail(response, "media STATUS");
    // A STATUS response with no processing_info is X saying it is done.
    info = payload.processing_info ?? { state: "succeeded" };
  }

  throw new PublishFailure(
    `X is still processing the video after ${Math.round(waitedMs / 1000)}s and ` +
      `${polls} checks; the post was not created`,
  );
}

// ---------------------------------------------------------------------------
// Whatever this file is, up the path that fits it
// ---------------------------------------------------------------------------

async function uploadMedia(deps: XPublisherDeps, path: string): Promise<string> {
  const kind = mediaKindFor(path);
  if (!kind) {
    throw new PublishFailure(
      `unsupported media type for X: ${basenameOf(path) || "(no file name)"}`,
    );
  }
  const limit = kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;

  // Size first, from `stat`: an oversized file is refused without slurping
  // 512 MB into a worker only to throw it away.
  const size = Number((await deps.stat(path)).size ?? 0);
  refuseBySize(kind, size, limit, path);

  if (kind === "video") return uploadVideo(deps, path, size);

  const bytes = await deps.readFile(path);
  refuseBySize(kind, bytes.length, limit, path);
  return uploadImage(deps, path, bytes);
}

function refuseBySize(kind: MediaKind, size: number, limit: number, path: string): void {
  if (!(size > 0)) {
    throw new PublishFailure(`the media file is empty: ${basenameOf(path)}`);
  }
  if (size > limit) {
    throw new PublishFailure(
      `${kind} too large for X: ${(size / 1e6).toFixed(1)} MB ` +
        `(limit ${Math.round(limit / 1024 / 1024)} MB)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Accessibility metadata
// ---------------------------------------------------------------------------

async function attachAltText(
  deps: XPublisherDeps,
  mediaId: string,
  value: string | null | undefined,
): Promise<void> {
  const text = String(value ?? "").trim();
  if (!text) return;

  const ticket = ticketFor(deps);
  const response = await deps.request({
    method: "POST",
    url: METADATA_URL,
    headers: {
      // JSON bodies are not part of the OAuth1 signature base string.
      Authorization: oauth1Header({
        method: "POST",
        url: METADATA_URL,
        credentials: deps.credentials,
        params: {},
        nonce: ticket.nonce,
        timestamp: ticket.timestamp,
      }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      media_id: mediaId,
      alt_text: { text: text.slice(0, 1000) },
    }),
  });
  if (Math.floor(response.status / 100) !== 2) {
    throw new PublishFailure(
      `alt text metadata failed HTTP ${response.status}: ${snippet(response.body)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The publish
// ---------------------------------------------------------------------------

/**
 * Post to X, with the case's media attached if it has any.
 *
 * A media failure ENDS the publish: the tweet is never created unless the
 * media is up and processed, because a post that silently loses the video it
 * was written around is worse than a post that does not go out. Everything
 * that can go wrong comes back as `ok: false` and one sanitized line — a
 * publisher that throws is a scheduler tick that dies with the reason inside
 * an unhandled rejection.
 */
export async function publishToX(
  input: XPublishInput,
  deps: XPublisherDeps,
): Promise<XPublishResult> {
  try {
    const text = String(input?.text ?? "");
    const mediaPath = input?.mediaPath || null;
    const mediaId = mediaPath ? await uploadMedia(deps, mediaPath) : null;
    if (mediaId) await attachAltText(deps, mediaId, input?.altText);

    const payload = mediaId
      ? { text, media: { media_ids: [mediaId] } }
      : { text };
    const ticket = ticketFor(deps);
    const response = await deps.request({
      method: "POST",
      url: TWEETS_URL,
      headers: {
        // THE JSON BODY IS NOT SIGNED. Including it produces a signature that
        // is internally consistent and that X answers with 401.
        Authorization: authorization(deps, ticket, "POST", TWEETS_URL),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const created = jsonOrFail(response, "post");
    const id = created.data?.id ? String(created.data.id) : "";
    if (!id) {
      throw new PublishFailure(
        `post response carried no tweet id: ${snippet(response.body)}`,
      );
    }

    return {
      ok: true,
      id,
      // /i/web/status/ works for any account, so the published url does not
      // encode whose account this plugin happens to be installed against.
      url: `https://x.com/i/web/status/${id}`,
      mediaId,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      id: null,
      url: null,
      mediaId: null,
      error: sanitize(err, deps?.credentials),
    };
  }
}
