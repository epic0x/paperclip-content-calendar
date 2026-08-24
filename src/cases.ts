/**
 * Paperclip Cases API client.
 *
 * Cases are not exposed through the plugin SDK and are not in the host's
 * coreReadTables whitelist, so they cannot be reached from plugin SQL. The only
 * supported path is the authenticated HTTP API. This module is the single place
 * that knows that.
 *
 * Auth: a board API key, supplied by the operator as a secret reference in
 * plugin config (`boardApiKeyRef`) and resolved at call time. It is never
 * cached, logged, or persisted.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ALLOWED_MEDIA_TYPES,
  assetContentPath,
  assetRef,
  mediaKindOf,
  normalizeContentType,
  parseAssetRef,
  type MediaKind,
} from "./attachments.js";
import {
  CASE_TYPE,
  FIELD_ALT,
  FIELD_CAPTION,
  FIELD_CHANNEL,
  FIELD_MEDIA,
  FIELD_MEDIA_TYPE,
  FIELD_PUBLISH_AT,
  FIELD_PUBLISH_URL,
} from "./manifest.js";

export type CaseStatus =
  | "draft"
  | "in_progress"
  | "in_review"
  | "approved"
  | "done"
  | "cancelled";

export interface PaperclipCase {
  id: string;
  identifier: string;
  key: string | null;
  caseType: string;
  title: string;
  summary: string | null;
  status: CaseStatus;
  fields: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /api/cases/:id — the case row plus its links, labels and attachments. */
export interface PaperclipCaseDetail extends PaperclipCase {
  attachments?: RawAttachment[];
}

/** A case projected into what the calendar actually needs. */
export interface CalendarEntry {
  id: string;
  identifier: string;
  key: string | null;
  title: string;
  status: CaseStatus;
  /** ISO instant, or null when the case carries no publish_at. */
  publishAt: string | null;
  channel: string | null;
  caption: string | null;
  mediaFile: string | null;
  /**
   * Whether `media_file` is an image or a video — or null when there is no
   * media, or its type is one this plugin will not render.
   *
   * The month grid has this and no attachment metadata whatsoever, which is
   * the entire reason the case carries `media_type`: see FIELD_MEDIA_TYPE.
   */
  mediaType: MediaKind | null;
  publishUrl: string | null;
  /** Accessibility text for attached media. X requires alt on every image. */
  altText: string | null;
  /** True when the case is in the native `approved` status. */
  approved: boolean;
}

/** One native attachment, projected into what the detail panel renders. */
export interface AttachmentSummary {
  /** case_attachments row id. */
  id: string;
  /** assets row id — the thing that actually holds the bytes. */
  assetId: string;
  /** Native content URL, session-authenticated and same-origin. */
  contentPath: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdAt: string | null;
}

/**
 * A single case with everything the editor panel needs.
 *
 * Read ONLY when a card is selected. The month grid never asks for this: the
 * case list endpoint returns no attachments, so projecting them onto every card
 * would mean one extra API call per post on every render of the calendar.
 */
export interface CaseDetail extends CalendarEntry {
  attachments: AttachmentSummary[];
  /**
   * The attachment `media_file` explicitly points at — NEVER a guess.
   *
   * Null whenever `media_file` is empty, is a legacy host path, or names an
   * asset that is not attached to this case. Falling back to "the newest
   * attachment" would show the operator an image the publish path is not going
   * to send: publishing reads `media_file`, so anything else on screen is a
   * claim the post cannot honour.
   */
  activeAttachment: AttachmentSummary | null;
  /**
   * Attachments the case carries that `media_file` does not point at.
   *
   * Reported as history so nothing looks lost, and deliberately kept apart from
   * `activeAttachment` so the panel cannot label one of them "the post image".
   */
  unreferencedAttachments: AttachmentSummary[];
  /**
   * True when `media_file` is set but is not a native asset reference — an old
   * host path. The panel says so rather than rendering a broken image.
   */
  legacyMediaFile: boolean;
}

