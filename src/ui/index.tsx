import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginSidebarProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { CalendarView, Notice, type CalendarEntry } from "./CalendarView.js";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ContentCalendarPage({ context }: PluginPageProps) {
  return (
    <div
      style={{
        padding: "24px 28px",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        minHeight: "100%",
        background: "#09090b",
        color: "#fafafa",
      }}
    >
      <CalendarView companyId={context.companyId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar entry
// ---------------------------------------------------------------------------

export function ContentCalendarSidebar({ context }: PluginSidebarProps) {
  const href = context.companyPrefix
    ? `/${context.companyPrefix}/content-calendar`
    : "/content-calendar";
  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 6,
        color: "inherit",
        textDecoration: "none",
        fontSize: 14,
      }}
    >
      <CalendarIcon />
      <span>Content Calendar</span>
    </a>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Dashboard widget — the next few posts, and anything that needs a human
// ---------------------------------------------------------------------------

interface CalendarData {
  configured: boolean;
  error: string | null;
  days: Array<{ date: string; entries: CalendarEntry[] }>;
  unscheduled: CalendarEntry[];
  stats: {
    total: number;
    scheduled: number;
    unscheduled: number;
    approved: number;
    inReview: number;
    published: number;
    cancelled: number;
  } | null;
}

export function ContentCalendarWidget({ context }: PluginWidgetProps) {
  const today = new Date().toISOString().slice(0, 10);
  const in14 = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const { data, loading, error } = usePluginData<CalendarData>(
    "calendar",
    context.companyId
      ? { companyId: context.companyId, from: today, to: in14 }
      : undefined,
  );

  if (error) {
    return <Notice tone="error" title="Content Calendar" body={error.message} />;
  }
  if (loading && !data) {
    return <Notice title="Content Calendar" body="Loading…" />;
  }
  if (data && !data.configured) {
    return (
      <Notice
        tone="error"
        title="Content Calendar"
        body={data.error ?? "Plugin is not configured."}
      />
    );
  }

  const upcoming = (data?.days ?? []).flatMap((d) => d.entries).slice(0, 6);
  const stats = data?.stats;

  return (
    <div style={{ fontSize: 12, color: "#e4e4e7" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>Next 14 days</strong>
        {stats && (
          <span style={{ color: "#a1a1aa" }}>
            {stats.approved} approved · {stats.inReview} in review
          </span>
        )}
      </div>

      {upcoming.length === 0 ? (
        <div style={{ color: "#71717a" }}>Nothing scheduled in the next two weeks.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 5 }}>
          {upcoming.map((e) => (
            <li
              key={e.id}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                borderLeft: `3px solid ${e.approved ? "#4ade80" : "#fbbf24"}`,
                paddingLeft: 8,
              }}
            >
              <span
                style={{
                  color: "#a1a1aa",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {e.publishAt ? e.publishAt.slice(5, 16).replace("T", " ") : "—"}
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.title}
              </span>
            </li>
          ))}
        </ul>
      )}

      {stats && stats.unscheduled > 0 && (
        <div style={{ marginTop: 10, color: "#f87171" }}>
          {stats.unscheduled} post{stats.unscheduled === 1 ? "" : "s"} with no date
        </div>
      )}
    </div>
  );
}
