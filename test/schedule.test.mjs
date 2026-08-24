/**
 * The calendar's pure scheduling rules.
 *
 * Everything here decides an INSTANT from a Dubai calendar date, or a Dubai
 * calendar date from an instant, and every one of those conversions has already
 * been wrong once in this plugin: a post dropped on the 15th that landed on the
 * 14th, a midnight post filed under the previous day, a "first free slot" that
 * handed out a time another post already held.
 *
 * `publish_at` is a UTC instant in storage and a Dubai wall clock on screen.
 * Dubai is permanently UTC+4 with no daylight saving, so the two differ by
 * exactly four hours — which is enough to cross a date boundary twice a day.
 * These are pure functions with no DOM and no React, so the boundary is
 * asserted directly rather than inferred from a rendered grid.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY_START,
  buildCreateDraft,
  calendarQuery,
  captionExcerpt,
  firstFreeSlot,
  isDayKey,
  replaceDubaiDate,
  resolveDragSource,
  resolveDrop,
  slotOrder,
  sortForList,
} from "../dist/schedule.js";

// 09:00 Dubai is 05:00Z. Every expectation below is written as the UTC instant
// that actually gets stored, so a helper that "looks right" in local time but
// stores the wrong instant cannot pass.
const AT = (day, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const utc = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
    h - 4,
    m,
  );
  return new Date(utc).toISOString();
};

// --- the slot ladder -------------------------------------------------------

test("the day's slots start at 09:00 Dubai and step every half hour", () => {
  const slots = slotOrder();
  assert.equal(DAY_START, "09:00");
  assert.equal(slots[0], "09:00");
  assert.equal(slots[1], "09:30");
  assert.equal(slots[2], "10:00");
  // Every slot is a real :00 or :30, and none repeats.
  assert.equal(new Set(slots).size, slots.length);
  for (const s of slots) assert.match(s, /^([01]\d|2[0-3]):(00|30)$/);
});

test("the ladder covers the whole day, working hours first", () => {
  const slots = slotOrder();
  assert.equal(slots.length, 48, "every half hour of the day is reachable");
  assert.equal(slots[29], "23:30", "the working ladder ends at 23:30");
  assert.equal(slots[30], "00:00", "then, and only then, it wraps to the small hours");
  assert.equal(slots[47], "08:30");
});

// --- first free slot -------------------------------------------------------

test("an empty day gets 09:00 Dubai, stored as 05:00Z", () => {
  assert.equal(firstFreeSlot("2026-09-10", []), AT("2026-09-10", "09:00"));
  assert.equal(firstFreeSlot("2026-09-10", []), "2026-09-10T05:00:00.000Z");
});

test("a taken slot is skipped, in order", () => {
  const taken = [AT("2026-09-10", "09:00")];
  assert.equal(firstFreeSlot("2026-09-10", taken), AT("2026-09-10", "09:30"));

  taken.push(AT("2026-09-10", "09:30"), AT("2026-09-10", "10:00"));
  assert.equal(firstFreeSlot("2026-09-10", taken), AT("2026-09-10", "10:30"));
});

test("only the target Dubai day counts — the neighbours are not this day", () => {
  // 2026-09-10T20:00Z is 00:00 Dubai on the 11th, NOT 20:00 on the 10th. Read
  // as UTC it would wrongly occupy a slot on the 10th.
  const taken = [
    AT("2026-09-09", "09:00"),
    AT("2026-09-11", "09:00"),
    "2026-09-10T20:00:00.000Z",
  ];
  assert.equal(firstFreeSlot("2026-09-10", taken), AT("2026-09-10", "09:00"));
});

test("a post at 00:00 Dubai holds the small-hours slot of ITS Dubai day", () => {
  // Same instant as above; on the 11th it is 00:00 and must be seen as taken.
  const taken = ["2026-09-10T20:00:00.000Z"];
  const free = firstFreeSlot("2026-09-11", taken);
  assert.equal(free, AT("2026-09-11", "09:00"), "09:00 is still free that day");

  const full = slotOrder()
    .filter((s) => s !== "00:00")
    .map((s) => AT("2026-09-11", s));
  assert.equal(
    firstFreeSlot("2026-09-11", [...full]),
    "2026-09-10T20:00:00.000Z",
    "00:00 Dubai on the 11th is the last slot left, and it is an instant on the 10th",
  );
  assert.equal(firstFreeSlot("2026-09-11", [...full, ...taken]), null);
});

test("a day with no free slot answers null rather than double-booking", () => {
  const full = slotOrder().map((s) => AT("2026-09-10", s));
  assert.equal(firstFreeSlot("2026-09-10", full), null);
});

test("junk in the taken list cannot block a real slot", () => {
  const taken = [null, undefined, "", "not-a-date", AT("2026-09-10", "09:00")];
  assert.equal(firstFreeSlot("2026-09-10", taken), AT("2026-09-10", "09:30"));
});

test("an invalid target day has no slots at all", () => {
  assert.equal(firstFreeSlot("2026-02-30", []), null);
  assert.equal(firstFreeSlot("nonsense", []), null);
  assert.equal(firstFreeSlot("", []), null);
});

// --- moving a date without moving the time ---------------------------------

test("changing the date keeps the Dubai wall-clock time", () => {
  // 18:30Z is 22:30 Dubai on the 10th.
  const moved = replaceDubaiDate("2026-09-10T18:30:00.000Z", "2026-09-11");
  assert.equal(moved, AT("2026-09-11", "22:30"));
  assert.equal(moved, "2026-09-11T18:30:00.000Z");
});

test("a post whose Dubai day is already the next UTC day moves by Dubai days", () => {
  // 2026-09-10T20:00Z is 00:00 Dubai on 2026-09-11. Dropping it on the 15th
  // means 00:00 Dubai on the 15th, which is 2026-09-14T20:00Z — an instant on
  // the 14th. Anything that slices the ISO string moves this a day too far.
  const moved = replaceDubaiDate("2026-09-10T20:00:00.000Z", "2026-09-15");
  assert.equal(moved, "2026-09-14T20:00:00.000Z");
  assert.equal(moved, AT("2026-09-15", "00:00"));
});

test("an invalid instant or day is refused, never silently coerced", () => {
  assert.throws(() => replaceDubaiDate("not-an-instant", "2026-09-11"));
  assert.throws(() => replaceDubaiDate("2026-09-10T18:30:00.000Z", "2026-02-30"));
  assert.throws(() => replaceDubaiDate("2026-09-10T18:30:00.000Z", "nope"));
});

// --- dropping a card on a day ----------------------------------------------

const entries = () => [
  { id: "a", publishAt: AT("2026-09-11", "09:00") },
  { id: "b", publishAt: AT("2026-09-11", "09:30") },
  { id: "c", publishAt: null },
];

test("dropping a scheduled card changes only its Dubai date", () => {
  const entry = { id: "z", publishAt: "2026-09-10T18:30:00.000Z" };
  const res = resolveDrop({ entry, targetDate: "2026-09-11", entries: entries() });
  assert.equal(res.ok, true);
  assert.equal(res.publishAt, "2026-09-11T18:30:00.000Z");
  assert.equal(res.previousPublishAt, "2026-09-10T18:30:00.000Z");
  assert.equal(res.unchanged, false);
});

test("a preserved time may collide — the operator asked for this date, not a new time", () => {
  // 09:00 on the 11th is already held by entry `a`. Preserving the dragged
  // card's own time is the documented behaviour; reassigning it would move a
  // post to a time nobody chose.
  const entry = { id: "z", publishAt: AT("2026-09-10", "09:00") };
  const res = resolveDrop({ entry, targetDate: "2026-09-11", entries: entries() });
  assert.equal(res.ok, true);
  assert.equal(res.publishAt, AT("2026-09-11", "09:00"));
});

test("dropping an unscheduled card takes the first free slot on that day", () => {
  const entry = { id: "c", publishAt: null };
  const res = resolveDrop({ entry, targetDate: "2026-09-11", entries: entries() });
  assert.equal(res.ok, true);
  assert.equal(res.publishAt, AT("2026-09-11", "10:00"), "09:00 and 09:30 are taken");
  assert.equal(res.previousPublishAt, null);
});

test("dropping a card back on the day it already sits on changes nothing", () => {
  const entry = { id: "a", publishAt: AT("2026-09-11", "09:00") };
  const res = resolveDrop({ entry, targetDate: "2026-09-11", entries: entries() });
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, true, "no write, no reschedule round trip");
  assert.equal(res.publishAt, entry.publishAt);
});

test("an invalid drop target is refused with a reason, not a thrown page", () => {
  const entry = { id: "z", publishAt: AT("2026-09-10", "09:00") };
  for (const targetDate of ["2026-02-30", "nonsense", "", null, undefined]) {
    const res = resolveDrop({ entry, targetDate, entries: entries() });
    assert.equal(res.ok, false, `${targetDate} is not a day`);
    assert.match(res.reason, /\S/);
  }
});

test("dropping nothing, or onto a full day, is refused with a reason", () => {
  assert.equal(
    resolveDrop({ entry: null, targetDate: "2026-09-11", entries: [] }).ok,
    false,
  );
  const full = slotOrder().map((s) => ({ id: s, publishAt: AT("2026-09-11", s) }));
  const res = resolveDrop({
    entry: { id: "c", publishAt: null },
    targetDate: "2026-09-11",
    entries: full,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /full|free slot/i);
});

// --- which posts the view asks the worker for -------------------------------
//
// The month grid can only draw the 42 days it shows, so it asks for exactly
// those. The LIST is "the whole calendar in list form" — it must not be the
// same 42-day window with the month navigation hidden, which is what made it
// silently a month view wearing a list's clothes.

test("the month grid asks for the window it can actually draw", () => {
  const q = calendarQuery({
    companyId: "co-1",
    view: "calendar",
    from: "2026-08-31",
    to: "2026-10-11",
  });
  assert.deepEqual(q, { companyId: "co-1", from: "2026-08-31", to: "2026-10-11" });
});

test("the list asks for EVERY post — no from, no to", () => {
  const q = calendarQuery({
    companyId: "co-1",
    view: "list",
    from: "2026-08-31",
    to: "2026-10-11",
  });
  assert.deepEqual(Object.keys(q).sort(), ["companyId"]);
  assert.equal("from" in q, false, "a bounded list is not the whole calendar");
  assert.equal("to" in q, false);
  assert.equal(q.companyId, "co-1");
});

test("with no company there is nothing to ask for, in either view", () => {
  for (const view of ["calendar", "list"]) {
    assert.equal(
      calendarQuery({ companyId: null, view, from: "2026-08-31", to: "2026-10-11" }),
      undefined,
      "usePluginData is skipped rather than called for no company",
    );
  }
});

// --- what was actually dropped ---------------------------------------------
//
// The bug this rule exists for: the view kept the dragged card in a ref, and a
// drop read `transfer id → entries, else the ref`. A drop that carried NO id —
// a file dragged in from the desktop, a selection dragged out of a text field,
// a drag the browser cancelled and never cleared — therefore fell through to
// whatever card was dragged LAST, and rescheduled that one. The operator moved
// nothing and a post changed its date.

const CARDS = [
  { id: "case-1", identifier: "PAP-1", publishAt: "2026-09-10T05:00:00Z" },
  { id: "case-2", identifier: "PAP-2", publishAt: null },
];

test("a drop with no transfer id is refused, and never reaches the stale ref", () => {
  for (const empty of ["", "   ", null, undefined, 0]) {
    const res = resolveDragSource({
      types: ["text/plain"],
      transferId: empty,
      held: CARDS[0], // the last card dragged — must NOT be picked up
      entries: CARDS,
    });
    assert.equal(res.ok, false, `${JSON.stringify(empty)} is not a card`);
    assert.match(res.reason, /calendar|card|post/i, "and it says so");
  }
});

test("a file dragged in from the desktop is refused before anything else", () => {
  const byType = resolveDragSource({
    types: ["Files"],
    transferId: "case-1", // even WITH a plausible id on the transfer
    held: CARDS[0],
    entries: CARDS,
  });
  assert.equal(byType.ok, false);
  assert.match(byType.reason, /file/i, "the operator is told what went wrong");

  const byCount = resolveDragSource({
    types: [],
    fileCount: 1,
    transferId: "case-1",
    held: CARDS[0],
    entries: CARDS,
  });
  assert.equal(byCount.ok, false, "a transfer carrying files is a file drop");
});

test("a real card drag resolves to the entry the transfer names", () => {
  const res = resolveDragSource({
    types: ["text/plain"],
    transferId: "case-2",
    held: CARDS[0], // the ref disagrees; the transfer is the authority
    entries: CARDS,
  });
  assert.equal(res.ok, true);
  assert.equal(res.entry.id, "case-2");
});

test("the ref is a fallback for the SAME card, never for a different one", () => {
  // The card is not in `entries` — it scrolled out of the loaded window — but
  // the transfer names it and the ref is holding exactly it.
  const held = { id: "case-9", identifier: "PAP-9", publishAt: null };
  const found = resolveDragSource({
    types: ["text/plain"],
    transferId: "case-9",
    held,
    entries: CARDS,
  });
  assert.equal(found.ok, true);
  assert.equal(found.entry, held);

  const stale = resolveDragSource({
    types: ["text/plain"],
    transferId: "case-9",
    held: CARDS[0], // a leftover from an earlier drag
    entries: CARDS,
  });
  assert.equal(stale.ok, false, "a ref that is not this card is not this card");
});

test("a transfer with no types at all is still read for its id", () => {
  // `types` is empty in some browsers on drop. Absent types is not evidence of
  // a file drop; only Files or actual files are.
  const res = resolveDragSource({
    types: undefined,
    transferId: "case-1",
    held: null,
    entries: CARDS,
  });
  assert.equal(res.ok, true);
  assert.equal(res.entry.id, "case-1");
});

// --- the list ordering -----------------------------------------------------

test("the list runs ascending by publishing date, with the undated last", () => {
  const rows = [
    { id: "late", publishAt: AT("2026-09-12", "09:00") },
    { id: "none", publishAt: null },
    { id: "early", publishAt: AT("2026-09-10", "18:00") },
    { id: "mid", publishAt: AT("2026-09-11", "09:00") },
    { id: "none2", publishAt: undefined },
  ];
  assert.deepEqual(
    sortForList(rows).map((r) => r.id),
    ["early", "mid", "late", "none", "none2"],
  );
});

test("the order is chronological, not alphabetical — offsets and Z compare as instants", () => {
  // The same two moments, written the two ways a case can carry them. As
  // strings, "…T12:00:00Z" sorts before "…T14:00:00+04:00"; as instants the
  // +04:00 one is 10:00Z and happens FIRST. A list that reads a UTC string and
  // a Dubai-offset string as text puts them in the wrong order.
  const rows = [
    { id: "noon-utc", identifier: "PAP-2", publishAt: "2026-09-10T12:00:00Z" },
    { id: "ten-utc", identifier: "PAP-1", publishAt: "2026-09-10T14:00:00+04:00" },
  ];
  assert.deepEqual(sortForList(rows).map((r) => r.id), ["ten-utc", "noon-utc"]);
});

test("the same instant written two ways is a tie, broken on identifier", () => {
  const rows = [
    { id: "b", identifier: "PAP-9", publishAt: "2026-09-10T09:00:00Z" },
    { id: "a", identifier: "PAP-3", publishAt: "2026-09-10T13:00:00+04:00" },
  ];
  assert.deepEqual(sortForList(rows).map((r) => r.id), ["a", "b"]);
});

test("milliseconds and trailing whitespace do not reorder anything", () => {
  const rows = [
    { id: "later", identifier: "PAP-1", publishAt: "  2026-09-10T09:00:00.500Z  " },
    { id: "earlier", identifier: "PAP-2", publishAt: "2026-09-10T09:00:00.250Z" },
  ];
  assert.deepEqual(sortForList(rows).map((r) => r.id), ["earlier", "later"]);
});

test("an unreadable publish date sorts deterministically, after every real one", () => {
  // It still HAS a date, so it stays above the undated — but it cannot be
  // placed among instants, so it falls back to comparing the raw values and
  // then the identifier. The only thing that matters is that it is stable.
  const rows = [
    { id: "undated", identifier: "PAP-4", publishAt: null },
    { id: "broken-b", identifier: "PAP-3", publishAt: "not-a-date-b" },
    { id: "broken-a", identifier: "PAP-2", publishAt: "not-a-date-a" },
    { id: "real", identifier: "PAP-1", publishAt: AT("2026-09-12", "09:00") },
  ];
  const order = sortForList(rows).map((r) => r.id);
  assert.deepEqual(order, ["real", "broken-a", "broken-b", "undated"]);
  // Same answer from a different starting order: the rule is total, not luck.
  assert.deepEqual(sortForList([...rows].reverse()).map((r) => r.id), order);
});

test("sorting does not mutate the array the calendar is rendering from", () => {
  const rows = [
    { id: "b", publishAt: AT("2026-09-12", "09:00") },
    { id: "a", publishAt: AT("2026-09-10", "09:00") },
  ];
  sortForList(rows);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
});

// --- small text rules ------------------------------------------------------

test("a caption excerpt is trimmed, single-line and bounded", () => {
  assert.equal(captionExcerpt("  hello  "), "hello");
  assert.equal(captionExcerpt("one\ntwo"), "one two");
  assert.equal(captionExcerpt(null), "");
  assert.equal(captionExcerpt(undefined), "");
  const long = "x".repeat(400);
  const cut = captionExcerpt(long, 100);
  assert.ok(cut.length <= 101, "bounded, plus at most the ellipsis");
  assert.match(cut, /…$/);
});

test("isDayKey accepts a real Dubai date and nothing else", () => {
  assert.equal(isDayKey("2026-09-10"), true);
  assert.equal(isDayKey("2026-02-30"), false);
  assert.equal(isDayKey("2026-9-10"), false);
  assert.equal(isDayKey("2026-09-10T09:00"), false);
  assert.equal(isDayKey(null), false);
});

// --- what Create in the calendar is allowed to build -----------------------

test("a create draft needs a title and a date, and says which is missing", () => {
  const base = { title: "Launch post", date: "2026-09-11", entries: [] };

  const noTitle = buildCreateDraft({ ...base, title: "   " });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.error, /title/i);

  const noDate = buildCreateDraft({ ...base, date: "" });
  assert.equal(noDate.ok, false);
  assert.match(noDate.error, /date/i);

  const badDate = buildCreateDraft({ ...base, date: "2026-02-30" });
  assert.equal(badDate.ok, false);
  assert.match(badDate.error, /date/i);
});

test("a create draft picks the first free slot on the chosen Dubai date", () => {
  const draft = buildCreateDraft({
    title: "  Launch post  ",
    caption: "  hello  ",
    date: "2026-09-11",
    entries: entries(),
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.title, "Launch post");
  assert.equal(draft.caption, "hello");
  assert.equal(draft.date, "2026-09-11");
  assert.equal(draft.publishAt, AT("2026-09-11", "10:00"));
});

test("an empty caption is null, because the case field means absent", () => {
  const draft = buildCreateDraft({ title: "T", caption: "  ", date: "2026-09-11", entries: [] });
  assert.equal(draft.ok, true);
  assert.equal(draft.caption, null);
  assert.equal(buildCreateDraft({ title: "T", date: "2026-09-11", entries: [] }).caption, null);
});

test("a full day cannot be created into", () => {
  const full = slotOrder().map((s) => ({ publishAt: AT("2026-09-11", s) }));
  const draft = buildCreateDraft({ title: "T", date: "2026-09-11", entries: full });
  assert.equal(draft.ok, false);
  assert.match(draft.error, /full|free slot/i);
});
