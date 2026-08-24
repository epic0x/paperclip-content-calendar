import { useEffect, useMemo, useRef, useState } from "react";
import {
  Spinner,
  usePluginAction,
  usePluginData,
} from "@paperclipai/plugin-sdk/ui";
import { validateImageUpload } from "../attachments.js";
import { uploadCaseImage } from "./upload.js";
import {
  actionFailure,
  actionSuccess,
  chipThumbnail,
  publishMessage,
  reconcileSelection,
  statusMessage,
  type ActionFeedback,
} from "./panel.js";
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

/** Mirrors PANEL_STATUSES in src/cases.ts, which the worker validates against. */
const PANEL_STATUSES: CaseLifecycle[] = [
  "draft",
  "in_review",
  "approved",
  "cancelled",
];

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
  altText: string | null;
  approved: boolean;
}

/** One native attachment, as the worker's case-detail handler projects it. */
interface AttachmentSummary {
  id: string;
  assetId: string;
  contentPath: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdAt: string | null;
}

interface CaseDetail extends CalendarEntry {
  attachments: AttachmentSummary[];
  /** Only ever the attachment `media_file` points at. Never a guess. */
  activeAttachment: AttachmentSummary | null;
  /** Attached to the case, but not what this post publishes. */
  unreferencedAttachments: AttachmentSummary[];
  legacyMediaFile: boolean;
}

