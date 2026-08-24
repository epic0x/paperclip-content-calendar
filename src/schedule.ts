/**
 * The calendar's pure scheduling rules.
 *
 * Every function here converts between a Dubai calendar date — what an operator
 * points at, drags onto, and types into a date field — and the UTC instant that
 * `publish_at` actually stores. Dubai is permanently UTC+4 with no daylight
 * saving, so the two are four hours apart, which is enough to disagree about
 * the DATE twice a day. Getting that wrong moves a post by a day.
 *
 * Kept out of the components and out of the worker for the same reason
 * `src/ui/panel.ts` is: these are rules, not rendering and not IO. No React, no
 * DOM, no fetch — so both sides import the same answers and the answers are
 * unit-tested directly.
 */

import { dubaiDayKey, dubaiLocalToIso, dubaiTime } from "./time.js";

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The first slot of the publishing day, in Dubai wall-clock time. */
export const DAY_START = "09:00";

/** Half-hour slots per day. The publish job runs at :00 and :30. */
const SLOTS_PER_DAY = 48;
const START_INDEX = 18; // 09:00 / 0.5h

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * A real Dubai calendar date, `YYYY-MM-DD`.
 *
 * The round-trip through Date.UTC is what rejects `2026-02-30`: the regex alone
 * accepts it, and `new Date` rolls it forward to March 2nd — which would file a
 * post under a day the operator never chose.
 */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * Every half-hour slot of a day, in the order the calendar hands them out.
 *
 * Working hours first — 09:00 through 23:30 — and only then the small hours, so
 * a day that already has fifteen posts on it puts the sixteenth at midnight
 * rather than at 00:00 before it has offered 10:00. The whole day is reachable
 * because refusing to schedule a 31st post is worse than scheduling it at 02:00
 * where the operator can see and move it.
 */
export function slotOrder(): string[] {
  return Array.from({ length: SLOTS_PER_DAY }, (_, i) => {
    const step = (START_INDEX + i) % SLOTS_PER_DAY;
    return `${pad(Math.floor(step / 2))}:${step % 2 ? "30" : "00"}`;
  });
}

/** The UTC instant for a Dubai date and wall-clock time, or null if not real. */
function instantFor(dayKey: string, hhmm: string): string | null {
  try {
    return dubaiLocalToIso(`${dayKey}T${hhmm}`);
  } catch {
    return null;
  }
}

/** The Dubai `HH:mm` an instant falls on, or null if it is not an instant. */
function wallClock(value: unknown): { day: string; time: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return { day: dubaiDayKey(value), time: dubaiTime(value) };
  } catch {
    return null;
  }
}

/**
 * The first half-hour slot on a Dubai date that no current entry holds.
 *
 * `taken` is every `publish_at` the calendar knows about — the whole set, not
 * the visible month — because a slot held by a post scrolled off screen is
 * still held. Entries on other Dubai days are ignored, and the comparison is
 * made in DUBAI, so `2026-09-10T20:00Z` counts against the 11th (where it is
 * 00:00) and not against the 10th.
 *
 * Returns null when the date is not real or every slot of it is taken. Null is
 * an answer the caller must show, never a value to fall back from: quietly
 * picking "09:00 anyway" would double-book a post onto another one's slot.
 */
export function firstFreeSlot(
  dayKey: string,
  taken: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!isDayKey(dayKey)) return null;

  const held = new Set<string>();
  for (const value of taken) {
    const at = wallClock(value);
    if (at && at.day === dayKey) held.add(at.time);
  }

  for (const slot of slotOrder()) {
    if (held.has(slot)) continue;
    const iso = instantFor(dayKey, slot);
    if (iso) return iso;
  }
  return null;
}

/**
 * Move an instant to another Dubai date, keeping its Dubai time of day.
 *
 * This is what a drag across the grid means: the operator moved the post to a
 * DAY and said nothing about the time, so the time it already had — which is
 * not shown on the card and which someone chose deliberately — survives.
 *
 * Both conversions go through the Dubai helpers rather than string slicing.
 * A post at 00:00 Dubai is stored as 20:00Z on the PREVIOUS day; slicing its
 * ISO string would read the wrong date and move it one day too far.
 */
export function replaceDubaiDate(iso: string, dayKey: string): string {
  const at = wallClock(iso);
  if (!at) throw new Error(`not a valid instant: ${String(iso)}`);
  if (!isDayKey(dayKey)) {
    throw new Error(`not a valid Dubai date: ${String(dayKey)}`);
  }
  const moved = instantFor(dayKey, at.time);
  if (!moved) throw new Error(`not a valid Dubai date: ${dayKey}`);
  return moved;
}

/** The fields a drop rule reads off an entry. The real entry is wider. */
export interface Schedulable {
  id?: string;
  publishAt?: string | null;
}

export type DropResolution =
  | {
      ok: true;
      publishAt: string;
      previousPublishAt: string | null;
      /** True when the card was dropped on the day it already sits on. */
      unchanged: boolean;
    }
  | { ok: false; reason: string };