export interface CalendarConfig {
  apiBaseUrl: string;
  boardApiKeyRef?: unknown;
  /** Instance-wide emergency stop. Default false. Not a per-post switch. */
  paused: boolean;
  channels: string[];
  lookbackHours: number;
  /** Secret references for the X OAuth 1.0a credential set. */
  xCredentials?: {
    apiKeyRef?: unknown;
    apiSecretRef?: unknown;
    accessTokenRef?: unknown;
    accessSecretRef?: unknown;
  };
}

export class CasesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "CasesApiError";
  }
}

export class CasesNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasesNotConfiguredError";
  }
}

const DEFAULTS: CalendarConfig = {
  apiBaseUrl: "http://127.0.0.1:3100",
  paused: false,
  channels: [],
  lookbackHours: 6,
};

export async function readConfig(
  ctx: PluginContext,
  companyId?: string,
): Promise<CalendarConfig> {
  const raw = (await ctx.config.get(companyId)) ?? {};
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    apiBaseUrl:
      typeof raw.apiBaseUrl === "string" && raw.apiBaseUrl.trim()
        ? raw.apiBaseUrl.trim().replace(/\/+$/, "")
        : DEFAULTS.apiBaseUrl,
    boardApiKeyRef: raw.boardApiKeyRef,
    // Publishing is on by default now that every case carries its own date.
    // Only an explicit `true` pauses, so a malformed value cannot silently
    // halt the calendar.
    paused: raw.paused === true,
    channels: Array.isArray(raw.channels)
      ? raw.channels.filter((c): c is string => typeof c === "string")
      : DEFAULTS.channels,
    lookbackHours: num(raw.lookbackHours, DEFAULTS.lookbackHours),
    xCredentials:
      raw.xCredentials && typeof raw.xCredentials === "object"
        ? (raw.xCredentials as CalendarConfig["xCredentials"])
        : undefined,
  };
}

async function authHeader(
  ctx: PluginContext,
  cfg: CalendarConfig,
  companyId: string,
): Promise<string> {
  if (!cfg.boardApiKeyRef) {
    throw new CasesNotConfiguredError(
      "boardApiKeyRef is not set in plugin config. Create one with `paperclipai token board create`, store it as a secret, and reference it from the plugin settings page.",
    );
  }
  // companyId is REQUIRED: without it the host sees a global-scoped call and
  // denies with "secrets.resolve: company context is required", which made
  // every sweep read zero cases. Note both keys go in the same options object —
  // the SDK signature here is resolve(ref, { companyId?, configPath? }).
  const key = await ctx.secrets.resolve(
    cfg.boardApiKeyRef as string,
    { companyId, configPath: "boardApiKeyRef" },
  );
  if (!key) {
    throw new CasesNotConfiguredError(
      "boardApiKeyRef resolved to an empty value.",
    );
  }
  return `Bearer ${key}`;
}

/**
 * Choose the right fetch for a URL.
 *
 * `ctx.http.fetch` runs the host's SSRF guard, which resolves the hostname and
 * rejects any address in a private or reserved range — with no allowlist. That
 * is correct for arbitrary outbound calls, but it also blocks the host's OWN
 * loopback API:
 *
 *   {"code":"UNKNOWN","message":"All resolved IPs for 127.0.0.1 are in
 *    private/reserved ranges"}
 *
 * Calling our own Paperclip instance on 127.0.0.1 is not SSRF, and the SDK
 * documents the escape hatch on `PluginHttpClient` itself: "Plugins may also
 * use standard Node `fetch` or other libraries directly — this client exists
 * for host-managed tracing and audit logging."
 *
 * So: loopback and private hosts go through global fetch, everything else goes
 * through the audited client. Public traffic keeps host tracing; the local
 * control-plane call works.
 */
