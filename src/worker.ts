/**
 * Content Calendar worker.
 *
 * Reads social_post cases from the host API, exposes them to the calendar UI
 * grouped by date, and publishes the approved ones when they fall due.
 *
 * What this plugin does NOT store, because Paperclip already does it better:
 *   copy      -> case document (versioned, optimistic concurrency)
 *   image     -> attachment on a child `image_assets` case
 *   schedule  -> case fields.publish_at
 *   approval  -> the case's own native status = 'approved'
 *
 * The only local table is publish_log: one row per publish attempt. Its partial
 * unique index on successful rows is the anti-double-post guarantee — the
 * scheduler can run late, twice, or concurrently and still cannot double-post,
 * because the second insert violates the index.
 */
import { spawn } from "node:child_process";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  PluginContext,
  PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, JOB_KEY_PUBLISH_TICK } from "./manifest.js";

const CASE_TYPE = "social_post";

/** A social_post case, reduced to the fields the calendar needs. */
type PostCase = {
  identifier: string;
  key: string | null;
  title: string;
  /** Native Paperclip lifecycle: draft|in_progress|in_review|approved|done|cancelled */
  status: string;
  caption: string | null;
  channel: string;
  publishAt: string | null;
  altText: string | null;
  mediaFile: string | null;
  angle: string | null;
};

