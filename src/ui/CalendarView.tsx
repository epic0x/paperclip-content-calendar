import { useEffect, useMemo, useRef, useState } from "react";
import {
  Spinner,
  usePluginAction,
  usePluginData,
} from "@paperclipai/plugin-sdk/ui";
import { validateMediaUpload, type MediaKind } from "../attachments.js";
import { uploadCaseMedia } from "./upload.js";
import {
  actionFailure,
  actionSuccess,
  cardMedia,
  publishMessage,
  reconcileSelection,
  selectedMedia,
  statusMessage,
  type ActionFeedback,
  type CardMedia,
} from "./panel.js";
import {
  dubaiDayKey,
  dubaiLocalToIso,
  dubaiMonth,
  dubaiTime,
  dubaiYear,
  isoToDubaiLocalInput,
} from "../time.js";
import {
  buildCreateDraft,
  calendarQuery,
  captionExcerpt,
  resolveDragSource,
  resolveDrop,
  sortForList,
} from "../schedule.js";

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
  /**
   * Image or video — or null for no media, or media of a type this plugin does
   * not render. Absent on entries from a worker older than this field, which
   * `cardMedia` reads as an image.
   */
  mediaType?: MediaKind | null;
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
  /** Images only. Kept so a bundle newer than its worker still degrades well. */
  allowedImageTypes: string[];
  allowedVideoTypes?: string[];
  /** Everything a post may carry. Absent when talking to a v0.3 worker. */
  allowedMediaTypes?: string[];
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
const UNSCHEDULED_TRAY_LIMIT = 40;

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

/** Which surface the month slot is showing. */
type ViewMode = "calendar" | "list";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The publishing DATE of a post, as a card says it.
 *
 * Date only, never the time. The time is a technical detail of when the
 * twice-hourly publish job picks the post up — it is set in the detail editor,
 * it is preserved when a card is dragged, and it is noise on a card: what an
 * operator scans a calendar for is which DAY something goes out.
 */