/** What `usePluginData("case-detail")` resolves to. */
interface CaseDetailData {
  configured: boolean;
  error: string | null;
  detail: CaseDetail | null;
  maxUploadBytes: number;
  allowedImageTypes: string[];
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
 *
 * The thumbnail is part of that state, and it is free: `media_file` already
 * arrives with every calendar entry, so the card renders the asset's bytes
 * directly and never reads case detail — see `chipThumbnail`. It stays inside
 * the one button, so the whole card remains a single safe target.
 */
function EntryChip({
  entry,
  onSelect,
}: {
  entry: CalendarEntry;
  onSelect: (e: CalendarEntry) => void;
}) {
  const s = STATUS_STYLE[entry.status] ?? STATUS_STYLE.draft;
  const thumb = chipThumbnail(entry);
  // Keyed on the src, so re-pointing media_file at a working asset gets another
  // attempt rather than inheriting the previous image's failure.
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
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
      {/* A card with no loadable image shows none — never a broken-image icon. */}
      {thumb && brokenThumb !== thumb.src && (
        <img
          src={thumb.src}
          alt={thumb.alt}
          loading="lazy"
          decoding="async"
          onError={() => setBrokenThumb(thumb.src)}
          style={{
            width: 18,
            height: 18,
            borderRadius: 2,
            objectFit: "cover",
            flexShrink: 0,
            background: "#18181b",
          }}
        />
      )}
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

// ---------------------------------------------------------------------------
// The editor panel
//
// Everything an operator needs to finish a post lives here, so the Cases page
// is never a required stop: text, alt text, native status, the attached image,
// the schedule, and Post Now.
//
// Case detail (and therefore attachment metadata) is fetched HERE rather than
// in the month grid. `attachments` only exists on GET /api/cases/:id, so
// projecting it onto every chip would cost one API round trip per card on
// every render. This component is mounted only while a card is selected, so
// the read happens once per selection.
// ---------------------------------------------------------------------------

type SaveState = { ok: boolean; text: string } | null;

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const FIELD_STYLE = {
  width: "100%",
  boxSizing: "border-box" as const,
  background: "#18181b",
  border: "1px solid #3f3f46",
  borderRadius: 6,
  color: "#fafafa",
  padding: "7px 9px",
  fontSize: 12,
  fontFamily: "inherit",
};

const SECTION_STYLE = {
  marginTop: 18,
  borderTop: "1px solid #27272a",
  paddingTop: 16,
};

const LABEL_STYLE = {
  fontSize: 11,
  color: "#a1a1aa",
  display: "block" as const,
  marginBottom: 6,
};

function Result({ state }: { state: SaveState }) {
  if (!state) return null;
  return (
    <p
      role="status"
      style={{
        margin: "8px 0 0",
        fontSize: 11,
        lineHeight: 1.5,
        color: state.ok ? "#4ade80" : "#f87171",
      }}
    >
      {state.text}
    </p>
  );
}

/**
 * The image the case is currently carrying.
 *
 * The preview reads the NATIVE asset content endpoint (`/api/assets/:id/content`),
 * which is same-origin and session-authenticated, so no signed URL or copy of
 * the bytes is involved. Empty, legacy and broken states are all spelled out
 * rather than rendering a silently broken image.
 *
 * ONLY `detail.activeAttachment` is ever shown as the post's image, and the
 * worker only fills that in when `media_file` names that exact asset. Anything
 * else the case happens to carry is listed underneath as history: publishing
 * reads `media_file`, so previewing the newest upload as "the image" would
 * promise an image the post is not going to send.
 */
function MediaSection({
  companyId,
  detail,
  data,
  altText,
  onUploaded,
  disabled,
}: {
  companyId: string;
  detail: CaseDetail | null;
  data: CaseDetailData | null;
  altText: string;
  /** Tells the panel and the month grid to re-read the case. */
  onUploaded: () => void;
  disabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [state, setState] = useState<SaveState>(null);
  const [brokenAsset, setBrokenAsset] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const setMedia = usePluginAction("set-media");

  const attachment = detail?.activeAttachment ?? null;
  const maxBytes = data?.maxUploadBytes ?? 10 * 1024 * 1024;
  const accept = (data?.allowedImageTypes ?? ["image/png", "image/jpeg"]).join(",");

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !detail) return;

    const check = validateImageUpload(
      { name: file.name, type: file.type, size: file.size },
      { maxBytes },
    );
    if (!check.ok) {
      setState({ ok: false, text: check.error });
      return;
    }

    setUploading(true);
    setState({ ok: true, text: `Uploading ${file.name} (${fileSize(file.size)})…` });
    try {
      // 1. Bytes go to Paperclip's own case attachment endpoint. Until this
      //    succeeds the case still points at the previous image.
      const uploaded = await uploadCaseImage({
        caseId: detail.id,
        file,
        maxBytes,
      });
      // 2. Only then does the worker repoint media_file, with a merged patch.
      await setMedia({
        companyId,
        caseIdentifier: detail.identifier,
        assetId: uploaded.assetId,
        altText,
      });
      setBrokenAsset(null);
      setState({
        ok: true,
        text: `Attached ${uploaded.originalFilename ?? file.name} (${fileSize(uploaded.byteSize)}).`,
      });
      onUploaded();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Observability: the inline message is for the operator, the console line
      // is for whoever is reading the browser log afterwards.
      console.error("[content-calendar] image upload failed", err);
      setState({
        ok: false,
        text: `Not attached: ${message} The previous image is unchanged.`,
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={SECTION_STYLE}>
      <label style={LABEL_STYLE}>Image</label>

      {attachment ? (
        <div>
          <div
            style={{
              maxWidth: 340,
              maxHeight: 200,
              border: "1px solid #27272a",
              borderRadius: 8,
              background: "#18181b",
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {brokenAsset === attachment.assetId ? (
              <span style={{ fontSize: 11, color: "#f87171", padding: 16 }}>
                The image is attached but its preview could not be loaded from{" "}
                {attachment.contentPath}.
              </span>
            ) : (
              <img
                src={attachment.contentPath}
                alt={
                  detail?.altText ??
                  attachment.originalFilename ??
                  "Attached image with no alt text"
                }
                onError={() => setBrokenAsset(attachment.assetId)}
                style={{
                  maxWidth: "100%",
                  maxHeight: 200,
                  objectFit: "contain",
                  display: "block",
                }}
              />
            )}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 11, color: "#71717a" }}>
            {attachment.originalFilename ?? "attachment"} · {attachment.contentType} ·{" "}
            {fileSize(attachment.byteSize)}
          </p>
          {!detail?.altText && (
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#fbbf24" }}>
              No alt text. X requires alt on every image — add it above and save.
            </p>
          )}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "#71717a", lineHeight: 1.5 }}>
          {detail && detail.attachments.length > 0
            ? "This post has no image set. The files below are attached to the case but none of them is what it publishes."
            : "No image attached to this post."}
        </p>
      )}

      {detail &&
        detail.mediaFile &&
        !detail.legacyMediaFile &&
        !detail.activeAttachment && (
          <p style={{ margin: "8px 0 0", fontSize: 11, color: "#f87171", lineHeight: 1.5 }}>
            <code>media_file</code> points at {detail.mediaFile}, which is not one of
            this case's attachments. Nothing is previewed because nothing here is
            that asset. Uploading an image repoints it.
          </p>
        )}

      {detail && detail.unreferencedAttachments.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: 0, fontSize: 11, color: "#a1a1aa" }}>
            Also attached to this case ({detail.unreferencedAttachments.length}) —
            kept, but not part of this post:
          </p>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {detail.unreferencedAttachments.map((a) => (
              <li key={a.id} style={{ fontSize: 11, color: "#71717a", lineHeight: 1.6 }}>
                {a.originalFilename ?? a.assetId} · {a.contentType} ·{" "}
                {fileSize(a.byteSize)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail?.legacyMediaFile && (
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "#fbbf24", lineHeight: 1.5 }}>
          media_file still points at the host file <code>{detail.mediaFile}</code>,
          which is what publishing will use. Uploading here moves this post onto a
          native Paperclip asset.
        </p>
      )}

      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          disabled={disabled || uploading || !detail}
          onChange={onPick}
          aria-label={attachment ? "Replace image" : "Attach image"}
          style={{ fontSize: 11, color: "#a1a1aa", maxWidth: 260 }}
        />
        {uploading && <Spinner size="sm" label="Uploading" />}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 11, color: "#71717a", lineHeight: 1.5 }}>
        {(data?.allowedImageTypes ?? []).join(", ")} up to {fileSize(maxBytes)}. The
        current image stays in place until the new one is attached.
      </p>

      <Result state={state} />
    </div>
  );
}

