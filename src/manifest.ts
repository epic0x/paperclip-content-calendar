import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Plugin identity.
 *
 * The host derives this plugin's Postgres schema as
 *   plugin_<namespaceSlug>_<sha256(PLUGIN_ID).slice(0,10)>
 * which for these two values is
 *   plugin_content_calendar_cc002f61cd
 * and that literal name is hard-coded in migrations/001_publish_log.sql.
 * Changing PLUGIN_ID or NAMESPACE_SLUG changes the hash and breaks every
 * migration statement. If you must change them, recompute the namespace first.
 */
export const PLUGIN_ID = "untrace.plugin-content-calendar";
export const PLUGIN_VERSION = "0.2.0";
export const NAMESPACE_SLUG = "content_calendar";
export const DB_NAMESPACE = "plugin_content_calendar_cc002f61cd";

export const PAGE_SLOT_ID = "content-calendar-page";
export const PAGE_EXPORT_NAME = "ContentCalendarPage";
export const SIDEBAR_SLOT_ID = "content-calendar-sidebar";
export const SIDEBAR_EXPORT_NAME = "ContentCalendarSidebar";
export const WIDGET_SLOT_ID = "content-calendar-widget";
export const WIDGET_EXPORT_NAME = "ContentCalendarWidget";

export const JOB_PUBLISH_DUE = "publish-due-cases";

/** Case type this plugin schedules. */
export const CASE_TYPE = "social_post";

/**
 * The only case field this plugin depends on that Paperclip does not model
 * natively. Approval is read from the native `cases.status === "approved"`,
 * NOT from a JSON field.
 */
export const FIELD_PUBLISH_AT = "publish_at";
export const FIELD_CHANNEL = "channel";
export const FIELD_CAPTION = "caption";
export const FIELD_PUBLISH_URL = "publish_url";
export const FIELD_MEDIA = "media_file";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Content Calendar",
  description:
    "Month calendar for social_post cases plus a publish job. Cases stay the source of truth: this plugin reads them, lays them out by publish_at, and records what it published. It does not author or duplicate content.",
  author: "Untrace Network",
  categories: ["automation", "ui"],

  capabilities: [
    // Read-only context
    "companies.read",
    "projects.read",
    // Own schema: publish log + schedule overrides
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    // Publish job
    "jobs.schedule",
    // Reaching the Paperclip Cases API and the channel adapter
    "http.outbound",
    // Board API key + channel tokens come from operator config as secret refs
    "secrets.read-ref",
    // Audit trail in the Paperclip activity log
    "activity.log.write",
    // UI surfaces
    "ui.page.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
    "ui.action.register",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },

  database: {
    namespaceSlug: NAMESPACE_SLUG,
    migrationsDir: "migrations",
    // NOTE: `cases` is deliberately absent — it is not in the host's
    // PLUGIN_DATABASE_CORE_READ_TABLES whitelist, so it cannot be read from
    // plugin SQL at all. Case reads go over the authenticated HTTP API.
    coreReadTables: ["companies", "projects"],
  },

  instanceConfigSchema: {
    type: "object",
    required: ["apiBaseUrl"],
    properties: {
      apiBaseUrl: {
        type: "string",
        title: "Paperclip API base URL",
        description:
          "Where the plugin reaches the Cases API. Use the loopback origin on the host, e.g. http://127.0.0.1:3100",
        default: "http://127.0.0.1:3100",
      },
      boardApiKeyRef: {
        type: "object",
        title: "Board API key (secret reference)",
        description:
          "Secret reference to a board API key created with `paperclipai token board create`. Required to read cases. Without it the calendar renders empty and the publish job reports a configuration error rather than failing silently.",
      },
      autoPost: {
        type: "boolean",
        title: "Actually publish",
        description:
          "OFF by default and must stay off until JC approves. When off, the publish job evaluates every due case and records a dry_run attempt without contacting any channel. Turning this on is the only thing that can put a post in public.",
        default: false,
      },
      channels: {
        type: "array",
        title: "Enabled channels",
        description:
          "Channel keys the publish job is allowed to send to. A case whose channel is not listed is skipped with a reason.",
        items: { type: "string" },
        default: [],
      },
      lookbackHours: {
        type: "number",
        title: "Catch-up window (hours)",
        description:
          "How far back the publish job will still pick up a missed case. Beyond this it is skipped as stale rather than posted late.",
        default: 6,
      },
    },
  },

  jobs: [
    {
      jobKey: JOB_PUBLISH_DUE,
      displayName: "Publish due cases",
      description:
        "Every 15 minutes: find approved social_post cases whose publish_at is due and not yet published, then publish them. With autoPost off, records a dry-run attempt instead of sending.",
      schedule: "*/15 * * * *",
    },
  ],

  ui: {
    slots: [
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Content Calendar",
        exportName: PAGE_EXPORT_NAME,
        routePath: "content-calendar",
      },
      {
        type: "sidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "Content Calendar",
        exportName: SIDEBAR_EXPORT_NAME,
        order: 40,
      },
      {
        type: "dashboardWidget",
        id: WIDGET_SLOT_ID,
        displayName: "Upcoming posts",
        exportName: WIDGET_EXPORT_NAME,
      },
    ],
  },
};

export default manifest;
