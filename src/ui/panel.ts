/**
 * The calendar UI's pure decisions.
 *
 * Kept out of the components because they are rules, not rendering, and each
 * was previously wrong in a way that only showed up in front of an operator:
 * a panel that kept displaying the case as it was at click time, a single
 * shared result area that swallowed status errors on published posts, and a
 * month grid that ignored the attached image entirely.
 *
 * No React and no DOM — so they are unit-tested directly.
 */

import {
  assetContentPath,
  mediaKindOf,
  parseAssetRef,
  type MediaKind,
} from "../attachments.js";

/** The minimum the panel needs to identify a card; the real entry is wider. */
export interface Identified {
  id: string;
}

/** The shape of what the `calendar` data handler returns, as far as this cares. */
export interface CalendarSnapshot<T extends Identified> {
  days?: Array<{ entries?: T[] | null }> | null;
  unscheduled?: T[] | null;
}

/**
 * Re-read the selected card out of freshly loaded calendar data.
 *
 * REFRESHED DATA WINS. The panel is a long-lived view over a case that other
 * people, the publish sweep and the panel's own actions all keep writing to:
 * status, publish_url and publish_at can all move while it is open. Holding
 * the object captured at click time means an approval made elsewhere — or a
 * publish that just happened — is invisible until the panel is closed and
 * reopened.
 *
 * An optimistic local update therefore lives exactly until the next refresh
 * carries that id, which is the point: it unlocks the UI immediately without
 * ever outranking the server.
 *
 * A selected id that the snapshot does not contain (out of the visible month,
 * a thin response, a load in flight) keeps the last known entry rather than
 * closing the panel out from under whoever is typing in it.
 */
export function reconcileSelection<T extends Identified>(
  selected: T | null,
  data: CalendarSnapshot<T> | null | undefined,
): T | null {
  if (!selected || !data) return selected ?? null;

  for (const day of data.days ?? []) {
    for (const entry of day?.entries ?? []) {
      if (entry?.id === selected.id) return entry;
    }
  }
  for (const entry of data.unscheduled ?? []) {
    if (entry?.id === selected.id) return entry;
  }
  return selected;
}

// ---------------------------------------------------------------------------
// The media a calendar card shows
// ---------------------------------------------------------------------------

/** The fields of a calendar entry this rule reads. The real entry is wider. */
export interface ChipMedia {
  mediaFile?: string | null;
  /**
   * From the case's `media_type`, already classified by the worker.
   *
   * Three distinct states, and they are not interchangeable:
   *   "image" / "video" — render that
   *   null              — recorded, but a type this plugin does not render
   *   absent            — a bundle older than media_type, i.e. an image
   */
  mediaType?: MediaKind | null;
  altText?: string | null;
  title?: string | null;
}

export interface CardMedia {
  /** Which element the card renders. Never guessed from the file name. */
  kind: MediaKind;
  /** Same-origin, session-authenticated asset content path. */
  src: string;
  /** Never empty: a card's media has to say something to a screen reader. */
  alt: string;
}

/** @deprecated Use {@link CardMedia}. */
export type ChipThumbnail = CardMedia;

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * What, if anything, a month-grid card renders as its media.
 *
 * NO EXTRA READ. `media_file` and `media_type` are already on every calendar
 * entry, and an asset reference is enough on its own to name the content
 * endpoint — so the card needs the bytes and nothing else. Attachment metadata
 * (filename, size, type) only exists on GET /api/cases/:id, which is why the
 * detail panel fetches it and the grid must not: that would be one round trip
 * per card, per render. Carrying the KIND on the case field is what keeps that
 * true now that a card has two things it might render.
 *
 * Returns null unless `media_file` is a native asset reference. A legacy host
 * path or bare filename is a real, publishable value, but it is not something
 * the browser can load — pointing an <img> at it renders a broken-image icon
 * on the card and says nothing true. Null means the card simply shows no
 * media, which is what it did before this existed.
 */
export function cardMedia(entry: ChipMedia | null | undefined): CardMedia | null {
  const assetId = parseAssetRef(entry?.mediaFile);
  if (!assetId) return null;

  // `undefined` is data from before media_type existed, and that data is an
  // image. An explicit null is the projection saying "not renderable" — the
  // card shows nothing rather than a broken element.
  const kind: MediaKind | null =
    entry?.mediaType === undefined ? "image" : entry.mediaType;
  if (!kind) return null;

  const src = assetContentPath(assetId);
  const alt = text(entry?.altText);
  if (alt) return { kind, src, alt };

  // No alt on the case yet — the panel already nags about that. The card still
  // has to name the thing, so it borrows the post's own title.
  const title = text(entry?.title);
  const noun = kind === "video" ? "Video" : "Image";
  return {
    kind,
    src,
    alt: title
      ? `${noun} for ${title}`
      : `Attached ${noun.toLowerCase()} with no alt text`,
  };
}

