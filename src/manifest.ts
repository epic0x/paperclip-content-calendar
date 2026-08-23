import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-content-calendar";
export const PLUGIN_VERSION = "0.1.0";

export const CONTENT_PROJECT_KEY = "content-calendar";
export const CONTENT_MANAGER_AGENT_KEY = "content-manager";
export const DAILY_POST_ROUTINE_KEY = "daily-post-check";

export const PAGE_SLOT_ID = "content-calendar-page";
export const PAGE_EXPORT_NAME = "ContentCalendarPage";
export const SIDEBAR_SLOT_ID = "content-calendar-sidebar";
export const SIDEBAR_EXPORT_NAME = "ContentCalendarSidebar";
export const DASHBOARD_WIDGET_SLOT_ID = "content-calendar-dashboard-widget";
export const DASHBOARD_WIDGET_EXPORT_NAME = "ContentCalendarDashboardWidget";

export const JOB_KEY_DAILY_POST_CHECK = "daily-post-check";

const DAILY_POST_DESCRIPTION = `Check for approved posts scheduled for today and post them to X (Twitter).

Run procedure:
1. Query the content calendar for posts with status='approved' AND scheduled_date=CURRENT_DATE.
2. For each approved post, execute the x-post script with the post content.
3. On success: update status to 'posted', record the post URL and timestamp.
4. On failure: update status to 'failed', record the error message.
5. Report results in the routine issue.`;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Content Calendar",
  description: "Social media content calendar for scheduling and auto-posting to X (Twitter). Generate batches of posts, approve them, and let the daily job handle publishing.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "companies.read",
    "projects.read",
    "projects.managed",
    "issues.read",
    "issues.create",
    "issues.update",
    "agents.read",
    "agents.managed",
    "routines.managed",
    "events.subscribe",
    "jobs.schedule",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "activity.log.write",
    "metrics.write",
    "http.outbound",
    "ui.sidebar.register",
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
    // NOTE: `cases` is deliberately absent. The SDK's coreReadTables union does
    // not include it (verified against @paperclipai/plugin-sdk 2026.817.0), so
    // the plugin cannot read the cases table directly. import-cases therefore
    // goes through the host HTTP API instead, which is the correct boundary
    // anyway: the API enforces the approval ladder, raw SQL would not.
    coreReadTables: ["companies", "issues", "projects"],
  },
  projects: [
    {
      projectKey: CONTENT_PROJECT_KEY,
      displayName: "Content Calendar",
      description: "Plugin-managed project for content calendar posts and scheduling.",
      status: "in_progress",
      color: "#7c3aed",
    },
  ],
  agents: [
    {
      agentKey: CONTENT_MANAGER_AGENT_KEY,
      displayName: "Content Manager",
      role: "content-creator",
      title: "Social Media Content Manager",
      icon: "pencil",
      capabilities: "Generates social media posts, schedules content, and manages the content calendar.",
      adapterType: "claude_local",
      adapterPreference: ["claude_local", "codex_local", "gemini_local"],
      adapterConfig: {
        dangerouslySkipPermissions: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        sandbox: true,
      },
      status: "paused",
      budgetMonthlyCents: 0,
      instructions: {
        entryFile: "AGENTS.md",
        content: `# Content Manager Agent

You are a social media content manager. Your job is to generate engaging, on-brand posts for X (Twitter).

## Responsibilities
- Generate 10 posts for the next 10 days when requested via the generate-batch action
- Each post should be under 280 characters
- Posts should be varied, engaging, and relevant to the company
- Create corresponding issues in the Content Calendar project for tracking

## Post Generation Guidelines
- Keep posts under 280 characters
- Use a mix of informational, promotional, and engaging content
- Include relevant hashtags where appropriate
- Vary the tone: professional, casual, educational
- Space posts evenly across the 10-day window

## Tools Available
Use plugin tools to create and manage posts in the content calendar database.`,
        files: {},
      },
    },
  ],
  routines: [
    {
      routineKey: DAILY_POST_ROUTINE_KEY,
      title: "Daily Post Check",
      description: DAILY_POST_DESCRIPTION,
      status: "paused",
      priority: "medium",
      assigneeRef: { resourceKind: "agent", resourceKey: CONTENT_MANAGER_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: CONTENT_PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      triggers: [
        {
          kind: "schedule",
          label: "Daily at 9am UTC",
          enabled: false,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
          signingMode: null,
          replayWindowSec: null,
        },
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:daily-post-check",
        billingCode: "plugin-content-calendar:posting",
      },
    },
  ],
  jobs: [
    {
      jobKey: JOB_KEY_DAILY_POST_CHECK,
      displayName: "Daily Post Check",
      description: "Checks for approved posts scheduled for today and posts them to X.",
      schedule: "0 9 * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: SIDEBAR_SLOT_ID,
        displayName: "Content Calendar",
        exportName: SIDEBAR_EXPORT_NAME,
        order: 40,
      },
      {
        type: "page",
        id: PAGE_SLOT_ID,
        displayName: "Content Calendar",
        exportName: PAGE_EXPORT_NAME,
        routePath: "content-calendar",
      },
      {
        type: "dashboardWidget",
        id: DASHBOARD_WIDGET_SLOT_ID,
        displayName: "Content Calendar",
        exportName: DASHBOARD_WIDGET_EXPORT_NAME,
      },
    ],
  },
};

export default manifest;
