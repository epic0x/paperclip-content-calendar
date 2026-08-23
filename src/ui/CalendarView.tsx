import { useMemo, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  dubaiDayKey,
  dubaiLocalToIso,
  dubaiMonth,
  dubaiTime,
  dubaiYear,
  isoToDubaiLocalInput,
} from "../time.js";

// ---------------------------------------------------------------------------
// Types mirroring what the worker's data handlers return
// ---------------------------------------------------------------------------

export type CaseLifecycle = "draft" | "in_review" | "approved" | "cancelled";

export interface CalendarEntry {
  id: string;
  identifier: string;
  key: string | null;
  title: string;
  status: string;
  publishAt: string | null;
  channel: string | null;
  caption: string | null;
  mediaFile: string | null;
  publishUrl: string | null;
  approved: boolean;
}

interface CalendarDay {
  date: string;
  entries: CalendarEntry[];
}

interface CalendarData {
  configured: boolean;
  error: string | null;
  days: CalendarDay[];
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

// ---------------------------------------------------------------------------
// Calendar coordinates are synthetic UTC dates, but all real instants are
// displayed and edited in Asia/Dubai. publish_at remains a UTC instant.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1));
}

/** Monday-first grid covering the whole month. */
function monthGrid(year: number, month: number): string[] {
  const first = startOfMonth(year, month);
  const offset = (first.getUTCDay() + 6) % 7; // Mon = 0
  const gridStart = new Date(first.getTime() - offset * DAY_MS);
  return Array.from({ length: 42 }, (_, i) =>
    ymd(new Date(gridStart.getTime() + i * DAY_MS)),
  );
}

function timeOf(iso: string | null): string {
  if (!iso) return "";
  return dubaiTime(iso);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CHANNEL_COLORS: Record<string, string> = {
  x: "#1d9bf0",
  linkedin: "#0a66c2",
  instagram: "#e1306c",
  youtube: "#ff0000",
};

function channelColor(ch: string | null): string {
  if (!ch) return "#71717a";
  return CHANNEL_COLORS[ch.toLowerCase()] ?? "#71717a";
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  draft: { bg: "#3f3f46", fg: "#d4d4d8", label: "Draft" },
  in_progress: { bg: "#1e3a5f", fg: "#93c5fd", label: "In progress" },
  in_review: { bg: "#4a3410", fg: "#fbbf24", label: "In review" },
  approved: { bg: "#14432a", fg: "#4ade80", label: "Approved" },
  done: { bg: "#1f2937", fg: "#9ca3af", label: "Done" },
  cancelled: { bg: "#3f1d1d", fg: "#f87171", label: "Cancelled" },
};

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.draft;
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        borderRadius: 4,
        padding: "1px 6px",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.2,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div
      style={{
        border: "1px solid #27272a",
        borderRadius: 8,
        padding: "10px 14px",
        minWidth: 92,
        background: "#18181b",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 600, color: tone ?? "#fafafa", lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 2 }}>{label}</div>
    </div>
  );
}

/**
 * A post on the month grid.
 *
 * Deliberately NOT interactive beyond opening the post (JC, 2026-08-23: "Don't
 * put those controls outside as clickable items in the calendar — only keep it
 * inside."). A grid of small buttons is where a mis-click publishes something.
 * The chip shows state; the panel changes it.
 */
function EntryChip({
  entry,
  onSelect,
}: {
  entry: CalendarEntry;
  onSelect: (e: CalendarEntry) => void;
}) {
  const s = STATUS_STYLE[entry.status] ?? STATUS_STYLE.draft;
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      title={`${entry.identifier} — ${entry.title} (${s.label})`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        width: "100%",
        textAlign: "left",
        background: entry.publishUrl ? "#14432a" : "#27272a",
        border: "none",
        borderLeft: `3px solid ${channelColor(entry.channel)}`,
        borderRadius: 3,
        padding: "3px 5px",
        marginBottom: 2,
        cursor: "pointer",
        color: "#e4e4e7",
        fontSize: 11,
        overflow: "hidden",
      }}
    >
      {/* Status is a colour dot, not a control. */}
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: s.fg,
          flexShrink: 0,
        }}
      />
      <span style={{ color: "#a1a1aa", fontVariantNumeric: "tabular-nums" }}>
        {timeOf(entry.publishAt)}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {entry.title}
      </span>
      {entry.publishUrl && <span style={{ color: "#4ade80" }}>↗</span>}
    </button>
  );
}