/** @deprecated Use {@link cardMedia}, which also reports the kind. */
export const chipThumbnail = cardMedia;

// ---------------------------------------------------------------------------
// Playing video, which only the open panel ever does
// ---------------------------------------------------------------------------

export interface VideoPlayback {
  autoPlay: boolean;
  controls: boolean;
  muted: boolean;
  loop: boolean;
  /** Never "auto": a month of posts must not pull a month of video. */
  preload: "metadata";
}

/**
 * A video in the open panel.
 *
 * Still no autoplay — opening a post is not a request to play it — but this is
 * where the operator checks what is about to go out, so it has real controls
 * and it is NOT muted: approving a video without being able to hear it is
 * approving half of it.
 */
export const SELECTED_VIDEO_PLAYBACK: VideoPlayback = {
  autoPlay: false,
  controls: true,
  muted: false,
  loop: false,
  preload: "metadata",
};

/** What the panel needs off a case detail. The real detail is wider. */
export interface SelectedAttachment {
  assetId: string;
  contentPath: string;
  contentType: string;
  originalFilename?: string | null;
}

export interface SelectedDetail {
  altText?: string | null;
  activeAttachment?: SelectedAttachment | null;
}

export interface SelectedMedia {
  kind: MediaKind;
  /** The attachment's own content path — session-authenticated, same-origin. */
  src: string;
  alt: string;
  /** Video only. Null for an image, which has nothing to play. */
  playback: VideoPlayback | null;
}

/**
 * What the OPEN panel previews.
 *
 * THE ATTACHMENT IS THE AUTHORITY. The month grid has to trust the case's
 * `media_type` field because it has nothing else, but the panel is holding the
 * attachment record, and `contentType` on it is Paperclip's own account of the
 * bytes it stored. When the two disagree — a hand-edited case, a `set-media`
 * that lost a race, an asset replaced underneath — the field is the side that
 * can be wrong and the asset is the side that will actually be published.
 *
 * A type this plugin does not render is null rather than a coerced <img>:
 * a broken image in the preview says "your media is gone" about a post whose
 * media is fine.
 */
export function selectedMedia(
  detail: SelectedDetail | null | undefined,
): SelectedMedia | null {
  const attachment = detail?.activeAttachment;
  if (!attachment) return null;

  const kind = mediaKindOf(attachment.contentType);
  if (!kind) return null;

  const alt =
    text(detail?.altText) ||
    text(attachment.originalFilename) ||
    `Attached ${kind} with no alt text`;

  return {
    kind,
    src: attachment.contentPath,
    alt,
    playback: kind === "video" ? SELECTED_VIDEO_PLAYBACK : null,
  };
}

// ---------------------------------------------------------------------------
// Where an action's outcome is allowed to appear
// ---------------------------------------------------------------------------

/**
 * Which panel action produced a message.
 *
 * Load-bearing: the Post Now block is not rendered at all once a case has a
 * publish_url, so a message tagged `post` has nowhere to appear on a published
 * post. A failed status change has to be tagged `status` and rendered in the
 * Status section, which is always on screen, or it is shown to nobody.
 */
export type PanelActionKind = "status" | "post";

export interface ActionFeedback {
  kind: PanelActionKind;
  ok: boolean;
  text: string;
}

function describe(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}" && json !== "null") return json;
  } catch {
    /* circular or otherwise unserialisable — fall through */
  }
  return "The action failed and returned no reason.";
}

export function actionFailure(kind: PanelActionKind, err: unknown): ActionFeedback {
  return { kind, ok: false, text: describe(err) };
}

export function actionSuccess(kind: PanelActionKind, text: string): ActionFeedback {
  return { kind, ok: true, text };
}

function of(
  kind: PanelActionKind,
  feedback: ActionFeedback | null | undefined,
): ActionFeedback | null {
  return feedback && feedback.kind === kind ? feedback : null;
}

/** The message the always-rendered Status section shows, if any. */
export function statusMessage(
  feedback: ActionFeedback | null | undefined,
): ActionFeedback | null {
  return of("status", feedback);
}

/** The message the Post Now block shows, if any. */
export function publishMessage(
  feedback: ActionFeedback | null | undefined,
): ActionFeedback | null {
  return of("post", feedback);
}