function DetailPanel({
  entry,
  companyId,
  onClose,
  onReschedule,
  onSetStatus,
  onPostNow,
  onCaseChanged,
  busy,
  feedback,
}: {
  entry: CalendarEntry;
  companyId: string;
  onClose: () => void;
  onReschedule: (iso: string) => void;
  onSetStatus: (status: CaseLifecycle) => void;
  onPostNow: () => void;
  onCaseChanged: () => void;
  busy: string | null;
  /**
   * The outcome of the last panel action, tagged with which action it came
   * from. Tagged rather than shared, because the Post Now block that used to
   * hold every message is not rendered at all on a published post.
   */
  feedback: ActionFeedback | null;
}) {
  const [when, setWhen] = useState(
    entry.publishAt ? isoToDubaiLocalInput(entry.publishAt) : "",
  );
  // The panel stays open across refreshes, so publish_at can move underneath it
  // — someone else reschedules, or the sweep publishes. Re-seed the input when
  // the case's own value changes, so Save cannot quietly write back a time this
  // post no longer has.
  useEffect(() => {
    setWhen(entry.publishAt ? isoToDubaiLocalInput(entry.publishAt) : "");
  }, [entry.publishAt]);
  const validSlot = when.length > 0 && [0, 30].includes(Number(when.slice(-2)));
  const [confirmPost, setConfirmPost] = useState(false);

  // One detail read per selected card. `usePluginData` re-runs when the params
  // change, and this component only exists while a card is open.
  const { data, loading, error, refresh } = usePluginData<CaseDetailData>(
    "case-detail",
    { companyId, caseId: entry.id },
  );
  const detail = data?.detail ?? null;

  const [caption, setCaption] = useState("");
  const [altText, setAltText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [saving, setSaving] = useState(false);
  const saveContent = usePluginAction("save-content");

  // Seed the editor from the case the FIRST time each case loads. Keyed on the
  // case id, not on the data object, so a refresh after a save does not wipe
  // whatever the operator is in the middle of typing.
  useEffect(() => {
    if (!detail) return;
    setCaption(detail.caption ?? "");
    setAltText(detail.altText ?? "");
    setSaveState(null);
  }, [detail?.id]);

  const dirty =
    detail !== null &&
    (caption !== (detail.caption ?? "") || altText !== (detail.altText ?? ""));

  const alreadyPublished = Boolean(entry.publishUrl);

  // A status failure belongs in the Status section, which is always on screen.
  // A publish outcome belongs in the Post Now block, which is not.
  const statusFeedback = statusMessage(feedback);
  const publishFeedback = publishMessage(feedback);

  async function onSave() {
    if (!detail) return;
    setSaving(true);
    setSaveState(null);
    try {
      await saveContent({
        companyId,
        caseIdentifier: detail.identifier,
        caption,
        altText,
      });
      setSaveState({ ok: true, text: "Saved to the case." });
      refresh();
      onCaseChanged();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[content-calendar] caption save failed", err);
      setSaveState({ ok: false, text: `Not saved: ${message}` });
    } finally {
      setSaving(false);
    }
  }

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

      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
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
        {loading && !detail && <Spinner size="sm" label="Loading post" />}
      </div>

      {error && (
        <p style={{ marginTop: 12, fontSize: 11, color: "#f87171", lineHeight: 1.5 }}>
          Could not load this post: {error.message}
        </p>
      )}
      {data && !data.configured && (
        <p style={{ marginTop: 12, fontSize: 11, color: "#f87171", lineHeight: 1.5 }}>
          {data.error ?? "The plugin is not configured, so this post cannot be edited here."}
        </p>
      )}
      {data?.configured && data.error && (
        <p style={{ marginTop: 12, fontSize: 11, color: "#f87171", lineHeight: 1.5 }}>
          {data.error}
        </p>
      )}

      {alreadyPublished && (
        <p style={{ marginTop: 14, fontSize: 12 }}>
          <a href={entry.publishUrl as string} target="_blank" rel="noreferrer" style={{ color: "#4ade80" }}>
            Published → {entry.publishUrl}
          </a>
        </p>
      )}

      {/* ---- Text: caption and alt, one explicit Save ---- */}
      <div style={SECTION_STYLE}>
        <label style={LABEL_STYLE} htmlFor="cc-caption">
          Caption
        </label>
        <textarea
          id="cc-caption"
          value={caption}
          rows={7}
          disabled={!detail || saving}
          onChange={(e) => setCaption(e.target.value)}
          placeholder={detail ? "What this post says" : "Loading…"}
          style={{ ...FIELD_STYLE, lineHeight: 1.55, resize: "vertical" }}
        />

        <label style={{ ...LABEL_STYLE, marginTop: 10 }} htmlFor="cc-alt">
          Alt text (describes the image)
        </label>
        <input
          id="cc-alt"
          type="text"
          value={altText}
          disabled={!detail || saving}
          onChange={(e) => setAltText(e.target.value)}
          placeholder="A chart of weekly signups"
          style={FIELD_STYLE}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <button
            type="button"
            disabled={!detail || saving || !dirty}
            onClick={onSave}
            style={{
              background: !detail || !dirty || saving ? "#3f3f46" : "#2563eb",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              padding: "6px 16px",
              fontSize: 12,
              fontWeight: 600,
              cursor: !detail || !dirty || saving ? "default" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {dirty && !saving && (
            <span style={{ fontSize: 11, color: "#fbbf24" }}>Unsaved changes</span>
          )}
          {saving && <Spinner size="sm" label="Saving" />}
        </div>
        <Result state={saveState} />
        <p style={{ margin: "8px 0 0", fontSize: 11, color: "#71717a", lineHeight: 1.5 }}>
          Saved straight onto the case. Every other field — channel, schedule,
          image — is read and re-sent untouched, because Paperclip replaces
          <code> fields </code> wholesale on write.
        </p>
      </div>

      {/* ---- Image ---- */}
      <MediaSection
        companyId={companyId}
        detail={detail}
        data={data ?? null}
        altText={altText}
        disabled={busy !== null || saving}
        onUploaded={() => {
          refresh();
          onCaseChanged();
        }}
      />

      {/* ---- Status: the native case status, from a single dropdown ---- */}
      <div style={SECTION_STYLE}>
        <label style={LABEL_STYLE} htmlFor="cc-status">
          Status
        </label>
        <select
          id="cc-status"
          value={entry.status}
          disabled={busy !== null}
          onChange={(e) => onSetStatus(e.target.value as CaseLifecycle)}
          style={{ ...FIELD_STYLE, maxWidth: 220 }}
        >
          {!PANEL_STATUSES.includes(entry.status as CaseLifecycle) && (
            <option value={entry.status} disabled>
              {STATUS_STYLE[entry.status]?.label ?? entry.status}
            </option>
          )}
          {PANEL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_STYLE[s].label}
            </option>
          ))}
        </select>
        {busy === "status" && (
          <p style={{ fontSize: 11, color: "#a1a1aa", marginTop: 8 }}>Saving…</p>
        )}
        {statusFeedback && (
          <p
            role="alert"
            style={{
              margin: "8px 0 0",
              fontSize: 11,
              lineHeight: 1.5,
              color: statusFeedback.ok ? "#4ade80" : "#f87171",
            }}
          >
            {statusFeedback.ok
              ? statusFeedback.text
              : `Status not changed: ${statusFeedback.text} The case is still ${
                  STATUS_STYLE[entry.status]?.label ?? entry.status
                }.`}
          </p>
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
        <div style={SECTION_STYLE}>
          <label style={LABEL_STYLE}>Publish</label>

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

          {publishFeedback && (
            <p
              role="alert"
              style={{
                marginTop: 10,
                fontSize: 12,
                lineHeight: 1.5,
                color: publishFeedback.ok ? "#4ade80" : "#f87171",
              }}
            >
              {publishFeedback.text}
            </p>
          )}
        </div>
      )}

      {/* ---- Schedule ---- */}
      <div style={SECTION_STYLE}>
        <label style={LABEL_STYLE}>Publish at (Dubai, UTC+4)</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="datetime-local"
            step={1800}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            style={{ ...FIELD_STYLE, flex: 1, padding: "6px 8px" }}
          />
          <button
            type="button"
            disabled={busy !== null || !validSlot}
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
        {when && !validSlot && (
          <p style={{ margin: "6px 0 0", color: "#f87171", fontSize: 11 }}>
            Choose a Dubai time ending in :00 or :30.
          </p>
        )}
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
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

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

  /**
   * The open panel always renders the case as the LAST LOAD saw it.
   *
   * `selected` is only an id-carrying handle: an optimistic write, or the row
   * as it looked when the chip was clicked. Every refresh — after a save, after
   * Post Now, after the 15-minute sweep publishes something, after anyone else
   * edits the case — re-reads it here by id, so status, publish_url and
   * publish_at stay current while the panel stays open.
   */
  const selectedEntry = useMemo(
    () => reconcileSelection(selected, data ?? null),
    [selected, data],
  );

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
    if (!selectedEntry) return;
    setBusy("reschedule");
    try {
      await reschedule({
        companyId,
        caseId: selectedEntry.id,
        caseIdentifier: selectedEntry.identifier,
        publishAt: iso,
        previousPublishAt: selectedEntry.publishAt,
      });
      setSelected(null);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const onSetStatus = async (status: CaseLifecycle) => {
    if (!selectedEntry) return;
    setBusy("status");
    setFeedback(null);
    try {
      await setStatus({
        companyId,
        caseId: selectedEntry.id,
        caseIdentifier: selectedEntry.identifier,
        status,
      });
      // Optimistic, so the Post Now button unlocks in place rather than after a
      // round trip. It survives exactly until the refresh below re-reads this
      // case by id — see reconcileSelection: the server always wins.
      setSelected({ ...selectedEntry, status, approved: status === "approved" });
      refresh();
    } catch (err) {
      // Tagged "status", so it renders in the Status section. This used to go
      // to the shared Post Now result area, which is not rendered at all once a
      // case has a publish_url — a failed status change on a published post was
      // reported to nobody.
      console.error("[content-calendar] status change failed", err);
      setFeedback(actionFailure("status", err));
    } finally {
      setBusy(null);
    }
  };

  const onPostNow = async () => {
    if (!selectedEntry) return;
    setBusy("post");
    setFeedback(null);
    try {
      const res = (await postNow({
        companyId,
        caseId: selectedEntry.id,
        caseIdentifier: selectedEntry.identifier,
      })) as { ok?: boolean; outcome?: string; reason?: string; url?: string } | null;

      if (res?.ok && res.url) {
        setFeedback(actionSuccess("post", `Posted → ${res.url}`));
        setSelected({ ...selectedEntry, publishUrl: res.url });
      } else {
        setFeedback(
          actionFailure(
            "post",
            `Not posted (${res?.outcome ?? "unknown"}): ${res?.reason ?? "no reason returned"}`,
          ),
        );
      }
      refresh();
    } catch (err) {
      console.error("[content-calendar] post now failed", err);
      setFeedback(actionFailure("post", err));
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

      {selectedEntry && (
        <DetailPanel
          // Keyed on the case ID, not the object: a refresh that brings new
          // values for the SAME case must update the panel in place, while
          // selecting a DIFFERENT post remounts the editor so no draft caption
          // can survive into another post.
          key={selectedEntry.id}
          entry={selectedEntry}
          companyId={companyId}
          busy={busy}
          feedback={feedback}
          onClose={() => {
            setSelected(null);
            setFeedback(null);
          }}
          onReschedule={onReschedule}
          onSetStatus={onSetStatus}
          onPostNow={onPostNow}
          onCaseChanged={refresh}
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