/**
 * What dropping a card on a day cell means.
 *
 * Two cases, and they are deliberately different:
 *
 *   scheduled   — only the DATE changes. The time is preserved because it is
 *                 not on the card: the operator cannot see what they would be
 *                 giving up, so a drag must not take it. A preserved time may
 *                 land on a slot another post holds, and that is correct — the
 *                 alternative is moving a post to a time nobody chose.
 *   unscheduled — there is no time to preserve, so it takes the first free slot
 *                 on the target day, exactly like Create does.
 *
 * A drop on the day the card already sits on is `unchanged`, so the caller can
 * skip the reschedule round trip rather than writing the value back to itself.
 */
export function resolveDrop(input: {
  entry: Schedulable | null | undefined;
  targetDate: unknown;
  entries: ReadonlyArray<Schedulable>;
}): DropResolution {
  const { entry, targetDate, entries } = input;
  if (!entry) return { ok: false, reason: "Nothing was dragged." };
  if (!isDayKey(targetDate)) {
    return {
      ok: false,
      reason: `${String(targetDate) || "That"} is not a date on this calendar.`,
    };
  }

  const previous = typeof entry.publishAt === "string" && entry.publishAt.trim()
    ? entry.publishAt
    : null;

  if (previous) {
    const at = wallClock(previous);
    if (!at) {
      return { ok: false, reason: `This post's publish date (${previous}) is not readable.` };
    }
    if (at.day === targetDate) {
      return { ok: true, publishAt: previous, previousPublishAt: previous, unchanged: true };
    }
    return {
      ok: true,
      publishAt: replaceDubaiDate(previous, targetDate),
      previousPublishAt: previous,
      unchanged: false,
    };
  }

  const slot = firstFreeSlot(targetDate, entries.map((e) => e?.publishAt ?? null));
  if (!slot) {
    return {
      ok: false,
      reason: `${targetDate} is full — every half-hour slot on it already has a post.`,
    };
  }
  return { ok: true, publishAt: slot, previousPublishAt: null, unchanged: false };
}

/** Which surface the calendar slot is showing. */
export type CalendarSurface = "calendar" | "list";

/** The params `usePluginData("calendar", …)` is called with, or nothing. */
export type CalendarQuery =
  | { companyId: string; from: string; to: string }
  | { companyId: string }
  | undefined;

/**
 * What the view asks the worker for, per surface.
 *
 * The MONTH GRID can only draw the 42 days it lays out, so it asks for exactly
 * those and the worker filters to them. The LIST is a different promise — every
 * publishing date the company has, in one column — so it must ask UNBOUNDED.
 * Sending the grid's from/to with the month navigation hidden made the list a
 * month view in disguise: posts outside the month the operator happened to have
 * open simply were not in it, and nothing on screen said so.
 *
 * `undefined` when there is no company: `usePluginData` skips the read entirely
 * rather than asking for a company that does not exist.
 */
export function calendarQuery(input: {
  companyId: string | null | undefined;
  view: CalendarSurface;
  from: string;
  to: string;
}): CalendarQuery {
  const { companyId, view, from, to } = input;
  if (!companyId) return undefined;
  if (view === "list") return { companyId };
  return { companyId, from, to };
}

/** The fields identifying a dragged card. The real entry is wider. */
export interface Draggable {
  id?: string;
}

export type DragSource<T> =
  | { ok: true; entry: T }
  | { ok: false; reason: string };

/**
 * WHICH card — if any — a drop is carrying.
 *
 * The `dataTransfer` id is the authority and the only thing that identifies a
 * drop. The view also keeps the dragged entry in a ref, because the transfer
 * carries a string and the drop needs the entry, but that ref is a piece of
 * state that OUTLIVES the drag it belongs to: a cancelled drag, a drag that
 * ended outside the window, a file dragged in from the desktop, a selection
 * dragged out of a text field — none of them clear it, and none of them are a
 * card. Reading `id → entries, else the ref` therefore rescheduled the last
 * card dragged whenever the drop carried no id at all. The operator moved
 * nothing and a post silently changed its date.
 *
 * So: files are refused outright, an empty id is refused, and the ref is only
 * ever consulted to supply the ENTRY for an id the transfer actually named —
 * never to supply the identity itself.
 *
 * A transfer with no `types` is not evidence of a file drop (some browsers
 * report none on drop); only `Files` in the types or actual files on the
 * transfer are.
 */
