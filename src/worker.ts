import { createHash, randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dubaiDayKey, isHalfHourSlot } from "./time.js";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import {
  DB_NAMESPACE,
  JOB_PUBLISH_DUE,
  PLUGIN_ID,
  UNTRACE_COMPANY_ID,
} from "./manifest.js";
import {
  CasesNotConfiguredError,
  PANEL_STATUSES,
  assertAttachedAsset,
  buildContentPatch,
  buildMediaPatch,
  describeSetMediaFailure,
  downloadAsset,
  fetchCaseDetail,
  isPanelStatus,
  listSocialCases,
  patchCaseFields,
  readConfig,
  type CalendarConfig,
  type CalendarEntry,
  type CaseStatus,
} from "./cases.js";
import {
  ALLOWED_IMAGE_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
} from "./attachments.js";
import { resolveMediaForPublish, type ResolvedMedia } from "./media.js";
import { adapterFor } from "./channels.js";
import { evaluate } from "./gate.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const attempts = () => `${DB_NAMESPACE}.publish_attempts`;
const overrides = () => `${DB_NAMESPACE}.schedule_overrides`;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function requireStr(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}


/**
 * The company's attachment byte cap.
 *
 * `POST /api/cases/:id/attachments` enforces `companies.attachment_max_bytes`
 * and falls back to 10 MiB (server/dist/routes/cases.js). `companies` is in the
 * host's PLUGIN_DATABASE_CORE_READ_TABLES whitelist and this plugin declares it
 * in `coreReadTables`, so the same number can be read here instead of guessed —
 * which is what lets the panel reject an oversized file before uploading it.
 *
 * A failure here is not worth breaking the panel over: fall back to the server
 * default and say so in the log.
 */
async function uploadLimitBytes(
  ctx: PluginContext,
  companyId: string,
): Promise<number> {
  try {
    const rows = await ctx.db.query<{ attachment_max_bytes: number | null }>(
      `SELECT attachment_max_bytes FROM public.companies WHERE id = $1`,
      [companyId],
    );
    const value = rows[0]?.attachment_max_bytes;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_MAX_UPLOAD_BYTES;
  } catch (err) {
    ctx.logger.warn(
      `[content-calendar] could not read companies.attachment_max_bytes (${
        err instanceof Error ? err.message : String(err)
      }); using the ${DEFAULT_MAX_UPLOAD_BYTES}-byte default`,
    );
    return DEFAULT_MAX_UPLOAD_BYTES;
  }
}

/**
 * Real IO for `resolveMediaForPublish`.
 *
 * The temp file lives in the OS temp dir for the duration of one publish and is
 * removed in a finally, including when the adapter throws. Its name carries a
 * fresh uuid per attempt, so a scheduled sweep and a Post Now on the same case
 * cannot delete each other's copy mid-upload.
 */
function mediaDeps(ctx: PluginContext, cfg: CalendarConfig, companyId: string) {
  return {
    downloadAsset: (assetId: string) =>
      downloadAsset(ctx, cfg, assetId, companyId),
    writeTempFile: async (fileName: string, bytes: Uint8Array) => {
      const path = join(tmpdir(), fileName);
      await writeFile(path, bytes);
      return path;
    },
    removeFile: (path: string) => rm(path, { force: true }),
    newAttemptId: () => randomUUID(),
  };
}

async function sentCaseIds(
  ctx: PluginContext,
  companyId: string,
): Promise<Set<string>> {
  const rows = await ctx.db.query<{ case_id: string }>(
    `SELECT case_id FROM ${attempts()} WHERE company_id = $1 AND outcome = 'sent'`,
    [companyId],
  );
  return new Set(rows.map((r) => r.case_id));
}