function isLocalHost(urlString: string): boolean {
  try {
    const h = new URL(urlString).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h.endsWith(".localhost") ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

function fetchFor(
  ctx: PluginContext,
  url: string,
): (u: string, init?: RequestInit) => Promise<Response> {
  return isLocalHost(url)
    ? (u, init) => fetch(u, init)
    : (u, init) => ctx.http.fetch(u, init);
}

async function apiGet<T>(
  ctx: PluginContext,
  cfg: CalendarConfig,
  path: string,
  companyId: string,
): Promise<T> {
  const url = `${cfg.apiBaseUrl}${path}`;
  const res = await fetchFor(ctx, url)(url, {
    method: "GET",
    headers: {
      Authorization: await authHeader(ctx, cfg, companyId),
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new CasesApiError(
      `GET ${path} -> ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  return JSON.parse(text) as T;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * What kind of media a case is carrying, from the case row alone.
 *
 * ABSENT MEANS IMAGE. Every case written before `media_type` existed carries an
 * image, so a missing field is an answer rather than a gap — reading it as
 * "unknown" would blank the thumbnail on every post that already works.
 *
 * A type that IS recorded but is not one this plugin renders (a `video/webm`
 * attached through Paperclip's own UI, say) is null rather than coerced: it
 * would go into an <img>, show a broken image, and claim to be the post.
 */
export function entryMediaKind(
  mediaFile: string | null,
  mediaTypeField: unknown,
): MediaKind | null {
  if (!mediaFile) return null;
  const recorded = str(mediaTypeField);
  return recorded ? mediaKindOf(recorded) : "image";
}

/** Normalise a raw case into the shape the calendar renders. */
export function toEntry(c: PaperclipCase): CalendarEntry {
  const fields = c.fields ?? {};
  const mediaFile = str(fields[FIELD_MEDIA]);
  return {
    id: c.id,
    identifier: c.identifier,
    key: c.key ?? null,
    title: c.title,
    status: c.status,
    publishAt: str(fields[FIELD_PUBLISH_AT]),
    channel: str(fields[FIELD_CHANNEL]),
    caption: str(fields[FIELD_CAPTION]),
    mediaFile,
    mediaType: entryMediaKind(mediaFile, fields[FIELD_MEDIA_TYPE]),
    publishUrl: str(fields[FIELD_PUBLISH_URL]),
    altText: str(fields[FIELD_ALT]),
    // Approval is the NATIVE case status, never a JSON field. See
    // Agents/paperclip-native-scheduling.md in the knowledge graph.
    approved: c.status === "approved",
  };
}

interface RawAttachment {
  id?: string;
  createdAt?: string;
  asset?: {
    id?: string;
    contentType?: string;
    byteSize?: number;
    originalFilename?: string | null;
    createdAt?: string;
  } | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toAttachment(raw: RawAttachment): AttachmentSummary | null {
  const assetId = str(raw.asset?.id);
  if (!assetId) return null;
  return {
    id: str(raw.id) ?? assetId,
    assetId,
    contentPath: assetContentPath(assetId),
    contentType: str(raw.asset?.contentType) ?? "application/octet-stream",
    byteSize: num(raw.asset?.byteSize),
    originalFilename: str(raw.asset?.originalFilename),
    createdAt: str(raw.createdAt) ?? str(raw.asset?.createdAt),
  };
}

/**
 * Project a case DETAIL response into what the editor panel renders.
 *
 * `attachments` only exists on GET /api/cases/:id — the list endpoint returns
 * bare case rows — so this is the one shape that carries media metadata.
 */
export function toDetail(c: PaperclipCaseDetail): CaseDetail {
  const entry = toEntry(c);
  const attachments = (c.attachments ?? [])
    .map(toAttachment)
    .filter((a): a is AttachmentSummary => a !== null);

  // `media_file` is the only thing that decides which image the post carries,
  // because it is the only thing the publish path reads. No reference means no
  // current image — not "probably the last one uploaded".
  const referenced = parseAssetRef(entry.mediaFile);
  const active =
    (referenced ? attachments.find((a) => a.assetId === referenced) : null) ??
    null;

  return {
    ...entry,
    attachments,
    activeAttachment: active,
    unreferencedAttachments: attachments.filter((a) => a !== active),
    legacyMediaFile: Boolean(entry.mediaFile) && referenced === null,
  };
}

// ---------------------------------------------------------------------------
// What the calendar panel may change
// ---------------------------------------------------------------------------

/**
 * The statuses the panel's dropdown offers, in review order.
 *
 * These are NATIVE case statuses — the same field the Paperclip case page
 * writes, emitting the same `status_changed` event. Publishing (`done`) and
 * `in_progress` are deliberately absent: a case becomes done by being
 * published, not by a dropdown.
 *
 * The worker validates against this same list, so the UI cannot offer a
 * transition the worker would refuse.
 */
export const PANEL_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "cancelled",
] as const;

export type PanelStatus = (typeof PANEL_STATUSES)[number];

export function isPanelStatus(value: string): value is PanelStatus {
  return (PANEL_STATUSES as readonly string[]).includes(value);
}

/**
 * Guard before `media_file` is repointed.
 *
 * The browser uploads the bytes and the worker writes the field, so the worker
 * re-reads the case and confirms the asset really is linked to it. Without this
 * the action would happily point a case at any asset id a caller invented.
 */
export function assertAttachedAsset(
  detail: CaseDetail,
  assetId: string,
): AttachmentSummary {
  const found = detail.attachments.find((a) => a.assetId === assetId);
  if (!found) {
    throw new Error(
      `asset ${assetId} is not attached to ${detail.identifier}; nothing was changed`,
    );
  }
  return found;
}

/**
 * Refuse an attachment this calendar cannot publish, BEFORE anything is written.
 *
 * Being attached to the case is not the same as being publishable. Paperclip's
 * own attachment route checks no content type at all, and its allowlist is
 * wider than ours (`video/webm`, `video/x-m4v`), so a webm dropped on the case
 * through Paperclip's UI is a perfectly real attachment that `set-media` used
 * to accept and record. What that produced was a post that looks attached and
 * is not: `cardMedia` renders nothing for it, `selectedMedia` previews nothing
 * for it, and the X publisher refuses the extension at publish time — which is the
 * one moment nobody is watching.
 *
 * So the refusal happens here, while the operator is still standing in front of
 * the panel, and it names what was refused and what is accepted. Returns the
 * kind, so the caller does not classify the same string twice.
 */
export function assertPublishableMedia(
  attachment: AttachmentSummary,
  identifier: string,
): MediaKind {
  const kind = mediaKindOf(attachment.contentType);
  if (!kind) {
    const type = normalizeContentType(attachment.contentType) || "no content type";
    throw new Error(
      `asset ${attachment.assetId} on ${identifier} is ${type}, which this ` +
        `calendar cannot publish. Accepted: ${ALLOWED_MEDIA_TYPES.join(", ")}. ` +
        `Nothing was changed.`,
    );
  }
  return kind;
}

/**
 * The server-side line for a `set-media` that did not go through.
 *
 * The browser is handed the thrown message and nothing else, and the panel is
 * usually closed within seconds of the failure. Whoever reads the worker log
 * afterwards needs the case and the asset that were involved, or a repointing
 * that failed leaves no trace of WHAT failed to point WHERE.
 */
export function describeSetMediaFailure(input: {
  identifier: string;
  assetId: string;
  companyId: string;
  err: unknown;
}): string {
  const reason =
    input.err instanceof Error ? input.err.message : String(input.err);
  const status =
    input.err instanceof CasesApiError ? ` (HTTP ${input.err.status})` : "";
  return (
    `[content-calendar] set-media failed for case ${input.identifier} ` +
    `asset ${input.assetId} company ${input.companyId}${status}: ${reason}`
  );
}

// ---------------------------------------------------------------------------
// Building patches
//
// Paperclip REPLACES `fields` wholesale on PATCH (see patchCaseFields), so the
// merge happens there. These helpers only decide what a save is ASKING to
// change: a key that is absent from the patch keeps whatever the case already
// holds, which is why an unedited field must never appear here.
// ---------------------------------------------------------------------------

function trimmedOrNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

export interface ContentEdit {
  caption?: string | null;
  altText?: string | null;
}

/**
 * The patch for a caption / alt-text save from the calendar panel.
 *
 * Only the keys the operator actually edited are included. An empty string is
 * a deliberate clear and becomes null, which is what `toEntry` already reads
 * back as "no caption".
 */
export function buildContentPatch(edit: ContentEdit): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (edit.caption !== undefined) patch[FIELD_CAPTION] = trimmedOrNull(edit.caption);
  if (edit.altText !== undefined) patch[FIELD_ALT] = trimmedOrNull(edit.altText);
  return patch;
}

/**
 * The patch that makes a freshly uploaded asset the case's media.
 *
 * Written only AFTER the upload and the case_attachments link both succeeded,
 * so a failed replacement leaves the previous media in place.
 *
 * `media_file` and `media_type` are always written TOGETHER. Splitting them
 * across two writes allows the second to fail and leave a video pointed at by
 * a case that still claims to be an image — which renders as a broken <img> in
 * the calendar and takes the wrong X upload path at publish time. The type is
 * the one the caller VERIFIED on the attached asset, not the browser's guess
 * about the file it picked.
 */
export function buildMediaPatch(input: {
  assetId: string;
  /** Content type of the verified attachment, e.g. `image/png`, `video/mp4`. */
  contentType: string;
  altText?: string | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    [FIELD_MEDIA]: assetRef(input.assetId),
    // Normalised, because `media_type` is read back by exact match — by the
    // month grid's projection and by the publish path. Persisting the raw
    // `video/mp4; charset=binary` writes a value neither of them recognises.
    [FIELD_MEDIA_TYPE]: normalizeContentType(input.contentType),
  };
  if (input.altText !== undefined) {
    patch[FIELD_ALT] = trimmedOrNull(input.altText);
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Creating a post from the calendar
// ---------------------------------------------------------------------------

/**
 * The payload for `POST /api/companies/:companyId/cases`.
 *
 * Mirrors the server's `createCaseSchema`, which is `.strict()` — an unknown
 * key is a 400, not a field the server shrugs off. Only the members this
 * calendar actually sets are modelled.
 */
export interface CreateCasePayload {
  caseType: string;
  key: string;
  title: string;
  status: CaseStatus;
  fields: Record<string, unknown>;
}

/**
 * A key that belongs to exactly one created post.
 *
 * NOT cosmetic, and not optional — see `buildCreatePayload`.
 * `caseKeySchema` on the server is
 * `z.string().trim().min(1).max(512)`, and the document key route restricts the
 * character set to `[A-Za-z0-9_.:-]`, so this stays inside both.
 */
export function newCaseKey(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `calendar-${uuid}`;
}

/**
 * Build the create payload for a post authored in the calendar.
 *
 * WHY THE KEY IS MANDATORY. `POST /companies/:companyId/cases` is an UPSERT on
 * `(companyId, caseType, key)`, and the server builds its match as
 *
 *     const keyFilter = body.key ? eq(cases.key, body.key) : isNull(cases.key);
 *
 * so a create sent WITHOUT a key matches the first existing keyless
 * `social_post` case and updates it in place — replacing its title, its status
 * and its entire `fields` object, then answering 200 as though all was well.
 * "Create" with no key is a destructive write against a post nobody was
 * looking at. A key of its own makes the request create, and makes a retry of
 * the same submission converge on the same case instead of a duplicate.
 *
 * WHAT IS DELIBERATELY ABSENT. A post created here is a `draft` carrying a
 * title, an optional caption and a date. No `channel`, no `publish_url`, and
 * `approved` is the NATIVE status, which is `draft`. That is not tidiness: the
 * publish gate needs approval AND a channel AND a caption, so a post created
 * here cannot be sent by the sweep or by Post Now until a human opens it and
 * fills the rest in. Scheduling something is not approving it.
 */
export function buildCreatePayload(input: {
  title: string;
  caption?: string | null;
  /** UTC instant, on a Dubai :00/:30 slot. */
  publishAt: string;
  /** Required. See above — a keyless create is an update. */
  key: string | null | undefined;
}): CreateCasePayload {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("a title is required to create a post");

  const key = (input.key ?? "").trim();
  if (!key) {
    throw new Error(
      "a case key is required: POST /cases upserts on (caseType, key) and a keyless create would UPDATE an existing keyless case",
    );
  }

  const publishAt = (input.publishAt ?? "").trim();
  if (!publishAt || Number.isNaN(Date.parse(publishAt))) {
    throw new Error(`publishAt is not a valid instant: ${String(input.publishAt)}`);
  }
  // The same rule every other write obeys, so a created post lands on a slot
  // the twice-hourly publish job actually visits.
  const minutes = new Date(publishAt).getUTCMinutes();
  if (minutes !== 0 && minutes !== 30) {
    throw new Error("publishAt must be on a Dubai :00 or :30 time slot");
  }

  const fields: Record<string, unknown> = { publish_at: publishAt };
  const caption = (input.caption ?? "").trim();
  // An empty caption is absent, not "". `toEntry` reads both back as null, but
  // the gate's "no caption" refusal and a hand-read of the case are clearer
  // when the key simply is not there.
  if (caption) fields[FIELD_CAPTION] = caption;

  return { caseType: CASE_TYPE, key, title, status: "draft", fields };
}

/**
 * Create one social_post case over the authenticated API.
 *
 * `created` distinguishes the route's 201 (a new case) from its 200 (it matched
 * an existing `(caseType, key)` and updated it). The caller reports the
 * difference rather than assuming, because a "create" that silently updated is
 * exactly what the key is there to prevent.
 */
export async function createSocialCase(
  ctx: PluginContext,
  cfg: CalendarConfig,
  payload: CreateCasePayload,
  companyId: string,
): Promise<{ created: boolean; entry: CalendarEntry; raw: PaperclipCase }> {
  const url = `${cfg.apiBaseUrl}/api/companies/${companyId}/cases`;
  const res = await fetchFor(ctx, url)(url, {
    method: "POST",
    headers: {
      Authorization: await authHeader(ctx, cfg, companyId),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new CasesApiError(
      `POST /api/companies/${companyId}/cases -> ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  const parsed = JSON.parse(text) as PaperclipCase | { case: PaperclipCase };
  const row = "case" in parsed ? parsed.case : parsed;
  return { created: res.status === 201, entry: toEntry(row), raw: row };
}

/**
 * Fetch every social_post case for a company.
 *
 * PITFALL: the case list endpoint validates its query with a STRICT schema and
 * rejects unknown keys outright — sending `offset` returns
 *   400 {"error":"Invalid case list query","details":[{"code":
 *        "unrecognized_keys","keys":["offset"]}]}
 * There is no offset-based pagination. `limit` is capped at 200 by the API, so
 * we ask for the maximum and warn if we hit it rather than silently showing a
 * truncated calendar.
 */
export async function listSocialCases(
  ctx: PluginContext,
  cfg: CalendarConfig,
  companyId: string,
): Promise<CalendarEntry[]> {
  const limit = 200;
  const qs = new URLSearchParams({ type: CASE_TYPE, limit: String(limit) });
  const body = await apiGet<{ cases?: PaperclipCase[] } | PaperclipCase[]>(
    ctx,
    cfg,
    `/api/companies/${companyId}/cases?${qs.toString()}`,
    companyId,
  );
  const batch = Array.isArray(body) ? body : (body.cases ?? []);
  if (batch.length >= limit) {
    ctx.logger.warn(
      `[content-calendar] case list hit the API limit of ${limit}; the calendar may be incomplete. The endpoint has no offset parameter, so this needs date-range filtering to go further.`,
    );
  }
  return batch.map(toEntry);
}

/**
 * Download an asset's bytes over the authenticated API.
 *
 * `GET /api/assets/:assetId/content` (server/dist/routes/assets.js) streams the
 * object and sets Content-Type from the asset row. The board key is scoped to
 * the company, and the route 404s rather than 403s across tenants, so a wrong
 * id looks like a missing asset — which is exactly how the publish path treats
 * it: a failed attempt with a reason, never a silent text-only post.
 */
export async function downloadAsset(
  ctx: PluginContext,
  cfg: CalendarConfig,
  assetId: string,
  companyId: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = `${cfg.apiBaseUrl}${assetContentPath(assetId)}`;
  const res = await fetchFor(ctx, url)(url, {
    method: "GET",
    headers: { Authorization: await authHeader(ctx, cfg, companyId) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CasesApiError(
      `GET /api/assets/${assetId}/content -> ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/**
 * Read ONE case with its native attachments.
 *
 * `attachments` is only present on GET /api/cases/:id (loadCaseDetail in
 * server/dist/routes/cases.js). The list endpoint returns bare case rows, so
 * the calendar grid deliberately does not have this data: calling it per card
 * would add one API round trip per post on every month render. The panel asks
 * for it when a card is selected, and only then.
 */
export async function fetchCaseDetail(
  ctx: PluginContext,
  cfg: CalendarConfig,
  caseIdOrIdentifier: string,
  companyId: string,
): Promise<CaseDetail> {
  const body = await apiGet<PaperclipCaseDetail | { case: PaperclipCaseDetail }>(
    ctx,
    cfg,
    `/api/cases/${encodeURIComponent(caseIdOrIdentifier)}`,
    companyId,
  );
  return toDetail("case" in body ? body.case : body);
}

/**
 * Patch a case's fields.
 *
 * PITFALL, load-bearing: Paperclip REPLACES `fields` wholesale on PATCH. It
 * does not deep-merge. Sending `{ publish_url }` alone destroys caption,
 * channel and publish_at. This function therefore always reads the case first
 * and sends the complete merged object.
 */
export async function patchCaseFields(
  ctx: PluginContext,
  cfg: CalendarConfig,
  caseIdOrIdentifier: string,
  patch: Record<string, unknown>,
  status: CaseStatus | undefined,
  companyId: string,
): Promise<PaperclipCase> {
  const current = await apiGet<PaperclipCase | { case: PaperclipCase }>(
    ctx,
    cfg,
    `/api/cases/${encodeURIComponent(caseIdOrIdentifier)}`,
    companyId,
  );
  const existing = "case" in current ? current.case : current;

  const merged = { ...(existing.fields ?? {}), ...patch };
  const payload: Record<string, unknown> = { fields: merged };
  if (status) payload.status = status;

  const patchUrl = `${cfg.apiBaseUrl}/api/cases/${encodeURIComponent(caseIdOrIdentifier)}`;
  const res = await fetchFor(ctx, patchUrl)(patchUrl, {
    method: "PATCH",
    headers: {
      Authorization: await authHeader(ctx, cfg, companyId),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new CasesApiError(
      `PATCH /api/cases/${caseIdOrIdentifier} -> ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  const parsed = JSON.parse(text) as PaperclipCase | { case: PaperclipCase };
  return "case" in parsed ? parsed.case : parsed;
}
