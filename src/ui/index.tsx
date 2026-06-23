import type {
  PluginPageProps,
  PluginSidebarProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { CalendarView } from "./CalendarView.js";

// ---------------------------------------------------------------------------
// Page — main content calendar page
// ---------------------------------------------------------------------------

export function ContentCalendarPage({ context }: PluginPageProps) {
  return (
    <div
      style={{
        padding: "24px 28px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        minHeight: "100%",
        background: "var(--background, oklch(0.145 0 0))",
        color: "var(--foreground, oklch(0.985 0 0))",
      }}
    >
      <CalendarView companyId={context.companyId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar link
// ---------------------------------------------------------------------------

export function ContentCalendarSidebar({ context: _context }: PluginSidebarProps) {
  return (
    <a
      href="/content-calendar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 6,
        color: "var(--foreground, oklch(0.985 0 0))",
        textDecoration: "none",
        fontSize: 14,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "var(--accent, oklch(0.269 0 0))"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}
    >
      <CalendarIcon />
      <span>Content Calendar</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

export function ContentCalendarDashboardWidget({ context }: PluginWidgetProps) {
  return (
    <div
      style={{
        padding: "16px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "var(--foreground, oklch(0.985 0 0))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <CalendarIcon />
        <strong style={{ fontSize: 15 }}>Content Calendar</strong>
      </div>
      <div style={{ fontSize: 13, color: "var(--muted-foreground, oklch(0.708 0 0))", marginBottom: 12 }}>
        Schedule and publish posts to X (Twitter).
      </div>
      <a
        href="/content-calendar"
        style={{
          display: "inline-block",
          padding: "6px 14px",
          background: "oklch(0.35 0.12 280)",
          border: "1px solid oklch(0.5 0.15 280)",
          borderRadius: 6,
          color: "oklch(0.92 0.1 280)",
          textDecoration: "none",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        Open Calendar
      </a>
      {context.companyId && (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted-foreground, oklch(0.708 0 0))" }}>
          Company: {context.companyId.slice(0, 8)}…
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG icon
// ---------------------------------------------------------------------------

function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}