function DetailPanel({
  entry,
  onClose,
  onReschedule,
  onSetStatus,
  onPostNow,
  busy,
  postResult,
}: {
  entry: CalendarEntry;
  onClose: () => void;
  onReschedule: (iso: string) => void;
  onSetStatus: (status: CaseLifecycle) => void;
  onPostNow: () => void;
  busy: string | null;
  postResult: { ok: boolean; text: string } | null;
}) {
  const [when, setWhen] = useState(
    entry.publishAt ? isoToDubaiLocalInput(entry.publishAt) : "",
  );
  const [confirmPost, setConfirmPost] = useState(false);

  const alreadyPublished = Boolean(entry.publishUrl);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 420,
        maxWidth: "100vw",
        background: "#09090b",
        borderLeft: "1px solid #27272a",
        padding: 20,
        overflowY: "auto",
        zIndex: 50,
        boxShadow: "-8px 0 24px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "#a1a1aa", fontFamily: "ui-monospace, monospace" }}>
            {entry.identifier}
          </div>
          <h3 style={{ margin: "4px 0 0", fontSize: 16, color: "#fafafa" }}>{entry.title}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid #3f3f46",
            color: "#a1a1aa",
            borderRadius: 6,
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        <StatusPill status={entry.status} />
        {entry.channel && (
          <span
            style={{
              background: channelColor(entry.channel),
              color: "#fff",
              borderRadius: 4,
              padding: "1px 6px",
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            {entry.channel}
          </span>
        )}
      </div>

      {entry.caption && (
        <pre
          style={{
            marginTop: 14,
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 8,
            padding: 12,
            color: "#d4d4d8",
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
          }}
        >
          {entry.caption}
        </pre>
      )}

      {alreadyPublished && (
        <p style={{ marginTop: 14, fontSize: 12 }}>
          <a href={entry.publishUrl as string} target="_blank" rel="noreferrer" style={{ color: "#4ade80" }}>
            Published → {entry.publishUrl}
          </a>
        </p>
      )}

      {/* ---- Status: the full lifecycle, changed from inside the post ---- */}
      <div style={{ marginTop: 20, borderTop: "1px solid #27272a", paddingTop: 16 }}>
        <label style={{ fontSize: 11, color: "#a1a1aa", display: "block", marginBottom: 8 }}>
          Status
        </label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["draft", "in_review", "approved", "cancelled"] as const).map((s) => {
            const style = STATUS_STYLE[s];
            const active = entry.status === s;
            return (
              <button
                key={s}
                type="button"
                disabled={busy !== null || active}
                onClick={() => onSetStatus(s)}
                style={{
                  background: active ? style.bg : "transparent",
                  border: `1px solid ${active ? style.fg : "#3f3f46"}`,
                  borderRadius: 6,
                  color: active ? style.fg : "#a1a1aa",
                  padding: "5px 12px",
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  cursor: active || busy ? "default" : "pointer",
                  opacity: busy && !active ? 0.5 : 1,
                }}
              >
                {active && "● "}
                {style.label}
              </button>
            );
          })}
        </div>
        {busy === "status" && (
          <p style={{ fontSize: 11, color: "#a1a1aa", marginTop: 8 }}>Saving…</p>
        )}
        <p style={{ fontSize: 11, color: "#71717a", marginTop: 8, lineHeight: 1.5 }}>
          This is the case status in Paperclip — the same field the case page
          writes, logged the same way.{" "}
          <strong style={{ color: "#4ade80" }}>Approved</strong> plus a publish
          date in the past is all it takes to go out.
        </p>
      </div>

      {/* ---- Post Now ---- */}
      {!alreadyPublished && (
        <div style={{ marginTop: 18, borderTop: "1px solid #27272a", paddingTop: 16 }}>
          <label style={{ fontSize: 11, color: "#a1a1aa", display: "block", marginBottom: 8 }}>
            Publish
          </label>

          {entry.status === "cancelled" || entry.status === "done" ? (
            <p style={{ fontSize: 12, color: "#71717a", margin: 0, lineHeight: 1.5 }}>
              A {entry.status} post cannot be published.
            </p>
          ) : !entry.approved ? (
            <p style={{ fontSize: 12, color: "#71717a", margin: 0, lineHeight: 1.5 }}>
              Set the status to Approved first. Posting is blocked until then.
            </p>
          ) : !confirmPost ? (
            <div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => setConfirmPost(true)}
                style={{
                  background: "#1d4ed8",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  padding: "7px 16px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                Post now
              </button>
              <p style={{ fontSize: 11, color: "#71717a", marginTop: 8, lineHeight: 1.5 }}>
                Only needed to skip the schedule. Otherwise this goes out on its
                own at {entry.publishAt ? timeOf(entry.publishAt) : "its publish date"}.
              </p>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: 12, color: "#fbbf24", margin: "0 0 10px", lineHeight: 1.5 }}>
                This publishes to <strong>{entry.channel}</strong> immediately and
                publicly. It cannot be undone from here.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirmPost(false);
                    onPostNow();
                  }}
                  style={{
                    background: busy ? "#3f3f46" : "#b91c1c",
                    border: "none",
                    borderRadius: 6,
                    color: "#fff",
                    padding: "7px 16px",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: busy ? "default" : "pointer",
                  }}
                >
                  {busy === "post" ? "Posting…" : `Yes, post to ${entry.channel}`}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setConfirmPost(false)}
                  style={{
                    background: "transparent",
                    border: "1px solid #3f3f46",
                    borderRadius: 6,
                    color: "#a1a1aa",
                    padding: "7px 14px",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {postResult && (
            <p
              style={{
                marginTop: 10,
                fontSize: 12,
                lineHeight: 1.5,
                color: postResult.ok ? "#4ade80" : "#f87171",
              }}
            >
              {postResult.text}
            </p>
          )}
        </div>
      )}

      {/* ---- Schedule ---- */}
      <div style={{ marginTop: 18, borderTop: "1px solid #27272a", paddingTop: 16 }}>
        <label style={{ fontSize: 11, color: "#a1a1aa", display: "block", marginBottom: 6 }}>
          Publish at (Dubai, UTC+4)
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            style={{
              flex: 1,
              background: "#18181b",
              border: "1px solid #3f3f46",
              borderRadius: 6,
              color: "#fafafa",
              padding: "6px 8px",
              fontSize: 12,
            }}
          />
          <button
            type="button"
            disabled={busy !== null || !when}
            onClick={() => onReschedule(dubaiLocalToIso(when))}
            style={{
              background: busy ? "#3f3f46" : "#2563eb",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              padding: "6px 14px",
              fontSize: 12,
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy === "reschedule" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main calendar
// ---------------------------------------------------------------------------

export function CalendarView({ companyId }: { companyId: string | null }) {
  const today = new Date();
  const [year, setYear] = useState(dubaiYear(today));
  const [month, setMonth] = useState(dubaiMonth(today));
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [postResult, setPostResult] = useState<{ ok: boolean; text: string } | null>(null);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const from = grid[0];
  const to = grid[grid.length - 1];

  const { data, loading, error, refresh } = usePluginData<CalendarData>(
    "calendar",
    companyId ? { companyId, from, to } : undefined,
  );
  const reschedule = usePluginAction("reschedule");
  const setStatus = usePluginAction("set-status");
  const postNow = usePluginAction("post-now");

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEntry[]>();
    for (const d of data?.days ?? []) {
      const filtered =
        channelFilter === "all"
          ? d.entries
          : d.entries.filter(
              (e) => (e.channel ?? "").toLowerCase() === channelFilter,
            );
      if (filtered.length) m.set(d.date, filtered);
    }
    return m;
  }, [data, channelFilter]);

  const channels = useMemo(() => {
    const s = new Set<string>();
    for (const d of data?.days ?? []) {
      for (const e of d.entries) if (e.channel) s.add(e.channel.toLowerCase());
    }
    return [...s].sort();
  }, [data]);

  if (!companyId) {
    return <Notice title="No company selected" body="Open the calendar inside a company." />;
  }
  if (error) {
    return <Notice title="Could not load the calendar" body={error.message} tone="error" />;
  }
  if (loading && !data) {
    return <Notice title="Loading…" body="Reading cases from Paperclip." />;
  }
  if (data && !data.configured) {
    return (
      <Notice
        tone="error"
        title="Plugin is not configured"
        body={
          data.error ??
          "A board API key is required so the plugin can read cases. Create one with `paperclipai token board create` and set it in the plugin settings."
        }
      />
    );
  }

  const stats = data?.stats;
  const monthLabel = `${MONTHS[month]} ${year}`;

  const step = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth());
  };

  const onReschedule = async (iso: string) => {
    if (!selected) return;
    setBusy("reschedule");
    try {
      await reschedule({
        companyId,
        caseId: selected.id,
        caseIdentifier: selected.identifier,
        publishAt: iso,
        previousPublishAt: selected.publishAt,
      });
      setSelected(null);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const onSetStatus = async (status: CaseLifecycle) => {
    if (!selected) return;
    setBusy("status");
    setPostResult(null);
    try {
      await setStatus({
        companyId,
        caseId: selected.id,
        caseIdentifier: selected.identifier,
        status,
      });
      // Keep the panel open and reflect the change immediately, so the Post Now
      // button unlocks in place rather than after a round trip.
      setSelected({ ...selected, status, approved: status === "approved" });
      refresh();
    } catch (err) {
      setPostResult({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const onPostNow = async () => {
    if (!selected) return;
    setBusy("post");
    setPostResult(null);
    try {
      const res = (await postNow({
        companyId,
        caseId: selected.id,
        caseIdentifier: selected.identifier,
      })) as { ok?: boolean; outcome?: string; reason?: string; url?: string } | null;

      if (res?.ok && res.url) {
        setPostResult({ ok: true, text: `Posted → ${res.url}` });
        setSelected({ ...selected, publishUrl: res.url });
      } else {
        setPostResult({
          ok: false,
          text: `Not posted (${res?.outcome ?? "unknown"}): ${res?.reason ?? "no reason returned"}`,
        });
      }
      refresh();
    } catch (err) {
      setPostResult({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ color: "#fafafa" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>Content Calendar</h2>
        <div style={{ display: "flex", gap: 4, marginLeft: "auto", alignItems: "center" }}>
          <NavButton onClick={() => step(-1)}>←</NavButton>
          <span style={{ minWidth: 150, textAlign: "center", fontSize: 14 }}>{monthLabel}</span>
          <NavButton onClick={() => step(1)}>→</NavButton>
          <NavButton
            onClick={() => {
              const n = new Date();
              setYear(dubaiYear(n));
              setMonth(dubaiMonth(n));
            }}
          >
            Today
          </NavButton>
        </div>
      </header>

      {stats && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <Stat label="Total posts" value={stats.total} />
          <Stat label="Scheduled" value={stats.scheduled} />
          <Stat label="In review" value={stats.inReview} tone="#fbbf24" />
          <Stat label="Approved" value={stats.approved} tone="#4ade80" />
          <Stat label="Published" value={stats.published} tone="#4ade80" />
          <Stat label="No date" value={stats.unscheduled} tone="#f87171" />
        </div>
      )}

      {channels.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
          <FilterChip active={channelFilter === "all"} onClick={() => setChannelFilter("all")}>
            All
          </FilterChip>
          {channels.map((c) => (
            <FilterChip key={c} active={channelFilter === c} onClick={() => setChannelFilter(c)}>
              {c}
            </FilterChip>
          ))}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 1,
          marginTop: 16,
          background: "#27272a",
          border: "1px solid #27272a",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div
            key={d}
            style={{
              background: "#18181b",
              padding: "6px 8px",
              fontSize: 11,
              color: "#a1a1aa",
              fontWeight: 600,
            }}
          >
            {d}
          </div>
        ))}

        {grid.map((date) => {
          const inMonth = Number(date.slice(5, 7)) === month + 1;
          const isToday = date === dubaiDayKey(new Date());
          const entries = byDay.get(date) ?? [];
          return (
            <div
              key={date}
              style={{
                background: inMonth ? "#09090b" : "#111113",
                minHeight: 96,
                padding: 5,
                opacity: inMonth ? 1 : 0.45,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: isToday ? "#fafafa" : "#71717a",
                  fontWeight: isToday ? 700 : 400,
                  background: isToday ? "#2563eb" : "transparent",
                  borderRadius: 4,
                  display: "inline-block",
                  padding: isToday ? "0 5px" : 0,
                  marginBottom: 3,
                }}
              >
                {Number(date.slice(8, 10))}
              </div>
              {entries.map((e) => (
                <EntryChip key={e.id} entry={e} onSelect={setSelected} />
              ))}
            </div>
          );
        })}
      </div>

      {data && data.unscheduled.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: 13, color: "#f87171", margin: "0 0 8px" }}>
            {data.unscheduled.length} post{data.unscheduled.length === 1 ? "" : "s"} with no
            publish date
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.unscheduled.slice(0, 40).map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelected(e)}
                style={{
                  background: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: 6,
                  padding: "4px 8px",
                  color: "#d4d4d8",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {e.identifier} · {e.title.slice(0, 42)}
              </button>
            ))}
          </div>
        </section>
      )}

      {selected && (
        <DetailPanel
          entry={selected}
          busy={busy}
          postResult={postResult}
          onClose={() => {
            setSelected(null);
            setPostResult(null);
          }}
          onReschedule={onReschedule}
          onSetStatus={onSetStatus}
          onPostNow={onPostNow}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NavButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "#18181b",
        border: "1px solid #3f3f46",
        color: "#e4e4e7",
        borderRadius: 6,
        padding: "3px 10px",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function FilterChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? "#2563eb" : "#18181b",
        border: `1px solid ${active ? "#2563eb" : "#3f3f46"}`,
        color: active ? "#fff" : "#a1a1aa",
        borderRadius: 999,
        padding: "3px 12px",
        fontSize: 11,
        cursor: "pointer",
        textTransform: "capitalize",
      }}
    >
      {children}
    </button>
  );
}

export function Notice({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone?: "error";
}) {
  return (
    <div
      style={{
        border: `1px solid ${tone === "error" ? "#7f1d1d" : "#27272a"}`,
        background: tone === "error" ? "#1f1113" : "#18181b",
        borderRadius: 8,
        padding: 18,
        color: "#e4e4e7",
        maxWidth: 640,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: "#a1a1aa", lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}
