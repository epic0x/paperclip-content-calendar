import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "untrace.plugin-content-calendar";
export const PLUGIN_VERSION = "0.2.0";

export const PAGE_SLOT_ID = "content-calendar-page";
export const PAGE_EXPORT_NAME = "ContentCalendarPage";
export const PAGE_ROUTE_PATH = "content-calendar";

export const DASHBOARD_WIDGET_SLOT_ID = "content-calendar-dashboard-widget";
export const DASHBOARD_WIDGET_EXPORT_NAME = "ContentCalendarDashboardWidget";

export const JOB_KEY_PUBLISH_TICK = "publish-tick";

/**
 * Content Calendar.
 *
 * A calendar VIEW over Paperclip cases, plus a publisher.
 *
 * Design rule, from skills/paperclip/references/cases.md: cases are "agent-owned
 * work records for durable outputs such as blog posts ... or generated asset
 * sets", and the documented pattern is a parent case + an `image_assets` child
 * case + attachments + the native review lifecycle. That is exactly a social
 * post. So this plugin stores NONE of it.
 *
 *   copy      -> case document (versioned, optimistic-concurrency)
 *   image     -> attachment on a child `image_assets` case
 *   schedule  -> case fields.publish_at
 *   approval  -> the case's own native status = 'approved'
 *   result    -> publish_log, in this plugin's schema — the only thing cases lack
 *
 * An earlier draft of this plugin carried its own posts table, its own status
 * vocabulary, its own auto_post flag and an agent that generated posts. All of
 * it duplicated something the host already does better, so all of it is gone.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Content Calendar",
  description:
    "Calendar view over social_post cases, and a publisher for approved posts. " +
    "Cases hold the content and the approval; this shows them by date and posts " +
    "them when they are due.",
  author: "Untrace",
  categories: ["automation", "ui"],

  // Deliberately narrow. The previous manifest also requested projects.managed,
  // issues.create/update, agents.managed and routines.managed — all for the
  // post-generating agent that no longer exists. A plugin that can only read
  // companies, write its own log, publish, and draw a page is far easier to
  // reason about when it is the first plugin ever installed on the instance.
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "jobs.schedule",
    "http.outbound",
    "activity.log.write",
    "metrics.write",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },

  database: {
    namespaceSlug: "content_calendar",
    migrationsDir: "migrations",
    // `cases` is not an allowed coreReadTable in the SDK, so case data is read
    // over the host HTTP API instead — which is the correct boundary anyway:
    // the API enforces company access and the approval lifecycle, raw SQL
    // would bypass both.
    coreReadTables: ["companies"],
  },

  ui: {
    slots: [
      {
        id: PAGE_SLOT_ID,
        type: "page",
        exportName: PAGE_EXPORT_NAME,
        routePath: PAGE_ROUTE_PATH,
        displayName: "Content Calendar",
      },
      {
        id: DASHBOARD_WIDGET_SLOT_ID,
        type: "dashboardWidget",
        exportName: DASHBOARD_WIDGET_EXPORT_NAME,
        displayName: "Upcoming posts",
      },
    ],
    launchers: [
      {
        id: "content-calendar-launcher",
        displayName: "Content Calendar",
        placementZone: "sidebar",
        // Navigates to the page slot's company-scoped route,
        // i.e. /:companyPrefix/content-calendar
        action: { type: "navigate", target: PAGE_ROUTE_PATH },
      },
    ],
  },

  jobs: [
    {
      jobKey: JOB_KEY_PUBLISH_TICK,
      displayName: "Publish due approved posts",
      description:
        "Every 15 minutes: find social_post cases whose status is approved and " +
        "whose publish_at has passed, and publish them. Cases that already have " +
        "a successful publish_log row are skipped.",
      // Plain cron string — PluginJobDeclaration.schedule is a string, not an
      // object. The host owns timing; the job body only decides what is due.
      schedule: "*/15 * * * *",
    },
  ],
};

export default manifest;