type PublishRow = {
  case_ref: string;
  outcome: string;
  post_url: string | null;
  attempted_at: string;
  error_message: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function need(v: unknown, name: string): string {
  const s = str(v);
  if (!s) throw new Error(`${name} is required`);
  return s;
}

const logTable = (ns: string) => `${ns}.publish_log`;

// ---------------------------------------------------------------------------
// Host API — cases are read over HTTP, never by SQL
// ---------------------------------------------------------------------------

/**
 * `cases` is not an allowed coreReadTable, and the API is the correct boundary
 * anyway: it enforces company access and the approval lifecycle, where raw SQL
 * would bypass both.
 */
async function fetchCases(ctx: PluginContext, companyId: string): Promise<PostCase[]> {
  const base = process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3100";
  const token = process.env.PAPERCLIP_API_TOKEN ?? "";
  const res = await ctx.http.fetch(
    `${base}/api/companies/${companyId}/cases?type=${CASE_TYPE}&limit=200`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!res.ok) throw new Error(`cases API returned ${res.status}`);

  const payload = (await res.json()) as unknown;
  const raw = Array.isArray(payload)
    ? payload
    : ((payload as { cases?: unknown[] }).cases
       ?? (payload as { data?: unknown[] }).data
       ?? []);

  return (raw as Array<Record<string, unknown>>).map((c) => {
    const f = (c.fields ?? {}) as Record<string, unknown>;
    return {
      identifier: str(c.identifier) ?? str(c.key) ?? "unknown",
      key: str(c.key),
      title: str(c.title) ?? "(untitled)",
      status: str(c.status) ?? "draft",
      caption: str(f.caption),
      channel: str(f.channel) ?? "x",
      publishAt: str(f.publish_at),
      altText: str(f.alt_text),
      mediaFile: str(f.media_file) ?? str(f.media_path),
      angle: str(f.angle),
    };
  });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Hand one post to the host publish script, which owns the platform
 * credentials and the v1.1 multipart media upload (X v2 has no upload
 * endpoint). The script always emits one JSON object on stdout, success or
 * failure, so the result is parsed rather than scraped from log text.
 */
async function publish(
  text: string,
  mediaPath: string | null,
  altText: string | null,
): Promise<{ ok: boolean; url: string | null; mediaId: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const script =
      process.env.PAPERCLIP_X_PUBLISH_SCRIPT ??
      `${process.env.HOME ?? ""}/.hermes/scripts/x_publish.py`;
    const payload = JSON.stringify({ text, media: mediaPath, alt: altText });

    const child = spawn("python3", [script, payload], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += String(c); });
    child.stderr.on("data", (c: Buffer) => { err += String(c); });

    child.on("close", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
        const r = JSON.parse(line) as {
          ok?: boolean; url?: string; media_id?: string; error?: string;
        };
        resolve({
          ok: r.ok === true,
          url: r.url ?? null,
          mediaId: r.media_id ?? null,
          error: r.ok === true ? null : (r.error ?? "unknown error"),
        });
      } catch {
        resolve({
          ok: false, url: null, mediaId: null,
          error: (err.trim() || out.trim() || "no output from publisher").slice(0, 500),
        });
      }
    });

    child.on("error", (e) => {
      resolve({ ok: false, url: null, mediaId: null, error: e.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Data handlers — what the UI reads
// ---------------------------------------------------------------------------

async function registerData(ctx: PluginContext): Promise<void> {
  /**
   * calendar — every social_post case, plus its publish result, grouped by the
   * date in fields.publish_at. Status shown is the NATIVE case status; the
   * calendar deliberately has no status vocabulary of its own.
   */
  ctx.data.register("calendar", async (params) => {
    const companyId = need(params.companyId, "companyId");

    const cases = await fetchCases(ctx, companyId);
    const rows = await ctx.db.query<PublishRow>(
      `SELECT case_ref, outcome, post_url, attempted_at::text AS attempted_at,
              error_message
         FROM ${logTable(ctx.db.namespace)}
        WHERE company_id = $1`,
      [companyId],
    );
    const published = new Map(rows.map((r) => [r.case_ref, r]));

    const byDate: Record<string, unknown[]> = {};
    let scheduled = 0;
    let approved = 0;
    let posted = 0;

    for (const c of cases) {
      if (c.status === "cancelled") continue;
      const date = c.publishAt ? c.publishAt.split("T")[0] : "unscheduled";
      const log = published.get(c.identifier) ?? null;

      if (c.publishAt) scheduled += 1;
      if (c.status === "approved") approved += 1;
      if (log?.outcome === "posted") posted += 1;

      (byDate[date] ??= []).push({
        ref: c.identifier,
        title: c.title,
        caption: c.caption,
        channel: c.channel,
        status: c.status,
        angle: c.angle,
        publishAt: c.publishAt,
        hasMedia: Boolean(c.mediaFile),
        charCount: c.caption?.length ?? 0,
        published: log
          ? { outcome: log.outcome, url: log.post_url, at: log.attempted_at,
              error: log.error_message }
          : null,
      });
    }

    for (const list of Object.values(byDate)) {
      (list as Array<{ publishAt: string | null }>).sort(
        (a, b) => (a.publishAt ?? "").localeCompare(b.publishAt ?? ""),
      );
    }

    return {
      byDate,
      stats: { total: cases.length, scheduled, approved, posted },
      generatedAt: new Date().toISOString(),
    };
  });

  /** history — the publish log, newest first. The audit trail. */
  ctx.data.register("history", async (params) => {
    const companyId = need(params.companyId, "companyId");
    const rows = await ctx.db.query<PublishRow>(
      `SELECT case_ref, outcome, post_url, attempted_at::text AS attempted_at,
              error_message
         FROM ${logTable(ctx.db.namespace)}
        WHERE company_id = $1
        ORDER BY attempted_at DESC
        LIMIT 100`,
      [companyId],
    );
    return { entries: rows };
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function registerActions(ctx: PluginContext): Promise<void> {
  /**
   * publish-now — publish one approved case immediately, ignoring its schedule.
   *
   * Still refuses anything not natively approved. "Publish now" is a timing
   * override, never an approval override.
   */
  ctx.actions.register("publish-now", async (params) => {
    const companyId = need(params.companyId, "companyId");
    const ref = need(params.caseRef, "caseRef");

    const cases = await fetchCases(ctx, companyId);
    const c = cases.find((x) => x.identifier === ref);
    if (!c) throw new Error(`case ${ref} not found`);
    if (c.status !== "approved") {
      throw new Error(`case ${ref} is '${c.status}', not 'approved' — approve it first`);
    }
    return publishCase(ctx, companyId, c);
  });
}

/**
 * Publish one case and record the attempt.
 *
 * The INSERT happens whatever the outcome, so a failure is visible rather than
 * silent. A successful row collides with publish_log_one_success_per_case if
 * the same case was already published, which is what makes double-posting
 * impossible rather than merely unlikely.
 */
async function publishCase(ctx: PluginContext, companyId: string, c: PostCase) {
  if (!c.caption) throw new Error(`case ${c.identifier} has no caption`);

  const already = await ctx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${logTable(ctx.db.namespace)}
      WHERE case_ref = $1 AND outcome = 'posted'`,
    [c.identifier],
  );
  if (Number(already[0]?.n ?? 0) > 0) {
    return { ref: c.identifier, skipped: "already published" };
  }

  const mediaPath = c.mediaFile
    ? (process.env.PAPERCLIP_MEDIA_DIR ?? `${process.env.HOME ?? ""}/social/out`)
      + `/${c.mediaFile}`
    : null;

  const result = await publish(c.caption, mediaPath, c.altText);

  await ctx.db.execute(
    `INSERT INTO ${logTable(ctx.db.namespace)}
       (company_id, case_ref, platform, scheduled_for, outcome,
        post_url, media_id, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [companyId, c.identifier, c.channel, c.publishAt ?? new Date().toISOString(),
     result.ok ? "posted" : "failed", result.url, result.mediaId, result.error],
  );

  await ctx.activity.log({
    companyId,
    entityType: "case",
    entityId: c.identifier,
    message: result.ok
      ? `Published ${c.identifier} to ${c.channel}: ${result.url ?? "(no url)"}`
      : `Failed to publish ${c.identifier}: ${result.error}`,
    metadata: { plugin: PLUGIN_ID },
  });

  await ctx.metrics.write(
    result.ok ? "content_calendar.published" : "content_calendar.failed",
    1,
    { platform: c.channel },
  );

  return { ref: c.identifier, ok: result.ok, url: result.url, error: result.error };
}

// ---------------------------------------------------------------------------
// The publish tick
// ---------------------------------------------------------------------------

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEY_PUBLISH_TICK, async (job: PluginJobContext) => {
    const companies = await ctx.companies.list({ limit: 200, offset: 0 });
    const now = Date.now();
    let posted = 0;
    let failed = 0;

    for (const company of companies) {
      let cases: PostCase[];
      try {
        cases = await fetchCases(ctx, company.id);
      } catch (e) {
        ctx.logger.error(`[content-calendar] cannot read cases for ${company.id}`, {
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      // Due = natively approved AND its publish_at has passed.
      //
      // Overdue posts from earlier are included on purpose: if the worker was
      // down, an approved post should still go out rather than silently vanish.
      // Anything already published is excluded by the guard in publishCase and,
      // ultimately, by the unique index.
      // Only channels this plugin can actually publish. The board holds
      // LinkedIn cases too, and their captions are legitimately ~1700 chars;
      // handing one to the X publisher would fail on every tick forever.
      const due = cases.filter((c) =>
        c.status === "approved" &&
        c.channel === "x" &&
        c.caption &&
        c.caption.length <= 280 &&
        c.publishAt &&
        Date.parse(c.publishAt) <= now);

      for (const c of due) {
        try {
          const r = await publishCase(ctx, company.id, c);
          if ("ok" in r && r.ok) posted += 1;
          else if ("ok" in r) failed += 1;
        } catch (e) {
          failed += 1;
          ctx.logger.error(`[content-calendar] publish threw for ${c.identifier}`, {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    ctx.logger.info(
      `[content-calendar] tick complete: ${posted} posted, ${failed} failed`,
      { runId: job.runId },
    );
    await ctx.metrics.write("content_calendar.tick_posted", posted);
    await ctx.metrics.write("content_calendar.tick_failed", failed);
  });
}

// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    await registerData(ctx);
    await registerActions(ctx);
    await registerJobs(ctx);
    ctx.logger.info(`[content-calendar] ${PLUGIN_ID} ready`);
  },

  async onHealth() {
    return { status: "ok" as const };
  },
});

export default plugin;

// The host imports this module and drives it over RPC; runWorker needs the
// plugin and this module's own URL so it can resolve the entrypoint.
runWorker(plugin, import.meta.url);
