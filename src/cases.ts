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
  /** True when the case is in the native `approved` status. */
  approved: boolean;
}

export interface CalendarConfig {
  apiBaseUrl: string;
  boardApiKeyRef?: unknown;
  autoPost: boolean;
  channels: string[];
  lookbackHours: number;
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
  autoPost: false,
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
    // Fail closed: anything other than an explicit true means do not publish.
    autoPost: raw.autoPost === true,
    channels: Array.isArray(raw.channels)
      ? raw.channels.filter((c): c is string => typeof c === "string")
      : DEFAULTS.channels,
    lookbackHours: num(raw.lookbackHours, DEFAULTS.lookbackHours),
  };
}

async function authHeader(
  ctx: PluginContext,
  cfg: CalendarConfig,
): Promise<string> {
  if (!cfg.boardApiKeyRef) {
    throw new CasesNotConfiguredError(
      "boardApiKeyRef is not set in plugin config. Create one with `paperclipai token board create`, store it as a secret, and reference it from the plugin settings page.",
    );
  }
  const key = await ctx.secrets.resolve(
    cfg.boardApiKeyRef as string,
    { configPath: "boardApiKeyRef" },
  );
  if (!key) {
    throw new CasesNotConfiguredError(
      "boardApiKeyRef resolved to an empty value.",
    );
  }
  return `Bearer ${key}`;
}

async function apiGet<T>(
  ctx: PluginContext,
  cfg: CalendarConfig,
  path: string,
): Promise<T> {
  const url = `${cfg.apiBaseUrl}${path}`;
  const res = await ctx.http.fetch(url, {
    method: "GET",
    headers: {
      Authorization: await authHeader(ctx, cfg),
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
    // Approval is the NATIVE case status, never a JSON field. See
    // Agents/paperclip-native-scheduling.md in the knowledge graph.
    approved: c.status === "approved",
  };
}

/**
 * Fetch every social_post case for a company.
 *
 * The API caps `limit` at 200; we page until a short page comes back so the
 * calendar does not silently truncate once the backlog grows.
 */
export async function listSocialCases(
  ctx: PluginContext,
  cfg: CalendarConfig,
  companyId: string,
): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  const limit = 200;
  let offset = 0;

  for (let page = 0; page < 25; page += 1) {
    const qs = new URLSearchParams({
      type: CASE_TYPE,
      limit: String(limit),
      offset: String(offset),
    });
    const body = await apiGet<{ cases?: PaperclipCase[] } | PaperclipCase[]>(
      ctx,
      cfg,
      `/api/companies/${companyId}/cases?${qs.toString()}`,
    );
    const batch = Array.isArray(body) ? body : (body.cases ?? []);
    out.push(...batch.map(toEntry));
    if (batch.length < limit) break;
    offset += limit;
  }

  return out;
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
  status?: CaseStatus,
): Promise<PaperclipCase> {
  const current = await apiGet<PaperclipCase | { case: PaperclipCase }>(
    ctx,
    cfg,
    `/api/cases/${encodeURIComponent(caseIdOrIdentifier)}`,
  );
  const existing = "case" in current ? current.case : current;

  const merged = { ...(existing.fields ?? {}), ...patch };
  const payload: Record<string, unknown> = { fields: merged };
  if (status) payload.status = status;

  const res = await ctx.http.fetch(
    `${cfg.apiBaseUrl}/api/cases/${encodeURIComponent(caseIdOrIdentifier)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: await authHeader(ctx, cfg),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
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
