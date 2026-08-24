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

import { assetContentPath, parseAssetRef } from "../attachments.js";

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
// The image a calendar card shows
// ---------------------------------------------------------------------------

/** The fields of a calendar entry this rule reads. The real entry is wider. */
export interface ChipMedia {
  mediaFile?: string | null;
  altText?: string | null;
  title?: string | null;
}

export interface ChipThumbnail {
  /** Same-origin, session-authenticated asset content path. */
  src: string;
  /** Never empty: a card's image has to say something to a screen reader. */
  alt: string;
}

function text(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * What, if anything, a month-grid card renders as its image.
 *
 * NO EXTRA READ. `media_file` is already on every calendar entry, and an asset
 * reference is enough on its own to name the content endpoint — so the card
 * needs the bytes and nothing else. Attachment metadata (filename, size, type)
 * only exists on GET /api/cases/:id, which is why the detail panel fetches it
 * and the grid must not: that would be one round trip per card, per render.
 *
 * Returns null unless `media_file` is a native asset reference. A legacy host
 * path or bare filename is a real, publishable value, but it is not something
 * the browser can load — pointing an <img> at it renders a broken-image icon
 * on the card and says nothing true. Null means the card simply shows no
 * image, which is what it did before this existed.
 */
export function chipThumbnail(entry: ChipMedia | null | undefined): ChipThumbnail | null {
  const assetId = parseAssetRef(entry?.mediaFile);
  if (!assetId) return null;

  const alt = text(entry?.altText);
  if (alt) return { src: assetContentPath(assetId), alt };

  // No alt on the case yet — the panel already nags about that. The card still
  // has to name the thing, so it borrows the post's own title.
  const title = text(entry?.title);
  return {
    src: assetContentPath(assetId),
    alt: title ? `Image for ${title}` : "Attached image with no alt text",
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
