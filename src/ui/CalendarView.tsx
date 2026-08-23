import { useMemo, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Types mirroring what the worker's data handlers return
// ---------------------------------------------------------------------------

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
// Date helpers — the grid is UTC, deliberately. publish_at is stored as an
// instant, and rendering it in browser-local time would silently shift a post
// into the previous or next day for anyone outside UTC.
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
  return new Date(iso).toISOString().slice(11, 16) + "Z";
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

function EntryChip({
  entry,
  onSelect,
}: {
  entry: CalendarEntry;
  onSelect: (e: CalendarEntry) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      title={`${entry.identifier} — ${entry.title}`}
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
      {entry.approved && <span style={{ color: "#4ade80" }}>✓</span>}
      {entry.publishUrl && <span style={{ color: "#4ade80" }}>↗</span>}
    </button>
  );
}

function DetailPanel({
  entry,
  onClose,
  onReschedule,
  busy,
}: {
  entry: CalendarEntry;
  onClose: () => void;
  onReschedule: (iso: string) => void;
  busy: boolean;
}) {
  const [when, setWhen] = useState(
    entry.publishAt ? entry.publishAt.slice(0, 16) : "",
  );

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

      {entry.publishUrl ? (
        <p style={{ marginTop: 14, fontSize: 12 }}>
          <a href={entry.publishUrl} target="_blank" rel="noreferrer" style={{ color: "#4ade80" }}>
            Published → {entry.publishUrl}
          </a>
        </p>
      ) : null}

      <div style={{ marginTop: 20, borderTop: "1px solid #27272a", paddingTop: 16 }}>
        <label style={{ fontSize: 11, color: "#a1a1aa", display: "block", marginBottom: 6 }}>
          Publish at (UTC)
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
            disabled={busy || !when}
            onClick={() => onReschedule(`${when}:00Z`)}
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
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#71717a", marginTop: 8, lineHeight: 1.5 }}>
          Approval is the case status, not a field here. Move the case to{" "}
          <strong style={{ color: "#4ade80" }}>Approved</strong> in Paperclip and the
          publish job will pick it up when it is due.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main calendar
// ---------------------------------------------------------------------------

export function CalendarView({ companyId }: { companyId: string | null }) {
  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());
  const [selected, setSelected] = useState<CalendarEntry | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [busy, setBusy] = useState(false);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const from = grid[0];
  const to = grid[grid.length - 1];

  const { data, loading, error, refresh } = usePluginData<CalendarData>(
    "calendar",
    companyId ? { companyId, from, to } : undefined,
  );
  const reschedule = usePluginAction("reschedule");

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
    setBusy(true);
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
      setBusy(false);
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
              setYear(n.getUTCFullYear());
              setMonth(n.getUTCMonth());
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
          const isToday = date === ymd(new Date());
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
          onClose={() => setSelected(null)}
          onReschedule={onReschedule}
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
