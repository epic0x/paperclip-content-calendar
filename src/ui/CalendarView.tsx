import { useCallback, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { PostEditor } from "./PostEditor.js";

type Post = {
  id: string;
  content: string;
  scheduled_date: string;
  scheduled_time: string | null;
  status: string;
  platform: string;
  post_url: string | null;
  error_message: string | null;
};

type CalendarDay = {
  date: string;
  posts: Post[];
};

type CalendarData = {
  calendar: CalendarDay[];
  totalPosts: number;
};

type PostStats = {
  total: number;
  draft: number;
  approved: number;
  posted: number;
  failed: number;
  cancelled: number;
};

const tokens = {
  border: "var(--border, oklch(0.269 0 0))",
  card: "var(--card, oklch(0.205 0 0))",
  bg: "var(--background, oklch(0.145 0 0))",
  fg: "var(--foreground, oklch(0.985 0 0))",
  muted: "var(--muted-foreground, oklch(0.708 0 0))",
  primary: "var(--primary, oklch(0.985 0 0))",
  primaryFg: "var(--primary-foreground, oklch(0.205 0 0))",
  accent: "var(--accent, oklch(0.269 0 0))",
  calendarPurple: "oklch(0.35 0.08 280)",
  calendarPurpleFg: "oklch(0.85 0.12 280)",
};

const statusConfig: Record<string, { bg: string; fg: string; label: string }> = {
  draft: { bg: "oklch(0.27 0.06 250)", fg: "oklch(0.85 0.1 250)", label: "Draft" },
  approved: { bg: "oklch(0.27 0.06 145)", fg: "oklch(0.85 0.1 145)", label: "Approved" },
  posted: { bg: "oklch(0.22 0.06 145)", fg: "oklch(0.72 0.15 145)", label: "Posted" },
  failed: { bg: "oklch(0.27 0.08 25)", fg: "oklch(0.82 0.13 25)", label: "Failed" },
  cancelled: { bg: "oklch(0.2 0 0)", fg: "oklch(0.55 0 0)", label: "Cancelled" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? statusConfig.draft!;
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 600,
        background: cfg.bg,
        color: cfg.fg,
        textTransform: "capitalize",
        whiteSpace: "nowrap",
      }}
    >
      {cfg.label}
    </span>
  );
}

