/**
 * UI entrypoints. Export names must match `ui.slots[].exportName` in the
 * manifest, because the host loads this bundle and reads those exports.
 */
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { CalendarView } from "./CalendarView.js";

type HostContext = { companyId?: string | null };

/** Full-page calendar, mounted at /:companyPrefix/content-calendar */
export function ContentCalendarPage({ context }: { context: HostContext }) {
  if (!context?.companyId) {
    return (
      <p style={{ padding: 24, opacity: 0.7, fontFamily: "system-ui, sans-serif" }}>
        Select a company to view its content calendar.
      </p>
    );
  }
  return <CalendarView companyId={context.companyId} />;
}

type CalendarData = {
  byDate: Record<string, Array<{
    ref: string;
    caption: string | null;
    title: string;
    status: string;
    publishAt: string | null;
  }>>;
  stats: { total: number; scheduled: number; approved: number; posted: number };
};

/**
 * Dashboard widget: the next few posts that are actually going out.
 *
 * Shows approved-and-scheduled only. A widget that counted drafts would imply
 * work is queued when nothing is.
 */
export function ContentCalendarDashboardWidget({ context }: { context: HostContext }) {
  const companyId = context?.companyId ?? null;
  const data = usePluginData<CalendarData>("calendar", { companyId });

  if (!companyId) return null;
  if (data.loading) return <p style={{ fontSize: 12, opacity: 0.6 }}>Loading…</p>;
  if (data.error) return <p style={{ fontSize: 12, color: "#dc2626" }}>Calendar unavailable</p>;

  const now = Date.now();
  const upcoming = Object.values(data.data?.byDate ?? {})
    .flat()
    .filter((p) => p.status === "approved" && p.publishAt && Date.parse(p.publishAt) >= now)
    .sort((a, b) => (a.publishAt ?? "").localeCompare(b.publishAt ?? ""))
    .slice(0, 5);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 12 }}>
      <div style={{ opacity: 0.65, marginBottom: 6 }}>
        {data.data?.stats.approved ?? 0} approved · {data.data?.stats.posted ?? 0} posted
      </div>
      {upcoming.length === 0 ? (
        <p style={{ opacity: 0.55, margin: 0 }}>Nothing approved and scheduled.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {upcoming.map((p) => (
            <li key={p.ref} style={{ marginBottom: 3 }}>
              <span style={{ opacity: 0.6 }}>{p.publishAt?.slice(5, 16).replace("T", " ")}</span>{" "}
              {(p.caption ?? p.title).slice(0, 44)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