function dayLabel(iso: string | null | undefined): string {
  if (!iso) return "No date";
  const key = dubaiDayKey(iso);
  const [y, m, d] = key.split("-").map(Number);
  const weekday = DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
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
 * The media a CARD shows — the grid's 18px square and the list's 56px one.
 *
 * An image is a real image, lazy and decoded off the main thread. A VIDEO IS
 * NOT A VIDEO ELEMENT: it is a static tile with a play glyph.
 *
 * That is the whole performance rule of this file. A month is ~30 cards and the
 * list is every post the company has; each video element among them is a media
 * element the browser allocates and — even at `preload="metadata"` — a range
 * request it issues the moment the view renders. Paying that thirty times over
 * so that a handful of tiny squares can show a frame nobody can read is a cost
 * borne on every render by everyone. The one place a video is worth mounting is
 * the panel of the post that is actually open, where it can be watched.
 *
 * Both card surfaces render through here, so a video card cannot regress into a
 * player on one of them while staying static on the other.
 */
function MediaTile({
  media,
  size,
  broken,
  onBroken,
}: {
  media: CardMedia;
  size: number;
  /** The image already failed to load; the card shows nothing at all. */
  broken: boolean;
  onBroken: () => void;
}) {
  if (broken) return null;

  const base = {
    width: size,
    height: size,
    borderRadius: size > 24 ? 6 : 2,
    flexShrink: 0,
    background: "#18181b",
  };

  if (media.kind === "video") {
    return (
      <span
        role="img"
        aria-label={media.alt}
        style={{
          ...base,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid #3f3f46",
          color: "#a1a1aa",
          fontSize: Math.max(8, Math.round(size * 0.45)),
          lineHeight: 1,
        }}
      >
        ▶
      </span>
    );
  }

  return (
    <img
      src={media.src}
      alt={media.alt}
      loading="lazy"
      decoding="async"
      onError={onBroken}
      style={{ ...base, objectFit: "cover" }}
    />
  );
}

/**
 * A post on the month grid.
 *
 * Deliberately NOT interactive beyond opening the post (JC, 2026-08-23: "Don't
 * put those controls outside as clickable items in the calendar — only keep it
 * inside."). A grid of small buttons is where a mis-click publishes something.
 * The chip shows state; the panel changes it. Dragging does not change that:
 * `draggable` is an attribute on the same single button, not a second control
 * nested inside it, so the card still has exactly one target.
 *
 * NO TIME. The card carries the day it sits in and nothing finer. The Dubai
 * wall-clock time is a detail of when the twice-hourly job collects the post;
 * it lives in the detail editor, and it is preserved untouched when the card is
 * dragged to another day.
 *
 * The thumbnail is free: `media_file` and `media_type` already arrive with
 * every calendar entry, so the card renders the asset's bytes directly and
 * never reads case detail — see `cardMedia`. A video renders as a static tile,
 * never a media element; see `MediaTile`.
 */
function EntryChip({
  entry,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  entry: CalendarEntry;
  onSelect: (e: CalendarEntry) => void;
  onDragStart: (e: CalendarEntry, event: React.DragEvent) => void;
  /**
   * The drag finished — dropped, cancelled with Escape, or let go outside the
   * window. Every draggable surface has to report this, or the view keeps a
   * reference to a card whose drag is long over.
   */
  onDragEnd: () => void;
}) {
  const s = STATUS_STYLE[entry.status] ?? STATUS_STYLE.draft;
  const thumb = cardMedia(entry);
  // Keyed on the src, so re-pointing media_file at a working asset gets another
  // attempt rather than inheriting the previous one's failure.
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => onDragStart(entry, event)}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(entry)}
      title={`${entry.identifier} — ${entry.title} (${s.label}) — drag to another day`}
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
        cursor: "grab",
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
      {/* A card with no loadable media shows none — never a broken icon. */}
      {thumb && (
        <MediaTile
          media={thumb}
          size={18}
          broken={brokenThumb === thumb.src}
          onBroken={() => setBrokenThumb(thumb.src)}
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

/**
 * One post in the list view.
 *
 * Mobile first, and literally so: one relaxed card per row, `width: 100%` with
 * a wrapping flex layout and no fixed width or column track anywhere, so it
 * reflows rather than overflowing at 320px. A `repeat(2, …)` grid or a
 * `minWidth: 320` card is what puts a horizontal scrollbar on a phone.
 *
 * Everything an operator needs to recognise a post without opening it: the
 * publishing DATE (never the time), the native status, the title, a flattened
 * caption excerpt, the channel if it has one, and the thumbnail. The whole card
 * is a single button that selects the post — same rule as the grid chip, no
 * nested controls.
 *
 * NOT DRAGGABLE. The list has no day cells and no drop target anywhere: a row
 * that starts a drag can only ever end in a cancelled one, which is a control
 * that looks like it does something and does nothing. Rescheduling from here is
 * the date field in the panel the click opens.
 */
function ListRow({
  entry,
  onSelect,
}: {
  entry: CalendarEntry;
  onSelect: (e: CalendarEntry) => void;
}) {
  const thumb = cardMedia(entry);
  const [brokenThumb, setBrokenThumb] = useState<string | null>(null);
  const excerpt = captionExcerpt(entry.caption, 160);
  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        flexWrap: "wrap",
        gap: 12,
        width: "100%",
        boxSizing: "border-box",
        textAlign: "left",
        background: entry.publishUrl ? "#101c14" : "#18181b",
        border: "1px solid #27272a",
        borderLeft: `3px solid ${channelColor(entry.channel)}`,
        borderRadius: 10,
        padding: 14,
        cursor: "pointer",
        color: "#e4e4e7",
        font: "inherit",
      }}
    >
      {thumb && (
        <MediaTile
          media={thumb}
          size={56}
          broken={brokenThumb === thumb.src}
          onBroken={() => setBrokenThumb(thumb.src)}
        />
      )}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: entry.publishAt ? "#a1a1aa" : "#f87171",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {dayLabel(entry.publishAt)}
          </span>
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
          {entry.publishUrl && <span style={{ color: "#4ade80", fontSize: 11 }}>↗</span>}
        </span>
        <span
          style={{
            display: "block",
            marginTop: 6,
            fontSize: 14,
            fontWeight: 600,
            color: "#fafafa",
            lineHeight: 1.35,
          }}
        >
          {entry.title}
        </span>
        {excerpt && (
          <span
            style={{
              display: "block",
              marginTop: 4,
              fontSize: 12,
              color: "#a1a1aa",
              lineHeight: 1.5,
            }}
          >
            {excerpt}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The list surface: every post the calendar knows, one card per row.
 *
 * Ordered by `sortForList` and nothing else — soonest first, undated last —
 * because a second ordering rule here would drift from the tested one. Undated
 * posts belong at the bottom AND in this list: it is the only view that shows
 * them next to everything else, which is where they get noticed and given a
 * date.
 *
 * Click to open, and nothing else — there is no drop target on this surface, so
 * there is no drag either. See `ListRow`.
 */
function ListView({
  entries,
  onSelect,
}: {
  entries: CalendarEntry[];
  onSelect: (e: CalendarEntry) => void;
}) {
  const ordered = sortForList(entries);
  if (ordered.length === 0) {
    return (
      <div style={{ marginTop: 16 }}>
        <Notice title="No posts yet" body="Use New post to create the first one." />
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        marginTop: 16,
      }}
    >
      {ordered.map((e) => (
        <ListRow key={e.id} entry={e} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** The segmented control that swaps the month grid for the list. */
function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  const segment = (value: ViewMode, label: string) => {
    const active = view === value;
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onChange(value)}
        style={{
          background: active ? "#2563eb" : "transparent",
          border: "none",
          color: active ? "#fff" : "#a1a1aa",
          padding: "4px 14px",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label="Show the calendar or the list"
      style={{
        display: "inline-flex",
        border: "1px solid #3f3f46",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      {segment("calendar", "Calendar")}
      {segment("list", "List")}
    </div>
  );
}

/**
 * Create a post without leaving the calendar.
 *
 * A title, an optional caption, and a DATE. No time control: the operator is
 * scheduling a day's post, and the slot — the first free half hour from 09:00
 * Dubai — is chosen by the server against every case the company has, so two
 * people creating on the same day cannot be handed the same 09:00.
 *
 * `buildCreateDraft` is the same rule the worker's action re-runs, so the form
 * refuses locally exactly what the server would refuse, next to the fields that
 * caused it and without losing what was typed.
 *
 * What it creates is a DRAFT with a date and nothing else — no channel, no
 * approval, no publish URL — so the publish job cannot send it. Scheduling is
 * not approving.
 */
function CreatePostForm({
  entries,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  /** Every entry the calendar knows, so a full day is refused before submit. */
  entries: CalendarEntry[];
  busy: boolean;
  /** The server's refusal, if the submit already went and came back. */
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: { title: string; caption: string | null; date: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [date, setDate] = useState(() => dubaiDayKey(new Date()));
  const [attempted, setAttempted] = useState(false);

  const draft = buildCreateDraft({ title, caption, date, entries });
  // Nothing is complained about until the operator has tried once — a form that
  // is red before it is filled in is noise.
  const message = error ?? (attempted && !draft.ok ? draft.error : null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (!draft.ok) return;
    onSubmit({ title: draft.title, caption: draft.caption, date: draft.date });
  }

  return (
    <form
      onSubmit={submit}
      style={{
        marginTop: 16,
        padding: 16,
        border: "1px solid #27272a",
        borderRadius: 10,
        background: "#111113",
        // Mobile first: fills a phone, caps on a desktop.
        width: "100%",
        maxWidth: 520,
        boxSizing: "border-box",
      }}
    >
      <label style={LABEL_STYLE} htmlFor="cc-new-title">
        Title
      </label>
      <input
        id="cc-new-title"
        type="text"
        required
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What this post is about"
        style={FIELD_STYLE}
      />

      <label style={{ ...LABEL_STYLE, marginTop: 12 }} htmlFor="cc-new-caption">
        Caption (optional)
      </label>
      <textarea
        id="cc-new-caption"
        rows={4}
        value={caption}
        disabled={busy}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="What this post says. Can be written later."
        style={{ ...FIELD_STYLE, lineHeight: 1.55, resize: "vertical" }}
      />

      <label style={{ ...LABEL_STYLE, marginTop: 12 }} htmlFor="cc-new-date">
        Publishing date (Dubai)
      </label>
      <input
        id="cc-new-date"
        type="date"
        required
        value={date}
        disabled={busy}
        onChange={(e) => setDate(e.target.value)}
        style={{ ...FIELD_STYLE, maxWidth: 220 }}
      />
      <p style={{ margin: "6px 0 0", fontSize: 11, color: "#71717a", lineHeight: 1.5 }}>
        The time is chosen for you: the first free half-hour slot on that day,
        from 09:00 Dubai. The post is created as a draft with no channel, so it
        cannot publish until you open it and approve it.
      </p>

      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button
          type="submit"
          disabled={busy}
          style={{
            background: busy ? "#3f3f46" : "#2563eb",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Creating…" : "Create post"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          style={{
            background: "transparent",
            border: "1px solid #3f3f46",
            borderRadius: 6,
            color: "#a1a1aa",
            padding: "8px 16px",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        {busy && <Spinner size="sm" label="Creating the post" />}
      </div>

      {message && (
        <p
          role="alert"
          style={{ margin: "10px 0 0", fontSize: 12, color: "#f87171", lineHeight: 1.5 }}
        >
          Not created: {message}
        </p>
      )}
    </form>
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
 * The media the case is currently carrying.
 *
 * The preview reads the NATIVE asset content endpoint (`/api/assets/:id/content`),
 * which is same-origin and session-authenticated, so no signed URL or copy of
 * the bytes is involved. Empty, legacy and broken states are all spelled out
 * rather than rendering silently broken media.
 *
 * ONLY `detail.activeAttachment` is ever shown as the post's media, and the
 * worker only fills that in when `media_file` names that exact asset. Anything
 * else the case happens to carry is listed underneath as history: publishing
 * reads `media_file`, so previewing the newest upload as "the media" would
 * promise something the post is not going to send.
 *
 * WHICH ELEMENT is decided by `selectedMedia`, from the ATTACHMENT's own
 * content type rather than the case's `media_type` field — the panel is
 * holding Paperclip's own record of the stored bytes, so it uses it. A video
 * gets real controls here (this is where a post is checked before it goes out)
 * but still never autoplays.
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
  const preview = selectedMedia(detail);
  const maxBytes = data?.maxUploadBytes ?? 10 * 1024 * 1024;
  // A worker older than video support sends only `allowedImageTypes`; then the
  // picker offers images, which is exactly what that worker can handle.
  const allowedTypes = data?.allowedMediaTypes ??
    data?.allowedImageTypes ?? ["image/png", "image/jpeg"];
  const accept = allowedTypes.join(",");

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !detail) return;

    const check = validateMediaUpload(
      { name: file.name, type: file.type, size: file.size },
      { maxBytes, allowed: allowedTypes },
    );
    if (!check.ok) {
      setState({ ok: false, text: check.error });
      return;
    }

    setUploading(true);
    setState({ ok: true, text: `Uploading ${file.name} (${fileSize(file.size)})…` });
    try {
      // 1. Bytes go to Paperclip's own case attachment endpoint. Until this
      //    succeeds the case still points at the previous media.
      const uploaded = await uploadCaseMedia({
        caseId: detail.id,
        file,
        maxBytes,
        allowedTypes,
      });
      // 2. Only then does the worker repoint media_file — with the content
      //    type Paperclip reported for the stored asset, so media_file and
      //    media_type are written together and cannot disagree. The worker
      //    re-verifies it against the attachment regardless.
      await setMedia({
        companyId,
        caseIdentifier: detail.identifier,
        assetId: uploaded.assetId,
        contentType: uploaded.contentType,
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
      console.error("[content-calendar] media upload failed", err);
      setState({
        ok: false,
        text: `Not attached: ${message} The previous media is unchanged.`,
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={SECTION_STYLE}>
      <label style={LABEL_STYLE}>Media</label>

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
                The media is attached but its preview could not be loaded from{" "}
                {attachment.contentPath}.
              </span>
            ) : !preview ? (
              // `selectedMedia` answered "nothing this panel renders". Saying so
              // is the point: an empty image element reads as media that has gone
              // missing, and this media is attached and fine.
              <span style={{ fontSize: 11, color: "#a1a1aa", padding: 16 }}>
                {attachment.contentType} is attached, but this panel has no
                preview for it.
              </span>
            ) : preview.kind === "video" ? (
              <video
                src={preview.src}
                aria-label={preview.alt}
                controls={preview.playback?.controls ?? true}
                muted={preview.playback?.muted ?? false}
                loop={preview.playback?.loop ?? false}
                // Pinned, not read off `playback`: this is where a post is
                // checked before it goes out, so opening it must never start
                // playback, and a preview must never become a download.
                autoPlay={false}
                preload="metadata"
                playsInline
                onError={() => setBrokenAsset(attachment.assetId)}
                style={{
                  maxWidth: "100%",
                  maxHeight: 200,
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <img
                src={preview.src}
                alt={preview.alt}
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
              No alt text. X requires alt on every media attachment — add it above
              and save.
            </p>
          )}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "#71717a", lineHeight: 1.5 }}>
          {detail && detail.attachments.length > 0
            ? "This post has no media set. The files below are attached to the case but none of them is what it publishes."
            : "No media attached to this post."}
        </p>
      )}

      {detail &&
        detail.mediaFile &&
        !detail.legacyMediaFile &&
        !detail.activeAttachment && (
          <p style={{ margin: "8px 0 0", fontSize: 11, color: "#f87171", lineHeight: 1.5 }}>
            <code>media_file</code> points at {detail.mediaFile}, which is not one of
            this case's attachments. Nothing is previewed because nothing here is
            that asset. Uploading media repoints it.
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
          aria-label={attachment ? "Replace media" : "Attach media"}
          style={{ fontSize: 11, color: "#a1a1aa", maxWidth: 260 }}
        />
        {uploading && <Spinner size="sm" label="Uploading" />}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 11, color: "#71717a", lineHeight: 1.5 }}>
        {allowedTypes.join(", ")} up to {fileSize(maxBytes)}. The current media
        stays in place until the new one is attached.
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

        {/* X counts characters, so the operator gets to see the count while
            typing. Advisory only: the limit is X's, the truth about what fits
            is X's too, and Save never refuses on it. */}
        {entry.channel?.trim().toLowerCase() === "x" && (
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 11,
              textAlign: "right",
              color: caption.length > 280 ? "#f87171" : "#a1a1aa",
            }}
          >
            {caption.length}/280
          </p>
        )}

        <label style={{ ...LABEL_STYLE, marginTop: 10 }} htmlFor="cc-alt">
          Alt text (describes the media)
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
  const [view, setView] = useState<ViewMode>("calendar");
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** A refused or failed drag. Shown above the grid, where the drop happened. */
  const [dragError, setDragError] = useState<string | null>(null);
  /**
   * The card currently being dragged.
   *
   * `dataTransfer` is the authority — it is what makes the drag work across
   * browsers and it survives a re-render mid-drag — but it only carries a
   * string, so the entry itself is kept here and matched by id on drop.
   */
  const dragging = useRef<CalendarEntry | null>(null);

  const grid = useMemo(() => monthGrid(year, month), [year, month]);
  const from = grid[0];
  const to = grid[grid.length - 1];

  /**
   * The month grid reads its 42 days; the list reads EVERYTHING.
   *
   * Shaped by `calendarQuery` rather than inline, so the difference between the
   * two surfaces is one tested rule instead of a ternary that quietly made the
   * list a month view with its navigation hidden.
   */
  const { data, loading, error, refresh } = usePluginData<CalendarData>(
    "calendar",
    calendarQuery({ companyId, view, from, to }),
  );
  const reschedule = usePluginAction("reschedule");
  const setStatus = usePluginAction("set-status");
  const postNow = usePluginAction("post-now");
  const createPost = usePluginAction("create-post");

  /**
   * Every post the calendar is holding — scheduled and unscheduled, unfiltered.
   *
   * The channel filter is a VIEW, so it must not reach the drop rule: a slot
   * held by a LinkedIn post is still held while the grid is filtered to X, and
   * resolving a drop against the filtered set would hand out a time that is
   * taken. LIMITATION: `days` is bounded by the from/to the grid asked for, so
   * this is the visible month plus every undated post. That covers every drop
   * target on screen; the authoritative slot for a CREATE is picked by the
   * worker against all cases, not from here.
   */
  const allEntries = useMemo(() => {
    const all: CalendarEntry[] = [];
    for (const d of data?.days ?? []) all.push(...(d.entries ?? []));
    all.push(...(data?.unscheduled ?? []));
    return all;
  }, [data]);

  const listEntries = useMemo(
    () =>
      channelFilter === "all"
        ? allEntries
        : allEntries.filter(
            (e) => (e.channel ?? "").toLowerCase() === channelFilter,
          ),
    [allEntries, channelFilter],
  );

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

  /**
   * Create a post from the inline form.
   *
   * The browser sends what the operator typed and a DATE. It deliberately does
   * NOT send an instant: the worker re-reads the company's cases and picks the
   * slot itself, because this browser's month may be stale, may be filtered,
   * and is certainly not the only one open.
   *
   * On success the calendar goes to where the post actually landed — the month
   * of the instant the server chose, not the month that was on screen — and
   * opens it, so creating a post ends with the post in front of you.
   */
  const onCreate = async (draft: {
    title: string;
    caption: string | null;
    date: string;
  }) => {
    setBusy("create");
    setCreateError(null);
    try {
      const res = (await createPost({
        companyId,
        title: draft.title,
        caption: draft.caption ?? "",
        date: draft.date,
      })) as {
        ok?: boolean;
        entry?: CalendarEntry;
        publishAt?: string;
        identifier?: string;
      } | null;

      const landed = res?.publishAt ?? res?.entry?.publishAt ?? null;
      if (!res?.ok || !landed) {
        setCreateError("the server did not report a created post.");
        return;
      }

      setYear(dubaiYear(landed));
      setMonth(dubaiMonth(landed));
      // The created case as the server returned it. `reconcileSelection` keeps
      // it selected until the refresh below carries the same id, then the
      // server's copy takes over — the same rule every other optimistic write
      // in this view follows.
      if (res.entry) setSelected(res.entry);
      setShowCreate(false);
      refresh();
    } catch (err) {
      console.error("[content-calendar] create post failed", err);
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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

  const onDragStartEntry = (entry: CalendarEntry, event: React.DragEvent) => {
    dragging.current = entry;
    setDragError(null);
    // Firefox refuses to start a drag at all unless something is on the
    // transfer, so the id goes on it — and it is also what identifies the card
    // on drop, since the ref cannot be trusted across a re-render.
    event.dataTransfer.setData("text/plain", entry.id);
    event.dataTransfer.effectAllowed = "move";
  };

  /**
   * The drag is over — dropped, cancelled, or abandoned outside the window.
   *
   * `dragend` fires on ALL of those, which is exactly why the ref is dropped
   * here rather than only on a successful drop. A ref that survives a cancelled
   * drag is a card that the next stray drop can reschedule.
   */
  const onDragEndEntry = () => {
    dragging.current = null;
  };

  /**
   * A card was dropped on a day cell.
   *
   * `resolveDrop` decides what that MEANS — and the two cases are deliberately
   * different. A scheduled post keeps its Dubai wall-clock time and changes
   * only its date, because that time is not on the card: the operator cannot
   * see what a drag would be giving up, so a drag must not take it. An
   * unscheduled post has no time to keep, so it takes the first free slot on
   * the target day, exactly like Create does.
   *
   * The write goes through the SAME `reschedule` action the panel's Save uses,
   * so a drag and a typed time hit one server path with one set of validations
   * and one row in the schedule-override log.
   */
  const onDropOnDay = async (targetDate: string, event: React.DragEvent) => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    // WHAT was dropped is decided first, and by the pure rule: a file from the
    // desktop and a drop with no id are both "not a card", and neither may fall
    // through to whatever the ref is still holding. Nothing below this line
    // runs — not resolveDrop, not reschedule — without a card the transfer
    // actually named.
    const source = resolveDragSource({
      types: transfer ? Array.from(transfer.types ?? []) : [],
      fileCount: transfer?.files?.length ?? 0,
      transferId: transfer?.getData("text/plain"),
      held: dragging.current,
      entries: allEntries,
    });
    dragging.current = null;
    setDragError(null);
    if (!source.ok) {
      setDragError(source.reason);
      return;
    }
    const dragged = source.entry;

    const move = resolveDrop({ entry: dragged, targetDate, entries: allEntries });
    if (!move.ok) {
      setDragError(move.reason);
      return;
    }
    // Dropped back where it started: no write, no round trip, no log row.
    if (move.unchanged) return;

    setBusy("drag");
    try {
      await reschedule({
        companyId,
        caseId: dragged.id,
        caseIdentifier: dragged.identifier,
        publishAt: move.publishAt,
        previousPublishAt: move.previousPublishAt,
      });
      refresh();
    } catch (err) {
      console.error("[content-calendar] drag reschedule failed", err);
      setDragError(
        `${dragged.identifier} was not moved: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
        <button
          type="button"
          onClick={() => {
            setShowCreate((open) => !open);
            setCreateError(null);
          }}
          style={{
            background: showCreate ? "#3f3f46" : "#2563eb",
            border: "none",
            borderRadius: 8,
            color: "#fff",
            padding: "8px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {showCreate ? "Close" : "+ New post"}
        </button>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginLeft: "auto",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <ViewToggle view={view} onChange={setView} />
          {view === "calendar" && (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <NavButton onClick={() => step(-1)}>←</NavButton>
              <span style={{ minWidth: 150, textAlign: "center", fontSize: 14 }}>
                {monthLabel}
              </span>
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
          )}
          {/* The list is not a month, so it gets no month arrows: they would
              navigate something the list does not obey. It says what it IS
              showing instead — everything, and how much of it. */}
          {view === "list" && (
            <span style={{ fontSize: 12, color: "#a1a1aa", textAlign: "center" }}>
              All publishing dates · {listEntries.length} post
              {listEntries.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </header>

      {showCreate && (
        <CreatePostForm
          entries={allEntries}
          busy={busy === "create"}
          error={createError}
          onCancel={() => {
            setShowCreate(false);
            setCreateError(null);
          }}
          onSubmit={onCreate}
        />
      )}

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

      {dragError && (
        <p
          role="alert"
          style={{
            margin: "14px 0 0",
            fontSize: 12,
            lineHeight: 1.5,
            color: "#f87171",
          }}
        >
          {dragError}
        </p>
      )}
      {busy === "drag" && (
        <p style={{ margin: "14px 0 0", fontSize: 12, color: "#a1a1aa" }}>
          Moving the post…
        </p>
      )}

      {/* One slot, two surfaces: the list REPLACES the month grid rather than
          sitting beside or beneath it. */}
      {view === "calendar" ? (
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
                // EVERY cell is a drop zone, including the greyed-out days that
                // spill in from the neighbouring months — they are real dates
                // and dropping on one is a reasonable thing to mean. A cell must
                // preventDefault on dragover or the browser refuses the drop
                // outright and the card silently snaps back.
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  void onDropOnDay(date, event);
                }}
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
                  <EntryChip
                    key={e.id}
                    entry={e}
                    onSelect={setSelected}
                    onDragStart={onDragStartEntry}
                    onDragEnd={onDragEndEntry}
                  />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <ListView entries={listEntries} onSelect={setSelected} />
      )}

      {view === "calendar" && data && data.unscheduled.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: 13, color: "#f87171", margin: "0 0 8px" }}>
            {data.unscheduled.length} post{data.unscheduled.length === 1 ? "" : "s"} with no
            publish date — drag one onto a day to schedule it
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.unscheduled.slice(0, UNSCHEDULED_TRAY_LIMIT).map((e) => (
              <button
                key={e.id}
                type="button"
                draggable
                onDragStart={(event) => onDragStartEntry(e, event)}
                onDragEnd={onDragEndEntry}
                onClick={() => setSelected(e)}
                style={{
                  background: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: 6,
                  padding: "4px 8px",
                  color: "#d4d4d8",
                  fontSize: 11,
                  cursor: "grab",
                }}
              >
                {e.identifier} · {e.title.slice(0, 42)}
              </button>
            ))}
          </div>
          {/*
            The tray is capped at 40 chips — a company with 300 undated posts
            would otherwise render 300 draggable buttons under every month. The
            cap has to SAY it is a cap: a silently truncated tray reads as "this
            is all of them", and the posts past 40 are exactly the ones nobody
            is scheduling. List view has no cap and shows undated posts too.
          */}
          {data.unscheduled.length > UNSCHEDULED_TRAY_LIMIT && (
            <p style={{ margin: "8px 0 0", fontSize: 11, color: "#a1a1aa" }}>
              +{data.unscheduled.length - UNSCHEDULED_TRAY_LIMIT} more — switch to
              List view to see every undated post.
            </p>
          )}
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