function PostCard({ post, onEdit, onApprove, onUnapprove }: {
  post: Post;
  onEdit: (post: Post) => void;
  onApprove: (postId: string) => Promise<void>;
  onUnapprove: (postId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const handleApprove = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await onApprove(post.id);
    } finally {
      setBusy(false);
    }
  }, [post.id, onApprove]);

  const handleUnapprove = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await onUnapprove(post.id);
    } finally {
      setBusy(false);
    }
  }, [post.id, onUnapprove]);

  return (
    <div
      onClick={() => onEdit(post)}
      style={{
        background: tokens.bg,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "pointer",
        transition: "border-color 0.15s",
        marginBottom: 8,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "oklch(0.5 0.1 280)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = tokens.border; }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <StatusBadge status={post.status} />
        {post.scheduled_time && (
          <span style={{ fontSize: 11, color: tokens.muted }}>{post.scheduled_time.slice(0, 5)}</span>
        )}
      </div>

      <p style={{
        margin: "0 0 8px 0",
        fontSize: 13,
        lineHeight: 1.5,
        color: tokens.fg,
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}>
        {post.content}
      </p>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {post.status === "draft" && (
          <button
            onClick={handleApprove}
            disabled={busy}
            style={{
              padding: "3px 10px",
              fontSize: 12,
              background: "oklch(0.27 0.06 145)",
              border: `1px solid oklch(0.45 0.12 145)`,
              borderRadius: 6,
              color: "oklch(0.9 0.12 145)",
              cursor: busy ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Approve
          </button>
        )}
        {post.status === "approved" && (
          <button
            onClick={handleUnapprove}
            disabled={busy}
            style={{
              padding: "3px 10px",
              fontSize: 12,
              background: "oklch(0.27 0.06 250)",
              border: `1px solid oklch(0.45 0.12 250)`,
              borderRadius: 6,
              color: "oklch(0.85 0.1 250)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Unapprove
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(post); }}
          style={{
            padding: "3px 10px",
            fontSize: 12,
            background: "transparent",
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            color: tokens.muted,
            cursor: "pointer",
          }}
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function DayColumn({ day, onEdit, onApprove, onUnapprove }: {
  day: CalendarDay;
  onEdit: (post: Post) => void;
  onApprove: (postId: string) => Promise<void>;
  onUnapprove: (postId: string) => Promise<void>;
}) {
  const date = new Date(day.date + "T00:00:00");
  const isToday = day.date === new Date().toISOString().slice(0, 10);
  const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
  const dayNum = date.getDate();
  const monthName = date.toLocaleDateString("en-US", { month: "short" });

  return (
    <div
      style={{
        minWidth: 180,
        maxWidth: 220,
        flex: "1 1 180px",
        background: isToday ? "oklch(0.18 0.04 280)" : tokens.card,
        border: `1px solid ${isToday ? "oklch(0.4 0.1 280)" : tokens.border}`,
        borderRadius: 10,
        padding: "12px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 0,
      }}
    >
      <div style={{ marginBottom: 12, textAlign: "center" }}>
        <div style={{ fontSize: 12, color: tokens.muted, textTransform: "uppercase", letterSpacing: 1 }}>{dayName}</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: isToday ? "oklch(0.85 0.15 280)" : tokens.fg, lineHeight: 1.2 }}>{dayNum}</div>
        <div style={{ fontSize: 11, color: tokens.muted }}>{monthName}</div>
        {isToday && (
          <div style={{ fontSize: 10, color: "oklch(0.7 0.12 280)", marginTop: 2, fontWeight: 600 }}>TODAY</div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 60 }}>
        {day.posts.length === 0 ? (
          <div style={{ textAlign: "center", color: tokens.muted, fontSize: 12, padding: "16px 0", opacity: 0.6 }}>
            No posts
          </div>
        ) : (
          day.posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onEdit={onEdit}
              onApprove={onApprove}
              onUnapprove={onUnapprove}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function CalendarView({ companyId }: { companyId: string }) {
  const [editingPost, setEditingPost] = useState<Post | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // `usePluginData(key, params)` takes no deps array — the third argument was
  // silently ignored by TypeScript's overload resolution and the refresh never
  // fired, so approving a post left the grid stale until a full page reload.
  // Folding refreshKey into params makes it part of the query identity, which
  // is what actually re-runs the fetch.
  const calendarData = usePluginData<CalendarData>("calendar", { companyId, days: 10, refreshKey });
  const statsData = usePluginData<PostStats>("stats", { companyId, refreshKey });
  const generateBatch = usePluginAction("generate-batch");
  const approvePost = usePluginAction("approve-post");
  const unapprovePost = usePluginAction("unapprove-post");

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleApprove = useCallback(async (postId: string) => {
    await approvePost({ postId, companyId });
    refresh();
  }, [approvePost, companyId, refresh]);

  const handleUnapprove = useCallback(async (postId: string) => {
    await unapprovePost({ postId, companyId });
    refresh();
  }, [unapprovePost, companyId, refresh]);

  const handleGenerateBatch = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      await generateBatch({ companyId, daysCount: 10 });
      refresh();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Failed to generate batch");
    } finally {
      setGenerating(false);
    }
  }, [generateBatch, companyId, refresh]);

  const calendar = calendarData.data?.calendar ?? [];
  const stats = statsData.data;

  return (
    <div style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", color: tokens.fg }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Content Calendar</h2>
          <p style={{ margin: "4px 0 0 0", fontSize: 14, color: tokens.muted }}>
            Schedule and manage your X (Twitter) posts
          </p>
        </div>

        <button
          onClick={handleGenerateBatch}
          disabled={generating}
          style={{
            padding: "10px 20px",
            background: "oklch(0.35 0.12 280)",
            border: `1px solid oklch(0.5 0.15 280)`,
            borderRadius: 8,
            color: "oklch(0.92 0.1 280)",
            fontSize: 14,
            fontWeight: 600,
            cursor: generating ? "not-allowed" : "pointer",
            opacity: generating ? 0.7 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {generating ? "Generating…" : "✨ Generate 10 Posts"}
        </button>
      </div>

      {generateError && (
        <div style={{
          padding: "10px 14px",
          background: "oklch(0.2 0.06 25)",
          border: `1px solid oklch(0.4 0.15 25)`,
          borderRadius: 8,
          color: "oklch(0.82 0.13 25)",
          fontSize: 13,
          marginBottom: 16,
        }}>
          {generateError}
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            { label: "Total", value: stats.total, color: tokens.muted },
            { label: "Draft", value: stats.draft, color: "oklch(0.7 0.1 250)" },
            { label: "Approved", value: stats.approved, color: "oklch(0.7 0.12 145)" },
            { label: "Posted", value: stats.posted, color: "oklch(0.65 0.16 145)" },
            { label: "Failed", value: stats.failed, color: "oklch(0.7 0.15 25)" },
          ].map((stat) => (
            <div
              key={stat.label}
              style={{
                background: tokens.card,
                border: `1px solid ${tokens.border}`,
                borderRadius: 8,
                padding: "10px 16px",
                minWidth: 80,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 700, color: stat.color }}>{stat.value}</div>
              <div style={{ fontSize: 12, color: tokens.muted }}>{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Calendar grid */}
      {calendarData.loading && (
        <div style={{ textAlign: "center", color: tokens.muted, padding: "40px 0" }}>Loading calendar…</div>
      )}

      {calendarData.error && (
        <div style={{ color: "oklch(0.82 0.13 25)", padding: "16px 0" }}>
          Failed to load calendar: {String(calendarData.error)}
        </div>
      )}

      {!calendarData.loading && calendar.length > 0 && (
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 16 }}>
          {calendar.map((day) => (
            <DayColumn
              key={day.date}
              day={day}
              onEdit={setEditingPost}
              onApprove={handleApprove}
              onUnapprove={handleUnapprove}
            />
          ))}
        </div>
      )}

      {/* Post editor modal */}
      {editingPost && (
        <PostEditor
          post={editingPost}
          companyId={companyId}
          onClose={() => setEditingPost(null)}
          onSaved={() => {
            setEditingPost(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
