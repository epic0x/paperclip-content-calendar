import { useCallback, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

const X_CHAR_LIMIT = 280;

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

type PostEditorProps = {
  post: Post;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
};

const tokens = {
  border: "var(--border, oklch(0.269 0 0))",
  card: "var(--card, oklch(0.205 0 0))",
  bg: "var(--background, oklch(0.145 0 0))",
  fg: "var(--foreground, oklch(0.985 0 0))",
  muted: "var(--muted-foreground, oklch(0.708 0 0))",
  primary: "var(--primary, oklch(0.985 0 0))",
  primaryFg: "var(--primary-foreground, oklch(0.205 0 0))",
  destructive: "var(--destructive, oklch(0.637 0.237 25.331))",
};

const statusColors: Record<string, { bg: string; fg: string }> = {
  draft: { bg: "oklch(0.27 0.06 250)", fg: "oklch(0.85 0.1 250)" },
  approved: { bg: "oklch(0.27 0.06 145)", fg: "oklch(0.85 0.1 145)" },
  posted: { bg: "oklch(0.27 0.06 145)", fg: "oklch(0.72 0.15 145)" },
  failed: { bg: "oklch(0.27 0.08 25)", fg: "oklch(0.82 0.13 25)" },
  cancelled: { bg: "oklch(0.27 0 0)", fg: "oklch(0.6 0 0)" },
};

export function PostEditor({ post, companyId, onClose, onSaved }: PostEditorProps) {
  const [content, setContent] = useState(post.content);
  const [scheduledDate, setScheduledDate] = useState(post.scheduled_date);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editPost = usePluginAction("edit-post");
  const reschedule = usePluginAction("reschedule-post");
  const approvePost = usePluginAction("approve-post");
  const unapprovePost = usePluginAction("unapprove-post");

  const charCount = content.length;
  const overLimit = charCount > X_CHAR_LIMIT;
  const statusStyle = statusColors[post.status] ?? statusColors.draft!;

  const handleSave = useCallback(async () => {
    if (overLimit) return;
    setSaving(true);
    setError(null);
    try {
      const promises: Promise<unknown>[] = [];
      if (content !== post.content) {
        promises.push(editPost({ postId: post.id, companyId, content }));
      }
      if (scheduledDate !== post.scheduled_date) {
        promises.push(reschedule({ postId: post.id, companyId, newDate: scheduledDate }));
      }
      await Promise.all(promises);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [content, scheduledDate, post, companyId, overLimit, editPost, reschedule, onSaved]);

  const handleApprove = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await approvePost({ postId: post.id, companyId });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setSaving(false);
    }
  }, [post.id, companyId, approvePost, onSaved]);

  const handleUnapprove = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await unapprovePost({ postId: post.id, companyId });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unapprove");
    } finally {
      setSaving(false);
    }
  }, [post.id, companyId, unapprovePost, onSaved]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: tokens.card,
          border: `1px solid ${tokens.border}`,
          borderRadius: 12,
          padding: 24,
          width: "min(560px, 90vw)",
          maxHeight: "90vh",
          overflow: "auto",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          color: tokens.fg,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Edit Post</h2>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              background: statusStyle.bg,
              color: statusStyle.fg,
              textTransform: "capitalize",
            }}
          >
            {post.status}
          </span>
        </div>

        {/* Content editor */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: tokens.muted, marginBottom: 6 }}>
            Content (X / Twitter)
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={post.status === "posted" || post.status === "cancelled"}
            style={{
              width: "100%",
              minHeight: 120,
              padding: "10px 12px",
              background: tokens.bg,
              color: tokens.fg,
              border: `1px solid ${overLimit ? tokens.destructive : tokens.border}`,
              borderRadius: 8,
              fontSize: 14,
              lineHeight: 1.5,
              resize: "vertical",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
            <span style={{ fontSize: 12, color: overLimit ? tokens.destructive : tokens.muted }}>
              {charCount}/{X_CHAR_LIMIT}
            </span>
          </div>
        </div>

        {/* Date picker */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: tokens.muted, marginBottom: 6 }}>
            Scheduled Date
          </label>
          <input
            type="date"
            value={scheduledDate}
            onChange={(e) => setScheduledDate(e.target.value)}
            disabled={post.status === "posted" || post.status === "cancelled"}
            style={{
              padding: "8px 12px",
              background: tokens.bg,
              color: tokens.fg,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Platform */}
        <div style={{ marginBottom: 16, fontSize: 13, color: tokens.muted }}>
          <strong>Platform:</strong> {post.platform === "x" ? "X (Twitter)" : post.platform}
        </div>

        {/* Post URL (if posted) */}
        {post.post_url && (
          <div style={{ marginBottom: 16 }}>
            <a
              href={post.post_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "oklch(0.7 0.15 240)", fontSize: 13 }}
            >
              View post on X →
            </a>
          </div>
        )}

        {/* Error message (if failed) */}
        {post.error_message && (
          <div
            style={{
              padding: "10px 12px",
              background: "oklch(0.2 0.06 25)",
              border: `1px solid oklch(0.4 0.15 25)`,
              borderRadius: 8,
              color: "oklch(0.82 0.13 25)",
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            <strong>Error:</strong> {post.error_message}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ color: tokens.destructive, fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px",
              background: "transparent",
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              color: tokens.fg,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Close
          </button>

          {post.status === "draft" && (
            <>
              <button
                onClick={handleSave}
                disabled={saving || overLimit}
                style={{
                  padding: "8px 16px",
                  background: tokens.card,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 8,
                  color: tokens.fg,
                  fontSize: 14,
                  cursor: saving || overLimit ? "not-allowed" : "pointer",
                  opacity: saving || overLimit ? 0.6 : 1,
                }}
              >
                {saving ? "Saving…" : "Save Draft"}
              </button>
              <button
                onClick={handleApprove}
                disabled={saving || overLimit}
                style={{
                  padding: "8px 16px",
                  background: "oklch(0.27 0.06 145)",
                  border: `1px solid oklch(0.45 0.12 145)`,
                  borderRadius: 8,
                  color: "oklch(0.9 0.12 145)",
                  fontSize: 14,
                  cursor: saving || overLimit ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  opacity: saving || overLimit ? 0.6 : 1,
                }}
              >
                Approve
              </button>
            </>
          )}

          {post.status === "approved" && (
            <>
              <button
                onClick={handleUnapprove}
                disabled={saving}
                style={{
                  padding: "8px 16px",
                  background: "oklch(0.27 0.06 250)",
                  border: `1px solid oklch(0.45 0.12 250)`,
                  borderRadius: 8,
                  color: "oklch(0.85 0.1 250)",
                  fontSize: 14,
                  cursor: saving ? "not-allowed" : "pointer",
                  opacity: saving ? 0.6 : 1,
                }}
              >
                Unapprove
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
