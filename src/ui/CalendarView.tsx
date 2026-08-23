/**
 * Calendar view over social_post cases.
 *
 * Deliberately read-mostly. Content, media and approval all live on the case,
 * so editing belongs on the case detail page where the versioned document and
 * the native lifecycle already are. Rebuilding an editor here would be a second
 * way to change the same thing.
 *
 * Status colours come from the NATIVE case lifecycle. The calendar has no
 * status vocabulary of its own.
 */
import { useMemo, useState } from "react";
import { usePluginData, usePluginAction } from "@paperclipai/plugin-sdk/ui";

type PublishInfo = {
  outcome: string;
  url: string | null;
  at: string;
  error: string | null;
};

type PostEntry = {
  ref: string;
  title: string;
  caption: string | null;
  channel: string;
  status: string;
  angle: string | null;
  publishAt: string | null;
  hasMedia: boolean;
  charCount: number;
  published: PublishInfo | null;
};

type CalendarData = {
  byDate: Record<string, PostEntry[]>;
  stats: { total: number; scheduled: number; approved: number; posted: number };
  generatedAt: string;
};

/** Native Paperclip lifecycle → colour. One source of truth for status. */
const STATUS_COLOUR: Record<string, string> = {
  draft: "#6b7280",
  in_progress: "#d97706",
  in_review: "#2563eb",
  approved: "#15803d",
  done: "#4b5563",
  cancelled: "#9ca3af",
};

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fourteen days from today — the working window, not an infinite scroll. */
function windowDays(days = 14): string[] {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, i) => isoDate(new Date(start.getTime() + i * DAY_MS)));
}

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short", timeZone: "UTC",
  });
}

function dayNum(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", timeZone: "UTC",
  });
}

function timeOf(publishAt: string | null): string {
  if (!publishAt) return "";
  const t = publishAt.split("T")[1];
  return t ? `${t.slice(0, 5)} UTC` : "";
}

export function CalendarView({ companyId }: { companyId: string }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // refreshKey belongs in params, not a deps array: usePluginData takes
  // (key, params), and params are what identify the query.
  const data = usePluginData<CalendarData>("calendar", { companyId, refreshKey });
  const publishNow = usePluginAction("publish-now");

  const days = useMemo(() => windowDays(14), []);
  const cal = data.data;

  const unscheduled = cal?.byDate?.unscheduled ?? [];

  async function onPublishNow(ref: string) {
    if (!confirm(`Publish ${ref} now? This posts publicly and cannot be undone here.`)) return;
    setBusy(ref);
    setError(null);
    try {
      await publishNow({ companyId, caseRef: ref });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (data.loading) return <p style={{ padding: 24, opacity: 0.7 }}>Loading calendar…</p>;
  if (data.error) {
    return (
      <p style={{ padding: 24, color: "#dc2626" }}>
        Could not load the calendar: {String(data.error)}
      </p>
    );
  }

  return (
    <div style={{ padding: "20px 24px", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 20, marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Content Calendar</h1>
        {cal && (
          <span style={{ fontSize: 13, opacity: 0.65 }}>
            {cal.stats.total} cases · {cal.stats.scheduled} scheduled ·{" "}
            {cal.stats.approved} approved · {cal.stats.posted} posted
          </span>
        )}
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          style={{
            marginLeft: "auto", fontSize: 12, padding: "5px 11px",
            borderRadius: 6, border: "1px solid #d1d5db", cursor: "pointer",
            background: "transparent", color: "inherit",
          }}
        >
          Refresh
        </button>
      </header>

      {error && (
        <p style={{ color: "#dc2626", fontSize: 13, marginBottom: 12 }}>{error}</p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        {days.map((iso) => {
          const posts = cal?.byDate?.[iso] ?? [];
          const isToday = iso === isoDate(new Date());
          return (
            <div
              key={iso}
              style={{
                minHeight: 132,
                border: `1px solid ${isToday ? "#15803d" : "#e5e7eb"}`,
                borderRadius: 8,
                padding: 8,
                background: isToday ? "rgba(21,128,61,0.04)" : "transparent",
              }}
            >
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>
                {weekday(iso)} {dayNum(iso)}
              </div>

              {posts.length === 0 && (
                <div style={{ fontSize: 11, opacity: 0.28 }}>—</div>
              )}

              {posts.map((p) => (
                <div
                  key={p.ref}
                  style={{
                    borderLeft: `3px solid ${STATUS_COLOUR[p.status] ?? "#6b7280"}`,
                    paddingLeft: 7,
                    marginBottom: 8,
                    fontSize: 12,
                    lineHeight: 1.35,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <strong style={{ fontSize: 11 }}>{p.ref}</strong>
                    <span style={{ fontSize: 10, opacity: 0.6 }}>{timeOf(p.publishAt)}</span>
                    {p.hasMedia && <span title="has image" style={{ fontSize: 10 }}>🖼</span>}
                  </div>

                  <div style={{ opacity: 0.85, marginTop: 2 }}>
                    {(p.caption ?? p.title).slice(0, 72)}
                    {(p.caption ?? p.title).length > 72 ? "…" : ""}
                  </div>

                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3 }}>
                    {p.status.replace("_", " ")} · {p.charCount} ch
                  </div>

                  {p.published?.outcome === "posted" && (
                    <a
                      href={p.published.url ?? "#"}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 10, color: "#15803d" }}
                    >
                      posted ↗
                    </a>
                  )}
                  {p.published?.outcome === "failed" && (
                    <div style={{ fontSize: 10, color: "#dc2626" }} title={p.published.error ?? ""}>
                      failed
                    </div>
                  )}

                  {p.status === "approved" && !p.published && (
                    <button
                      disabled={busy === p.ref}
                      onClick={() => onPublishNow(p.ref)}
                      style={{
                        marginTop: 4, fontSize: 10, padding: "2px 7px",
                        borderRadius: 4, border: "1px solid #15803d",
                        color: "#15803d", background: "transparent",
                        cursor: busy === p.ref ? "wait" : "pointer",
                      }}
                    >
                      {busy === p.ref ? "posting…" : "post now"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {unscheduled.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h2 style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>
            No publish date ({unscheduled.length})
          </h2>
          <ul style={{ fontSize: 12, opacity: 0.8, paddingLeft: 18, margin: 0 }}>
            {unscheduled.slice(0, 12).map((p) => (
              <li key={p.ref} style={{ marginBottom: 3 }}>
                <strong>{p.ref}</strong> — {p.title.slice(0, 70)}{" "}
                <span style={{ opacity: 0.55 }}>({p.status.replace("_", " ")})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p style={{ fontSize: 11, opacity: 0.45, marginTop: 20 }}>
        Content, media and approval live on the case. Approve a case to make it
        publishable; the calendar only shows and sends.
      </p>
    </div>
  );
}