async function recordAttempt(
  ctx: PluginContext,
  row: {
    companyId: string;
    entry: CalendarEntry;
    outcome: string;
    reason: string | null;
    postUrl: string | null;
    raw: Record<string, unknown>;
  },
): Promise<void> {
  const { companyId, entry, outcome, reason, postUrl, raw } = row;
  try {
    await ctx.db.execute(
      `INSERT INTO ${attempts()}
         (company_id, case_id, case_identifier, case_key, channel,
          scheduled_for, outcome, reason, post_url, content_sha256, adapter_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        companyId,
        entry.id,
        entry.identifier,
        entry.key,
        entry.channel ?? "unknown",
        entry.publishAt ?? new Date().toISOString(),
        outcome,
        reason,
        postUrl,
        entry.caption ? sha256(entry.caption) : null,
        JSON.stringify(raw),
      ],
    );
  } catch (err) {
    // The partial unique index on outcome='sent' is the double-post interlock.
    // A violation here means something else already published this case, which
    // is exactly the outcome we want — log it, never retry the send.
    ctx.logger.warn(
      `[content-calendar] could not record ${outcome} for ${entry.identifier}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Data handlers — these back usePluginData() in the UI
// ---------------------------------------------------------------------------

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  /**
   * calendar — every social_post case grouped by UTC day.
   * Params: companyId, from (YYYY-MM-DD), to (YYYY-MM-DD)
   */
  ctx.data.register("calendar", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const cfg = await readConfig(ctx, companyId);

    let entries: CalendarEntry[];
    try {
      entries = await listSocialCases(ctx, cfg, companyId);
    } catch (err) {
      if (err instanceof CasesNotConfiguredError) {
        return { configured: false, error: err.message, days: [], unscheduled: [], stats: null };
      }
      throw err;
    }

    const from = typeof params.from === "string" ? params.from : null;
    const to = typeof params.to === "string" ? params.to : null;

    const scheduled = entries.filter((e) => e.publishAt);
    const unscheduled = entries.filter(
      (e) => !e.publishAt && e.status !== "cancelled",
    );

    const byDay = new Map<string, CalendarEntry[]>();
    for (const e of scheduled) {
      const day = dubaiDayKey(e.publishAt as string);
      if (from && day < from) continue;
      if (to && day > to) continue;
      const list = byDay.get(day) ?? [];
      list.push(e);
      byDay.set(day, list);
    }

    const days = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({
        date,
        entries: items.sort((a, b) =>
          (a.publishAt ?? "").localeCompare(b.publishAt ?? ""),
        ),
      }));

    const stats = {
      total: entries.length,
      scheduled: scheduled.length,
      unscheduled: unscheduled.length,
      approved: entries.filter((e) => e.approved).length,
      inReview: entries.filter((e) => e.status === "in_review").length,
      published: entries.filter((e) => e.publishUrl).length,
      cancelled: entries.filter((e) => e.status === "cancelled").length,
    };

    return { configured: true, error: null, days, unscheduled, stats };
  });

  /** attempts — recent publish attempts, newest first. */
  ctx.data.register("attempts", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const limit =
      typeof params.limit === "number" ? Math.min(params.limit, 200) : 50;
    const rows = await ctx.db.query(
      `SELECT case_identifier, channel, scheduled_for::text AS scheduled_for,
              attempted_at::text AS attempted_at, outcome, reason, post_url
         FROM ${attempts()}
        WHERE company_id = $1
        ORDER BY attempted_at DESC
        LIMIT ${limit}`,
      [companyId],
    );
    return { attempts: rows };
  });

  /** status — config health, so the UI can explain itself instead of rendering empty. */
  ctx.data.register("status", async (params) => {
    const companyId =
      typeof params.companyId === "string" ? params.companyId : undefined;
    const cfg = await readConfig(ctx, companyId);
    const channels = await Promise.all(
      cfg.channels.map(async (c) => {
        const a = adapterFor(c);
        return {
          channel: c,
          hasAdapter: Boolean(a),
          configured: a ? await a.isConfigured(ctx, cfg) : false,
        };
      }),
    );
    return {
      pluginId: PLUGIN_ID,
      apiBaseUrl: cfg.apiBaseUrl,
      boardKeyConfigured: Boolean(cfg.boardApiKeyRef),
      paused: cfg.paused,
      lookbackHours: cfg.lookbackHours,
      channels,
    };
  });

  /**
   * case-detail — ONE case, with its native attachments and the upload limits.
   *
   * Deliberately not folded into `calendar`: attachments only exist on
   * GET /api/cases/:id, so including them in the month view would cost one API
   * round trip per card on every render. The panel asks for this when a card is
   * selected and not before.
   *
   * Params: companyId, caseId (id or identifier).
   */
  ctx.data.register("case-detail", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const caseId = requireStr(params.caseId, "caseId");
    const cfg = await readConfig(ctx, companyId);

    const limits = {
      maxUploadBytes: await uploadLimitBytes(ctx, companyId),
      allowedImageTypes: [...ALLOWED_IMAGE_TYPES],
    };

    try {
      const detail = await fetchCaseDetail(ctx, cfg, caseId, companyId);
      return { configured: true, error: null, detail, ...limits };
    } catch (err) {
      if (err instanceof CasesNotConfiguredError) {
        return { configured: false, error: err.message, detail: null, ...limits };
      }
      // A detail read that fails must say so in the panel rather than render an
      // empty editor over a case that is actually fine.
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(
        `[content-calendar] case-detail ${caseId} failed: ${message}`,
      );
      return { configured: true, error: message, detail: null, ...limits };
    }
  });
}

