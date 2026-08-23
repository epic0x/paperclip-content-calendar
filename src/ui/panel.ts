/**
 * The detail panel's two pure decisions.
 *
 * Kept out of the component because both are rules, not rendering, and both
 * were previously wrong in ways that only showed up in front of an operator:
 * a panel that kept displaying the case as it was at click time, and a single
 * shared result area that swallowed status errors on published posts.
 *
 * No React, no DOM, no imports — so they are unit-tested directly.
 */

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
