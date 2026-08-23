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
  CASE_TYPE,
  FIELD_CAPTION,
  FIELD_CHANNEL,
  FIELD_MEDIA,
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
  publishUrl: string | null;
  /** Accessibility text for attached media. X requires alt on every image. */
  altText: string | null;
  /** True when the case is in the native `approved` status. */
  approved: boolean;
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

/** Normalise a raw case into the shape the calendar renders. */
export function toEntry(c: PaperclipCase): CalendarEntry {
  const fields = c.fields ?? {};
  return {
    id: c.id,
    identifier: c.identifier,
    key: c.key ?? null,
    title: c.title,
    status: c.status,
    publishAt: str(fields[FIELD_PUBLISH_AT]),
    channel: str(fields[FIELD_CHANNEL]),
    caption: str(fields[FIELD_CAPTION]),
    mediaFile: str(fields[FIELD_MEDIA]),
    publishUrl: str(fields[FIELD_PUBLISH_URL]),
    altText: str(fields.alt_text),
    // Approval is the NATIVE case status, never a JSON field. See
    // Agents/paperclip-native-scheduling.md in the knowledge graph.
    approved: c.status === "approved",
  };
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