// ---------------------------------------------------------------------------
// Actions — these back usePluginAction() in the UI
// ---------------------------------------------------------------------------

async function registerActionHandlers(ctx: PluginContext): Promise<void> {
  /**
   * reschedule — move a case to a new publish_at.
   * Records intent first, then writes back, so a failed write-back is visible.
   */
  ctx.actions.register("reschedule", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const identifier = requireStr(params.caseIdentifier, "caseIdentifier");
    const caseId = requireStr(params.caseId, "caseId");
    const publishAt = requireStr(params.publishAt, "publishAt");
    if (Number.isNaN(Date.parse(publishAt))) {
      throw new Error(`publishAt is not a valid instant: ${publishAt}`);
    }
    if (!isHalfHourSlot(publishAt)) {
      throw new Error("publishAt must be on a Dubai :00 or :30 time slot");
    }
    const previous =
      typeof params.previousPublishAt === "string"
        ? params.previousPublishAt
        : null;

    const cfg = await readConfig(ctx, companyId);

    await ctx.db.execute(
      `INSERT INTO ${overrides()}
         (company_id, case_id, case_identifier, previous_publish_at,
          requested_publish_at, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, caseId, identifier, previous, publishAt, "calendar-ui"],
    );

    try {
      await patchCaseFields(ctx, cfg, identifier, { publish_at: publishAt },
                            undefined, companyId);
      await ctx.db.execute(
        `UPDATE ${overrides()}
            SET applied_to_case = TRUE, updated_at = NOW()
          WHERE case_id = $1 AND requested_publish_at = $2`,
        [caseId, publishAt],
      );
      return { ok: true, publishAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.db.execute(
        `UPDATE ${overrides()}
            SET apply_error = $3, updated_at = NOW()
          WHERE case_id = $1 AND requested_publish_at = $2`,
        [caseId, publishAt, message],
      );
      throw err;
    }
  });

  /**
   * set-status — approve or un-approve a case from the calendar.
   *
   * This writes the NATIVE case status, the same field the Paperclip case view
   * writes. It is a shortcut for the existing review action, not a second
   * approval mechanism, so approving here and approving there are identical and
   * both emit a `status_changed` case event.
   *
   * The allowed set is PANEL_STATUSES, and Cancelled is part of it on purpose:
   * killing a post that should not go out is a calendar decision, and it is the
   * one status change an operator needs to make in a hurry. `done` and
   * `in_progress` are the ones deliberately absent — a case becomes done by
   * being published, not by a dropdown.
   */
  ctx.actions.register("set-status", async (params, actionContext) => {
    const companyId = requireStr(params.companyId, "companyId");
    const identifier = requireStr(params.caseIdentifier, "caseIdentifier");
    const status = requireStr(params.status, "status");

    // One list, shared with the dropdown, so the UI cannot offer a transition
    // this handler would refuse.
    if (!isPanelStatus(status)) {
      throw new Error(
        `status "${status}" is not settable from the calendar; allowed: ${PANEL_STATUSES.join(", ")}`,
      );
    }

    const cfg = await readConfig(ctx, companyId);
    // Empty patch: fields are preserved, only status moves. patchCaseFields
    // still reads first and re-sends the whole object, because Paperclip
    // replaces `fields` wholesale on PATCH.
    const updated = await patchCaseFields(
      ctx,
      cfg,
      identifier,
      {},
      status as CaseStatus,
      companyId,
    );

    await ctx.activity.log({
      companyId,
      message: `Case ${identifier} set to ${status} from the content calendar`,
      entityType: "case",
      entityId: updated.id,
      metadata: {
        status,
        // userId lives under actor, not on the context root.
        actor: actionContext?.actor?.userId ?? "calendar-ui",
      },
    });

    return { ok: true, identifier, status: updated.status };
  });

  /**
   * save-content — write the caption and alt text the operator edited.
   *
   * Only the keys actually edited are sent. `patchCaseFields` still reads the
   * case first and re-sends the whole `fields` object, because Paperclip
   * REPLACES `fields` wholesale on PATCH — a bare `{caption}` would destroy
   * channel, publish_at and media_file.
   */
  ctx.actions.register("save-content", async (params, actionContext) => {
    const companyId = requireStr(params.companyId, "companyId");
    const identifier = requireStr(params.caseIdentifier, "caseIdentifier");

    const patch = buildContentPatch({
      caption: typeof params.caption === "string" ? params.caption : undefined,
      altText: typeof params.altText === "string" ? params.altText : undefined,
    });
    if (Object.keys(patch).length === 0) {
      throw new Error("save-content was called with nothing to save");
    }

    const cfg = await readConfig(ctx, companyId);
    const updated = await patchCaseFields(
      ctx,
      cfg,
      identifier,
      patch,
      undefined,
      companyId,
    );

    await ctx.activity.log({
      companyId,
      message: `Case ${identifier} text edited from the content calendar`,
      entityType: "case",
      entityId: updated.id,
      metadata: {
        fields: Object.keys(patch),
        actor: actionContext?.actor?.userId ?? "calendar-ui",
      },
    });

    return {
      ok: true,
      identifier,
      caption: (updated.fields?.caption as string | null) ?? null,
      altText: (updated.fields?.alt_text as string | null) ?? null,
    };
  });

  /**
   * set-media — point the case at an image that is already attached to it.
   *
   * The browser uploads the bytes to the native endpoint
   * (POST /api/cases/:id/attachments) because plugin UI is same-origin and
   * carries the session cookie, exactly like Paperclip's own upload path. This
   * action runs afterwards, holding the board API key, and does two things the
   * browser must not be trusted to do:
   *
   *   1. re-reads the case and REFUSES an asset that is not actually attached
   *      to it, so `media_file` cannot be pointed anywhere by a crafted call;
   *   2. writes `media_file` (and alt text) as a merged patch.
   *
   * Ordering is the safety property: the previous image stays attached and
   * stays referenced until the upload AND the link both succeeded.
   */
  ctx.actions.register("set-media", async (params, actionContext) => {
    const companyId = requireStr(params.companyId, "companyId");
    const identifier = requireStr(params.caseIdentifier, "caseIdentifier");
    const assetId = requireStr(params.assetId, "assetId");

    const cfg = await readConfig(ctx, companyId);

    // Every failure below — the detail read, the "not attached to this case"
    // refusal, the patch itself — is logged HERE with the case and asset before
    // it goes back to the browser. The panel shows the operator one line and is
    // then closed; without this, a repointing that failed leaves nothing on the
    // server saying what was being pointed where. The error is rethrown
    // unchanged, so the action's behaviour is exactly as it was.
    const { detail, attachment, updated } = await (async () => {
      const found = await fetchCaseDetail(ctx, cfg, identifier, companyId);
      const linked = assertAttachedAsset(found, assetId);
      const patched = await patchCaseFields(
        ctx,
        cfg,
        identifier,
        buildMediaPatch({
          assetId,
          altText:
            typeof params.altText === "string" ? params.altText : undefined,
        }),
        undefined,
        companyId,
      );
      return { detail: found, attachment: linked, updated: patched };
    })().catch((err: unknown) => {
      ctx.logger.error(
        describeSetMediaFailure({ identifier, assetId, companyId, err }),
      );
      throw err;
    });

    await ctx.activity.log({
      companyId,
      message: `Case ${identifier} image replaced from the content calendar (asset ${assetId})`,
      entityType: "case",
      entityId: updated.id,
      metadata: {
        assetId,
        attachmentId: attachment.id,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        previousMediaFile: detail.mediaFile,
        actor: actionContext?.actor?.userId ?? "calendar-ui",
      },
    });

    return {
      ok: true,
      identifier,
      assetId,
      contentPath: attachment.contentPath,
      mediaFile: (updated.fields?.media_file as string | null) ?? null,
    };
  });

  /**
   * post-now — publish one case immediately.
   *
   * Runs the same gate as the scheduled job with `manual: true`, which ignores
   * the schedule because choosing the moment is the point. Every other
   * protection still applies: approval, double-post, caption, channel, adapter
   * and the emergency pause all block exactly as they do on the cron path.
   */
  ctx.actions.register("post-now", async (params, actionContext) => {
    const companyId = requireStr(params.companyId, "companyId");
    const caseId = requireStr(params.caseId, "caseId");
    const actor = actionContext?.actor?.userId ?? "calendar-ui";
    return await publishOne(ctx, companyId, caseId, `manual:${actor}`);
  });
}

// ---------------------------------------------------------------------------
// The publish sweep
// ---------------------------------------------------------------------------

interface SweepSummary {
  companyId: string;
  trigger: string;
  evaluated: number;
  published: number;
  dryRun: number;
  failed: number;
  skipped: number;
  paused: boolean;
  details: Array<{ case: string; outcome: string; reason: string }>;
}

interface AttemptResult {
  outcome: "sent" | "dry_run" | "failed" | "skipped";
  reason: string;
  url: string | null;
}

/**
 * Publish exactly one case. THE single publish path.
 *
 * Both the scheduled sweep and the Post Now button call this, so the gate,
 * the double-post interlock, the attempt log and the write-back can never
 * drift apart between the automatic and manual routes. `manual` is passed
 * straight through to the gate.
 */
async function attemptOne(
  ctx: PluginContext,
  cfg: CalendarConfig,
  companyId: string,
  entry: CalendarEntry,
  opts: { manual: boolean; alreadySent: boolean; now: Date },
): Promise<AttemptResult> {
  const adapter = adapterFor(entry.channel);
  const adapterReady = adapter ? await adapter.isConfigured(ctx, cfg) : false;

  const decision = evaluate({
    entry,
    now: opts.now,
    enabledChannels: cfg.channels.map((c) => c.toLowerCase()),
    lookbackHours: cfg.lookbackHours,
    alreadySent: opts.alreadySent,
    adapterReady,
    paused: cfg.paused,
    manual: opts.manual,
  });

  if (decision.outcome === "skipped") {
    return { outcome: "skipped", reason: decision.reason, url: null };
  }

  if (decision.outcome === "dry_run") {
    await recordAttempt(ctx, {
      companyId,
      entry,
      outcome: "dry_run",
      reason: decision.reason,
      postUrl: null,
      raw: { paused: true, manual: opts.manual },
    });
    return { outcome: "dry_run", reason: decision.reason, url: null };
  }

  // decision.outcome === "publish"
  //
  // The adapter publishes from a FILE PATH. When media_file is a native asset
  // reference the bytes are fetched from Paperclip and written to a temp file
  // for the length of this post; a legacy host path is handed through
  // unchanged, so everything that already publishes keeps publishing the same
  // way. A download failure is recorded as a failed attempt — never a
  // text-only post of a case that was meant to carry an image.
  let media: ResolvedMedia;
  try {
    media = await resolveMediaForPublish(entry.mediaFile, mediaDeps(ctx, cfg, companyId));
  } catch (err) {
    const reason = `could not read the attached image: ${
      err instanceof Error ? err.message : String(err)
    }`;
    await recordAttempt(ctx, {
      companyId,
      entry,
      outcome: "failed",
      reason,
      postUrl: null,
      raw: { mediaFile: entry.mediaFile },
    });
    return { outcome: "failed", reason, url: null };
  }

  let result;
  try {
    result = await (adapter as NonNullable<typeof adapter>).publish(ctx, cfg, {
      entry,
      caption: entry.caption as string,
      mediaFile: media.path,
    });
  } finally {
    await media.cleanup().catch((err: unknown) => {
      ctx.logger.warn(
        `[content-calendar] could not remove the temp copy of ${entry.mediaFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  if (!result.ok || !result.url) {
    const reason = result.error ?? "adapter returned no url";
    await recordAttempt(ctx, {
      companyId,
      entry,
      outcome: "failed",
      reason,
      postUrl: null,
      raw: result.raw,
    });
    return { outcome: "failed", reason, url: null };
  }

  await recordAttempt(ctx, {
    companyId,
    entry,
    outcome: "sent",
    reason: null,
    postUrl: result.url,
    raw: result.raw,
  });

  // Write the URL back onto the case, merged — never a bare field patch.
  try {
    await patchCaseFields(ctx, cfg, entry.identifier, {
      publish_url: result.url,
    }, undefined, companyId);
  } catch (err) {
    ctx.logger.warn(
      `[content-calendar] published ${entry.identifier} but could not write publish_url back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  await ctx.activity.log({
    companyId,
    message: `Published ${entry.identifier} to ${entry.channel}: ${result.url}`,
    entityType: "case",
    entityId: entry.id,
    metadata: { channel: entry.channel, url: result.url, manual: opts.manual },
  });

  return { outcome: "sent", reason: decision.reason, url: result.url };
}

/** Post Now: resolve one case, run the shared path with manual authorization. */
async function publishOne(
  ctx: PluginContext,
  companyId: string,
  caseId: string,
  trigger: string,
): Promise<{
  ok: boolean;
  outcome: string;
  reason: string;
  url: string | null;
  identifier: string | null;
}> {
  const cfg = await readConfig(ctx, companyId);
  const entries = await listSocialCases(ctx, cfg, companyId);
  const entry = entries.find((e) => e.id === caseId || e.identifier === caseId);

  if (!entry) {
    return {
      ok: false,
      outcome: "skipped",
      reason: `case ${caseId} not found among social_post cases`,
      url: null,
      identifier: null,
    };
  }

  const sent = await sentCaseIds(ctx, companyId);
  const res = await attemptOne(ctx, cfg, companyId, entry, {
    manual: true,
    alreadySent: sent.has(entry.id),
    now: new Date(),
  });

  ctx.logger.info(
    `[content-calendar] ${trigger} ${entry.identifier} -> ${res.outcome} (${res.reason})`,
  );

  return {
    ok: res.outcome === "sent",
    outcome: res.outcome,
    reason: res.reason,
    url: res.url,
    identifier: entry.identifier,
  };
}

async function publishSweep(
  ctx: PluginContext,
  companyId: string,
  trigger: string,
): Promise<SweepSummary> {
  const cfg: CalendarConfig = await readConfig(ctx, companyId);
  const summary: SweepSummary = {
    companyId,
    trigger,
    evaluated: 0,
    published: 0,
    dryRun: 0,
    failed: 0,
    skipped: 0,
    paused: cfg.paused,
    details: [],
  };

  let entries: CalendarEntry[];
  try {
    entries = await listSocialCases(ctx, cfg, companyId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`[content-calendar] cannot read cases: ${message}`);
    // RETHROW. Returning an empty summary here marked the job "completed
    // successfully" while it had read zero cases — 32 real failures reported
    // as 16 successes in 20 minutes, with the dashboard green throughout.
    // A sweep that cannot read its input has failed and must say so.
    throw err;
  }

  const sent = await sentCaseIds(ctx, companyId);
  const now = new Date();

  for (const entry of entries) {
    // Cheap pre-filter: only cases that could conceivably go out today.
    if (!entry.publishAt || entry.status === "cancelled" || entry.status === "done") {
      continue;
    }
    summary.evaluated += 1;

    const res = await attemptOne(ctx, cfg, companyId, entry, {
      manual: false,
      alreadySent: sent.has(entry.id),
      now,
    });

    if (res.outcome === "sent") summary.published += 1;
    else if (res.outcome === "dry_run") summary.dryRun += 1;
    else if (res.outcome === "failed") summary.failed += 1;
    else summary.skipped += 1;

    // "not due yet" would flood the log every 15 minutes for every future
    // post, so it is counted but not itemised.
    if (res.outcome !== "skipped" || res.reason !== "not due yet") {
      summary.details.push({
        case: entry.identifier,
        outcome: res.outcome,
        reason: res.url ?? res.reason,
      });
    }
  }

  ctx.logger.info(
    `[content-calendar] sweep(${trigger}) company=${companyId} evaluated=${summary.evaluated} sent=${summary.published} dry_run=${summary.dryRun} failed=${summary.failed} skipped=${summary.skipped} paused=${cfg.paused}`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_PUBLISH_DUE, async (job: PluginJobContext) => {
    await publishSweep(
      ctx,
      UNTRACE_COMPANY_ID,
      `job:${job.jobKey}:${job.trigger}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

let activeContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;
    ctx.logger.info(`[content-calendar] setup starting (${PLUGIN_ID})`);
    await registerDataHandlers(ctx);
    await registerActionHandlers(ctx);
    await registerJobs(ctx);
    ctx.logger.info(
      `[content-calendar] setup complete — namespace ${ctx.db.namespace}`,
    );
    if (ctx.db.namespace !== DB_NAMESPACE) {
      ctx.logger.error(
        `[content-calendar] NAMESPACE MISMATCH: host derived "${ctx.db.namespace}" but migrations are hardcoded to "${DB_NAMESPACE}". Every query will fail until these agree.`,
      );
    }
  },

  async onHealth() {
    const ctx = activeContext;
    if (!ctx) {
      return { status: "error" as const, message: "no active context" };
    }
    return {
      status: "ok" as const,
      message: "Content Calendar ready",
      details: {
        pluginId: PLUGIN_ID,
        namespace: ctx.db.namespace,
        namespaceMatches: ctx.db.namespace === DB_NAMESPACE,
      },
    };
  },

  async onShutdown() {
    activeContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
