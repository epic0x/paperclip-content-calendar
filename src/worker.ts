import { spawn } from "node:child_process";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import {
  CONTENT_PROJECT_KEY,
  JOB_KEY_DAILY_POST_CHECK,
  PLUGIN_ID,
} from "./manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Post = {
  id: string;
  company_id: string;
  issue_id: string | null;
  platform: string;
  content: string;
  scheduled_date: string;
  scheduled_time: string | null;
  status: string;
  posted_at: string | null;
  post_url: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type CalendarDay = {
  date: string;
  posts: Post[];
};

type PostStats = {
  total: number;
  draft: number;
  approved: number;
  posted: number;
  failed: number;
  cancelled: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postsTable(namespace: string): string {
  return `${namespace}.posts`;
}

function batchesTable(namespace: string): string {
  return `${namespace}.batches`;
}

function strField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireStr(value: unknown, name: string): string {
  const s = strField(value);
  if (!s) throw new Error(`${name} is required`);
  return s;
}

async function runXPost(content: string): Promise<{ success: boolean; url: string | null; error: string | null }> {
  return new Promise((resolve) => {
    const scriptPath = "/root/.openclaw/workspace/skills/x-api/scripts/x-post.mjs";
    const child = spawn("node", [scriptPath, content], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });

    child.on("close", (code) => {
      if (code === 0) {
        // Try to extract URL from stdout
        const urlMatch = stdout.match(/https:\/\/(?:twitter|x)\.com\/\S+/);
        resolve({ success: true, url: urlMatch ? urlMatch[0] : null, error: null });
      } else {
        resolve({ success: false, url: null, error: stderr.trim() || stdout.trim() || `Exit code ${code}` });
      }
    });

    child.on("error", (err) => {
      resolve({ success: false, url: null, error: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// Data handlers
// ---------------------------------------------------------------------------

async function registerDataHandlers(ctx: PluginContext): Promise<void> {
  // calendar — returns posts grouped by date for the next N days
  ctx.data.register("calendar", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const days = typeof params.days === "number" ? Math.min(params.days, 60) : 14;

    const posts = await ctx.db.query<Post>(
      `SELECT id, company_id, issue_id, platform, content, scheduled_date::text AS scheduled_date,
              scheduled_time::text AS scheduled_time, status, posted_at::text AS posted_at,
              post_url, error_message, metadata, created_by,
              created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${postsTable(ctx.db.namespace)}
       WHERE company_id = $1
         AND scheduled_date >= CURRENT_DATE
         AND scheduled_date < CURRENT_DATE + INTERVAL '${days} days'
         AND status != 'cancelled'
       ORDER BY scheduled_date ASC, scheduled_time ASC NULLS LAST, created_at ASC`,
      [companyId],
    );

    // Group by date
    const byDate = new Map<string, Post[]>();
    for (const post of posts) {
      const dateStr = post.scheduled_date;
      if (!byDate.has(dateStr)) byDate.set(dateStr, []);
      byDate.get(dateStr)!.push(post);
    }

    // Build calendar days array covering the range
    const calendar: CalendarDay[] = [];
    const today = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      calendar.push({ date: dateStr, posts: byDate.get(dateStr) ?? [] });
    }

    return { calendar, totalPosts: posts.length };
  });

  // post — returns a single post by ID
  ctx.data.register("post", async (params) => {
    const postId = requireStr(params.postId, "postId");
    const companyId = requireStr(params.companyId, "companyId");

    const rows = await ctx.db.query<Post>(
      `SELECT id, company_id, issue_id, platform, content, scheduled_date::text AS scheduled_date,
              scheduled_time::text AS scheduled_time, status, posted_at::text AS posted_at,
              post_url, error_message, metadata, created_by,
              created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${postsTable(ctx.db.namespace)}
       WHERE id = $1 AND company_id = $2`,
      [postId, companyId],
    );

    return rows[0] ?? null;
  });

  // stats — posting stats
  ctx.data.register("stats", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");

    const rows = await ctx.db.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM ${postsTable(ctx.db.namespace)}
       WHERE company_id = $1
       GROUP BY status`,
      [companyId],
    );

    const stats: PostStats = { total: 0, draft: 0, approved: 0, posted: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      const count = parseInt(row.count, 10);
      stats.total += count;
      const key = row.status as keyof PostStats;
      if (key in stats) stats[key] = count;
    }

    return stats;
  });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function registerActionHandlers(ctx: PluginContext): Promise<void> {
  // approve-post
  ctx.actions.register("approve-post", async (params) => {
    const postId = requireStr(params.postId, "postId");
    const companyId = requireStr(params.companyId, "companyId");

    await ctx.db.execute(
      `UPDATE ${postsTable(ctx.db.namespace)}
       SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
      [postId, companyId],
    );

    const rows = await ctx.db.query<Post>(
      `SELECT id, status FROM ${postsTable(ctx.db.namespace)} WHERE id = $1`,
      [postId],
    );

    await ctx.activity.log({
      companyId,
      entityType: "post",
      entityId: postId,
      message: `Post approved for publishing`,
      metadata: { plugin: PLUGIN_ID },
    });

    return rows[0] ?? { id: postId, status: "approved" };
  });

  // unapprove-post
  ctx.actions.register("unapprove-post", async (params) => {
    const postId = requireStr(params.postId, "postId");
    const companyId = requireStr(params.companyId, "companyId");

    await ctx.db.execute(
      `UPDATE ${postsTable(ctx.db.namespace)}
       SET status = 'draft', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status = 'approved'`,
      [postId, companyId],
    );

    return { id: postId, status: "draft" };
  });

  // reschedule-post
  ctx.actions.register("reschedule-post", async (params) => {
    const postId = requireStr(params.postId, "postId");
    const companyId = requireStr(params.companyId, "companyId");
    const newDate = requireStr(params.newDate, "newDate");
    const newTime = strField(params.newTime);

    await ctx.db.execute(
      `UPDATE ${postsTable(ctx.db.namespace)}
       SET scheduled_date = $3, scheduled_time = $4, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'approved')`,
      [postId, companyId, newDate, newTime],
    );

    await ctx.activity.log({
      companyId,
      entityType: "post",
      entityId: postId,
      message: `Post rescheduled to ${newDate}${newTime ? ` at ${newTime}` : ""}`,
      metadata: { plugin: PLUGIN_ID },
    });

    return { id: postId, scheduled_date: newDate, scheduled_time: newTime };
  });

  // cancel-post
  ctx.actions.register("cancel-post", async (params) => {
    const postId = requireStr(params.postId, "postId");
    const companyId = requireStr(params.companyId, "companyId");

    await ctx.db.execute(
      `UPDATE ${postsTable(ctx.db.namespace)}
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'approved')`,
      [postId, companyId],
    );

    return { id: postId, status: "cancelled" };
  });

  // edit-post
  ctx.actions.register("edit-post", async (params) => {
    const postId = requireStr(params.postId, "postId");
    const companyId = requireStr(params.companyId, "companyId");
    const content = requireStr(params.content, "content");

    if (content.length > 280) {
      throw new Error("Post content exceeds 280 characters (X/Twitter limit)");
    }

    await ctx.db.execute(
      `UPDATE ${postsTable(ctx.db.namespace)}
       SET content = $3, updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'approved')`,
      [postId, companyId, content],
    );

    return { id: postId, content };
  });

  // generate-batch — creates 10 posts for the next 10 days
  ctx.actions.register("generate-batch", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const topic = strField(params.topic) ?? "company updates";
    const daysCount = typeof params.daysCount === "number" ? Math.min(params.daysCount, 30) : 10;

    // Get the managed project ID
    const projects = await ctx.projects.list({ companyId, limit: 200, offset: 0 });
    const contentProject = projects.find((p) => p.name === "Content Calendar");

    // Create a batch record
    const batchRows = await ctx.db.query<{ id: string }>(
      `INSERT INTO ${batchesTable(ctx.db.namespace)} (company_id, days_count, status)
       VALUES ($1, $2, 'generated')
       RETURNING id`,
      [companyId, daysCount],
    );
    const batchId = batchRows[0]?.id;

    const today = new Date();
    const createdPosts: Array<{ id: string; date: string; content: string }> = [];

    // Generate sample posts for each day
    const postTemplates = [
      `🚀 Exciting updates from our team today! We're making great progress on our goals. Stay tuned for more details. #startup #progress`,
      `💡 Did you know? Our team is constantly innovating to bring you better solutions. Here's what we've been working on. #innovation`,
      `🎯 Focus is key to success. Our team is laser-focused on delivering value every single day. What are you working on today? #productivity`,
      `✨ Great things take time. We're building something special and can't wait to share it with you. #building #startup`,
      `🤝 Teamwork makes the dream work! Shoutout to our incredible team for their dedication and hard work. #team #culture`,
      `📊 Progress update: we're hitting our milestones and staying on track. Small wins add up to big victories! #goals #metrics`,
      `🌟 The best investment you can make is in yourself. Our team never stops learning and growing. #learning #growth`,
      `💪 Challenges are opportunities in disguise. Our team tackles every obstacle head-on. #resilience #startup`,
      `🔥 We're hiring! If you're passionate about what we do, come join our amazing team. Check the link in bio. #hiring #jobs`,
      `🎉 Celebrating a milestone today! Every step forward matters. Thank you to everyone who has supported us on this journey. #milestone`,
    ];

    for (let i = 0; i < daysCount; i++) {
      const scheduledDate = new Date(today);
      scheduledDate.setDate(today.getDate() + i + 1);
      const dateStr = scheduledDate.toISOString().slice(0, 10);

      const template = postTemplates[i % postTemplates.length] ?? postTemplates[0]!;
      const content = template;

      // Insert post into DB
      const postRows = await ctx.db.query<{ id: string }>(
        `INSERT INTO ${postsTable(ctx.db.namespace)}
         (company_id, platform, content, scheduled_date, status, metadata)
         VALUES ($1, 'x', $2, $3, 'draft', $4::jsonb)
         RETURNING id`,
        [companyId, content, dateStr, JSON.stringify({ batchId, topic, dayIndex: i })],
      );
      const postId = postRows[0]?.id;

      if (postId) {
        createdPosts.push({ id: postId, date: dateStr, content });

        // Create an issue in the managed project if it exists
        if (contentProject) {
          try {
            const issue = await ctx.issues.create({
              companyId,
              projectId: contentProject.id,
              title: `Post for ${dateStr}: ${content.slice(0, 60)}...`,
              description: `**Scheduled Date:** ${dateStr}\n**Platform:** X (Twitter)\n**Status:** Draft\n\n**Content:**\n${content}\n\n**Post ID:** ${postId}`,
            });

            // Link issue to post
            await ctx.db.execute(
              `UPDATE ${postsTable(ctx.db.namespace)} SET issue_id = $2 WHERE id = $1`,
              [postId, issue.id],
            );
          } catch (err) {
            ctx.logger.warn(`Failed to create issue for post ${postId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    await ctx.activity.log({
      companyId,
      message: `Generated batch of ${createdPosts.length} posts for the next ${daysCount} days`,
      metadata: { plugin: PLUGIN_ID, batchId, topic },
    });

    await ctx.metrics.write("content_calendar.batch_generated", 1, {
      days_count: String(daysCount),
      posts_created: String(createdPosts.length),
    });

    return {
      batchId,
      postsCreated: createdPosts.length,
      posts: createdPosts,
    };
  });

  // create-post — create a single post manually
  ctx.actions.register("create-post", async (params) => {
    const companyId = requireStr(params.companyId, "companyId");
    const content = requireStr(params.content, "content");
    const scheduledDate = requireStr(params.scheduledDate, "scheduledDate");
    const scheduledTime = strField(params.scheduledTime);
    const platform = strField(params.platform) ?? "x";

    if (content.length > 280) {
      throw new Error("Post content exceeds 280 characters (X/Twitter limit)");
    }

    const rows = await ctx.db.query<{ id: string }>(
      `INSERT INTO ${postsTable(ctx.db.namespace)}
       (company_id, platform, content, scheduled_date, scheduled_time, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       RETURNING id`,
      [companyId, platform, content, scheduledDate, scheduledTime],
    );

    const postId = rows[0]?.id;
    if (!postId) throw new Error("Failed to create post");

    await ctx.activity.log({
      companyId,
      entityType: "post",
      entityId: postId,
      message: `New post created for ${scheduledDate}`,
      metadata: { plugin: PLUGIN_ID },
    });

    return { id: postId, content, scheduledDate, status: "draft" };
  });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function registerJobs(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEY_DAILY_POST_CHECK, async (job: PluginJobContext) => {
    ctx.logger.info(`[content-calendar] Daily post check job started`, { runId: job.runId });

    // Get all companies
    const companies = await ctx.companies.list({ limit: 200, offset: 0 });
    const results: Array<{
      companyId: string;
      postId: string;
      status: "posted" | "failed";
      error?: string;
    }> = [];

    for (const company of companies) {
      const companyId = company.id;

      // Find approved posts scheduled for today
      const todayPosts = await ctx.db.query<Post>(
        `SELECT id, content, platform
         FROM ${postsTable(ctx.db.namespace)}
         WHERE company_id = $1
           AND status = 'approved'
           AND scheduled_date = CURRENT_DATE`,
        [companyId],
      );

      ctx.logger.info(`[content-calendar] Found ${todayPosts.length} posts to publish for company ${companyId}`);

      for (const post of todayPosts) {
        try {
          const result = await runXPost(post.content);

          if (result.success) {
            await ctx.db.execute(
              `UPDATE ${postsTable(ctx.db.namespace)}
               SET status = 'posted', posted_at = NOW(), post_url = $2, updated_at = NOW()
               WHERE id = $1`,
              [post.id, result.url],
            );

            results.push({ companyId, postId: post.id, status: "posted" });
            await ctx.metrics.write("content_calendar.post_published", 1, { platform: post.platform });
          } else {
            await ctx.db.execute(
              `UPDATE ${postsTable(ctx.db.namespace)}
               SET status = 'failed', error_message = $2, updated_at = NOW()
               WHERE id = $1`,
              [post.id, result.error],
            );

            results.push({ companyId, postId: post.id, status: "failed", error: result.error ?? undefined });
            await ctx.metrics.write("content_calendar.post_failed", 1, { platform: post.platform });
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await ctx.db.execute(
            `UPDATE ${postsTable(ctx.db.namespace)}
             SET status = 'failed', error_message = $2, updated_at = NOW()
             WHERE id = $1`,
            [post.id, errorMessage],
          );

          results.push({ companyId, postId: post.id, status: "failed", error: errorMessage });
        }
      }
    }

    const posted = results.filter((r) => r.status === "posted").length;
    const failed = results.filter((r) => r.status === "failed").length;

    ctx.logger.info(`[content-calendar] Daily post check complete: ${posted} posted, ${failed} failed`);

    return {
      jobKey: job.jobKey,
      runId: job.runId,
      posted,
      failed,
      results,
      completedAt: new Date().toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function registerEventHandlers(ctx: PluginContext): Promise<void> {
  // Sync issue status changes to post status
  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    const payload = event.payload as { issueId?: string; status?: string; companyId?: string } | null;
    if (!payload?.issueId || !payload?.companyId) return;

    try {
      // Find posts linked to this issue
      const posts = await ctx.db.query<{ id: string; status: string }>(
        `SELECT id, status FROM ${postsTable(ctx.db.namespace)}
         WHERE issue_id = $1 AND company_id = $2`,
        [payload.issueId, payload.companyId],
      );

      if (posts.length === 0) return;

      // Map issue status to post status
      const issueStatus = payload.status;
      let newPostStatus: string | null = null;

      if (issueStatus === "done") newPostStatus = "posted";
      else if (issueStatus === "cancelled") newPostStatus = "cancelled";
      else if (issueStatus === "in_progress") newPostStatus = "approved";

      if (newPostStatus) {
        for (const post of posts) {
          if (post.status !== newPostStatus) {
            await ctx.db.execute(
              `UPDATE ${postsTable(ctx.db.namespace)}
               SET status = $2, updated_at = NOW()
               WHERE id = $1`,
              [post.id, newPostStatus],
            );
          }
        }
      }
    } catch (err) {
      ctx.logger.warn(`[content-calendar] Failed to sync issue status: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

let activeContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;
    ctx.logger.info("[content-calendar] Plugin setup starting");

    await registerEventHandlers(ctx);
    await registerJobs(ctx);
    await registerDataHandlers(ctx);
    await registerActionHandlers(ctx);

    ctx.logger.info("[content-calendar] Plugin setup complete");
  },

  async onHealth() {
    const ctx = activeContext;
    return {
      status: "ok" as const,
      message: "Content Calendar plugin ready",
      details: {
        hasContext: Boolean(ctx),
        pluginId: PLUGIN_ID,
      },
    };
  },

  async onShutdown() {
    activeContext = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