export function resolveDragSource<T extends Draggable>(input: {
  types?: ReadonlyArray<string> | null;
  fileCount?: number | null;
  transferId: unknown;
  held?: T | null;
  entries: ReadonlyArray<T>;
}): DragSource<T> {
  const { types, fileCount, transferId, held, entries } = input;

  const carriesFiles =
    (types ?? []).some((t) => String(t).toLowerCase() === "files") ||
    (fileCount ?? 0) > 0;
  if (carriesFiles) {
    return {
      ok: false,
      reason: "That is a file, not a post. Drag a card from this calendar.",
    };
  }

  const id = typeof transferId === "string" ? transferId.trim() : "";
  if (!id) {
    return {
      ok: false,
      reason: "That was not a post from this calendar, so nothing was moved.",
    };
  }

  const found = entries.find((e) => e?.id === id);
  if (found) return { ok: true, entry: found };
  // The ref only answers for the card the transfer named. Anything else it is
  // holding is a leftover from an earlier drag.
  if (held && held.id === id) return { ok: true, entry: held };

  return {
    ok: false,
    reason: "That post is no longer on this calendar — refresh and try again.",
  };
}

/** The fields the list ordering reads. The real entry is wider. */
export interface Listable {
  publishAt?: string | null;
  identifier?: string | null;
  title?: string | null;
}

/**
 * Where one entry sits in the list's three bands, and what orders it inside
 * its band.
 *
 *   0 — a readable instant, ordered by the MOMENT it names
 *   1 — a publish_at that is not readable as an instant, ordered by its text
 *   2 — no publish_at at all, ordered by identifier alone
 */
function listRank(value: unknown): { band: 0 | 1 | 2; at: number; raw: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { band: 2, at: 0, raw: "" };
  const at = Date.parse(raw);
  return Number.isNaN(at) ? { band: 1, at: 0, raw } : { band: 0, at, raw };
}

/**
 * The order the list view renders in: soonest first, undated last.
 *
 * Soonest is decided on the INSTANT, not on the string. `publish_at` reaches
 * this list as whatever the case carries — `2026-09-10T12:00:00Z` from one
 * writer, `2026-09-10T14:00:00+04:00` from another — and those two sort the
 * wrong way round as text while naming moments two hours apart. Date.parse
 * collapses both to the instant they mean, which is the thing the list claims
 * to be ordered by.
 *
 * A publish_at that is not readable as an instant still HAS a date, so it sits
 * below every real one and above the undated, ordered by its own text: it
 * cannot be placed on a timeline, but it must land in the same place every
 * render. Undated posts go to the bottom rather than the top because they are
 * the ones with nothing to do TODAY, and the list is read from the top. Ties
 * break on identifier so the order is stable across refreshes — a list that
 * reshuffles itself under a cursor is a list you cannot click.
 *
 * Returns a new array: the caller is rendering from the one it passed in.
 */
export function sortForList<T extends Listable>(entries: ReadonlyArray<T>): T[] {
  return [...entries].sort((a, b) => {
    const ka = listRank(a?.publishAt);
    const kb = listRank(b?.publishAt);
    if (ka.band !== kb.band) return ka.band - kb.band;
    if (ka.band === 0 && ka.at !== kb.at) return ka.at - kb.at;
    if (ka.band === 1 && ka.raw !== kb.raw) return ka.raw < kb.raw ? -1 : 1;
    return (a?.identifier ?? "").localeCompare(b?.identifier ?? "");
  });
}

/**
 * A caption reduced to one bounded line for a card.
 *
 * Newlines become spaces because a card is one line: a caption whose second
 * character is a line break would otherwise render as an empty card.
 */
export function captionExcerpt(
  caption: string | null | undefined,
  max = 140,
): string {
  const flat = (caption ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

export interface CreateDraftInput {
  title: string;
  caption?: string | null;
  /** The Dubai calendar date the operator chose. Date only — no time. */
  date: string;
  /** Every entry the calendar knows about, so the slot is free against ALL. */
  entries: ReadonlyArray<Schedulable>;
}

export type CreateDraft =
  | {
      ok: true;
      title: string;
      caption: string | null;
      date: string;
      publishAt: string;
    }
  | { ok: false; error: string };

/**
 * What the inline Create form is asking to create, validated before anything
 * is sent.
 *
 * The form takes a DATE and no time, so the time is chosen here — the first
 * free half-hour slot on that Dubai day, from 09:00. The operator is scheduling
 * a day's post, not negotiating a minute, and a post that lands on top of
 * another one's slot is a publish-job collision nobody asked for.
 *
 * Refusals are returned, not thrown: they belong inline under the field that
 * caused them, next to the text still sitting in the form.
 */
export function buildCreateDraft(input: CreateDraftInput): CreateDraft {
  const title = (input.title ?? "").trim();
  if (!title) return { ok: false, error: "A title is required." };

  const date = (input.date ?? "").trim();
  if (!date) return { ok: false, error: "A publishing date is required." };
  if (!isDayKey(date)) {
    return { ok: false, error: `${date} is not a valid publishing date.` };
  }

  const publishAt = firstFreeSlot(
    date,
    (input.entries ?? []).map((e) => e?.publishAt ?? null),
  );
  if (!publishAt) {
    return {
      ok: false,
      error: `${date} is full — every half-hour slot on it already has a post.`,
    };
  }

  const caption = (input.caption ?? "").trim();
  return { ok: true, title, caption: caption || null, date, publishAt };
}
