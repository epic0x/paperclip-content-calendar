/**
 * The calendar's four operator-facing behaviours.
 *
 * Create in place, drag a post to another day, read a date without reading a
 * time, and switch the whole month for a list. Each one is a change to what
 * `CalendarView` renders and wires, and this project has no React renderer —
 * `usePluginData`/`usePluginAction` need the SDK's host providers and there is
 * no DOM. The rules underneath (slot selection, date replacement, drop
 * resolution, ordering) are pure and are tested for real in schedule.test.mjs;
 * what is asserted HERE is the wiring: that the component uses those rules
 * instead of reimplementing them, and that the surfaces it renders have the
 * properties the behaviour depends on.
 *
 * Written against strings that only exist if the behaviour is right, never
 * against formatting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("../src/ui/CalendarView.tsx", import.meta.url),
  "utf8",
);

function component(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const next = SOURCE.indexOf("\nfunction ", start + 1);
  return SOURCE.slice(start, next > 0 ? next : SOURCE.length);
}

/** The main CalendarView component. */
const view = () => component("CalendarView");

// ===========================================================================
// 1. Create, without leaving the calendar
// ===========================================================================

test("the calendar has a prominent Create button that opens an inline form", () => {
  const body = view();
  assert.match(body, /New post|Create post/i, "the button says what it makes");
  assert.match(body, /showCreate|creating|createOpen/, "it toggles an inline form");
  assert.match(body, /<CreatePostForm/, "and the form renders inside the calendar");
  // Not a route, not a modal on another page: the form is part of this view.
  assert.doesNotMatch(body, /window\.location|navigate\(/, "nothing leaves the page");
});

test("the form asks for a title, a caption and a DATE — never a time", () => {
  const form = component("CreatePostForm");
  assert.match(form, /type="date"/, "a date control, not datetime-local");
  assert.doesNotMatch(form, /datetime-local/, "the time is chosen for the operator");
  assert.doesNotMatch(form, /type="time"/);
  assert.match(form, /required/, "title and date are required in the markup too");
  assert.match(form, /Caption/i);
  assert.match(form, /optional/i, "the caption is marked optional");
});

test("the form refuses to submit without a title or a date, using the shared rule", () => {
  const form = component("CreatePostForm");
  assert.match(form, /buildCreateDraft\(/, "validation is the tested pure rule");
  assert.match(form, /draft\.ok/, "and its answer is what gates the submit");
});

test("submitting runs the create-post action and nothing that could publish", () => {
  const body = view();
  assert.match(body, /usePluginAction\("create-post"\)/);
  const create = body.slice(body.indexOf("const onCreate"));
  assert.match(create, /companyId/);
  assert.match(create, /title/);
  assert.match(create, /caption/);
  assert.match(create, /date/);
  // The action decides the instant; the browser must not name one.
  assert.doesNotMatch(create.slice(0, create.indexOf("catch")), /publishAt:/);
});

test("a created post refreshes the calendar, opens its month, and is selected", () => {
  const body = view();
  const create = body.slice(body.indexOf("const onCreate"), body.indexOf("const onReschedule"));
  assert.match(create, /setYear\(/, "navigate to the created month");
  assert.match(create, /setMonth\(/);
  assert.match(create, /dubaiYear\(|dubaiMonth\(/, "in Dubai, like every other date");
  assert.match(create, /refresh\(\)/, "the grid re-reads");
  assert.match(create, /setSelected\(/, "and the new post is the open one");
});

test("a failed create says so inline and keeps what was typed", () => {
  const body = view();
  const create = body.slice(body.indexOf("const onCreate"), body.indexOf("const onReschedule"));
  assert.match(create, /catch/, "a failure is caught, not thrown at the page");
  assert.match(create, /setCreateError\(|createError/, "and reported inline");
  const form = component("CreatePostForm");
  assert.match(form, /error/, "the form renders the failure next to the fields");
});

// ===========================================================================
// 2. Drag a post onto another day
// ===========================================================================

test("a grid card is draggable with native HTML drag events", () => {
  const chip = component("EntryChip");
  assert.match(chip, /draggable/);
  assert.match(chip, /onDragStart=/);
  // Native DnD, not a library: nothing else is installed and nothing else
  // should be.
  assert.doesNotMatch(SOURCE, /react-dnd|dnd-kit|Sortable/);
});

test("a card stays exactly one safe target — no controls nested in the button", () => {
  const chip = component("EntryChip");
  assert.equal(
    chip.split("<button").length - 1,
    1,
    "one button: a grid of small buttons is where a mis-click publishes something",
  );
  for (const nested of ["<a ", "<input", "<select", "<textarea"]) {
    assert.equal(
      chip.includes(nested),
      false,
      `${nested} inside the card would be a second target`,
    );
  }
});

test("every day cell of the month is a drop zone", () => {
  const body = view();
  const grid = body.slice(body.indexOf("grid.map("));
  assert.match(grid, /onDragOver=/, "a cell must accept the drag to receive a drop");
  assert.match(grid, /preventDefault\(\)/, "or the browser refuses the drop outright");
  assert.match(grid, /onDrop=/);
  assert.match(grid, /onDropOnDay\(|onDrop\(date/, "the cell knows which date it is");
});

test("a drop is resolved by the shared rule, never by string surgery on the date", () => {
  const body = view();
  assert.match(body, /resolveDrop\(/);
  const drop = body.slice(body.indexOf("const onDropOnDay"));
  assert.match(drop, /targetDate/);
  assert.match(drop, /entries/, "the free-slot search sees every entry, not one day");
  assert.doesNotMatch(
    drop,
    /\.slice\(0, 10\)|substring\(0, 10\)/,
    "a Dubai date is not the first ten characters of a UTC instant",
  );
});

test("a resolved drop goes through the existing reschedule action", () => {
  const body = view();
  const drop = body.slice(body.indexOf("const onDropOnDay"));
  assert.match(drop, /reschedule\(/, "one write path for moving a post");
  assert.match(drop, /previousPublishAt/, "which records what it moved from");
  assert.match(drop, /unchanged/, "a drop on the same day writes nothing");
});

test("a drag shows that it is working, and says so when it fails", () => {
  const body = view();
  const drop = body.slice(body.indexOf("const onDropOnDay"));
  assert.match(drop, /setBusy\(/, "busy feedback while the write is in flight");
  assert.match(drop, /catch/);
  assert.match(body, /dragError|setDragError/, "a refused or failed move is visible");
});

test("a drop only ever moves the card the transfer names", () => {
  // The regression: the drop read `id → entries, else the ref`, so a drop that
  // carried no id fell through to whatever card was dragged last and moved
  // THAT one. The decision is now the tested pure rule, and it runs before
  // resolveDrop — nothing without a card reaches the reschedule action.
  const body = view();
  const drop = body.slice(body.indexOf("const onDropOnDay"), body.indexOf("const onSetStatus"));
  assert.match(drop, /resolveDragSource\(/, "the source of the drop is decided by the rule");
  assert.ok(
    drop.indexOf("resolveDragSource(") < drop.indexOf("resolveDrop("),
    "and it gates resolveDrop rather than running after it",
  );
  assert.ok(
    drop.indexOf("resolveDragSource(") < drop.indexOf("reschedule("),
    "and gates the write",
  );
  assert.doesNotMatch(
    drop,
    /\?\?\s*dragging\.current/,
    "no silent fallback to the last card dragged",
  );
  assert.match(drop, /source\.ok|!source\.ok/, "a refused drop stops there");
});

test("the drop hands the pure rule what the browser actually gave it", () => {
  const body = view();
  const drop = body.slice(body.indexOf("const onDropOnDay"), body.indexOf("const onSetStatus"));
  assert.match(drop, /types/, "including the transfer's types, so Files can be refused");
  assert.match(drop, /files/i, "and its files");
  assert.match(drop, /getData\("text\/plain"\)/, "the id is still the authority");
  assert.match(drop, /dragging\.current/, "the ref is passed in as the fallback candidate");
});

test("the dragged card is cleared when the drag ends, cancelled or not", () => {
  const body = view();
  assert.match(body, /const onDragEndEntry/, "there is an explicit drag-end handler");
  const end = body.slice(body.indexOf("const onDragEndEntry"));
  assert.match(
    end.slice(0, end.indexOf("};")),
    /dragging\.current = null/,
    "which drops the reference — dragend fires on a cancelled drag too",
  );
});

test("every draggable surface reports its drag ending", () => {
  const chip = component("EntryChip");
  assert.match(chip, /onDragEnd=/, "the grid card");
  assert.match(chip, /onDragEnd:/, "and it takes the handler as a prop");

  const body = view();
  assert.match(body, /onDragEnd=\{onDragEndEntry\}|onDragEnd=\{\(\) => onDragEndEntry/,
    "the chips are wired to it");
  // Every `draggable` in the file sits on an element that also has onDragEnd.
  const draggables = SOURCE.split("draggable").length - 1;
  const ends = SOURCE.split("onDragEnd").length - 1;
  assert.ok(
    ends >= draggables,
    `${draggables} draggable surfaces, ${ends} onDragEnd mentions — every drag must be able to end`,
  );
});

test("the unscheduled tray drags through the same two handlers", () => {
  const body = view();
  const tray = body.slice(body.indexOf("with no\n            publish date"));
  assert.match(tray, /onDragStart=/);
  assert.match(tray, /onDragEnd=/, "a cancelled tray drag clears the ref too");
});

// ===========================================================================
// 3. No publishing time on the main views
// ===========================================================================

test("a month-grid card shows no publishing time", () => {
  const chip = component("EntryChip");
  assert.doesNotMatch(chip, /timeOf\(/, "the time is not on the card");
  assert.doesNotMatch(chip, /dubaiTime\(/);
});

test("a list card shows the publishing date and no publishing time", () => {
  const row = component("ListRow");
  assert.doesNotMatch(row, /timeOf\(/);
  assert.doesNotMatch(row, /dubaiTime\(/);
  assert.match(row, /dayLabel\(|dubaiDayKey\(/, "the date is what it shows");
});

test("the detail editor keeps its technical time control", () => {
  // Removing the time from the CARDS is a display decision. The panel is where
  // the actual instant is set, and it still has to be settable to the minute
  // the publish job runs on.
  const panel = component("DetailPanel");
  assert.match(panel, /datetime-local/);
  assert.match(panel, /step=\{1800\}/);
});

// ===========================================================================
// 4. Calendar / List toggle
// ===========================================================================

test("there is a segmented Calendar/List toggle", () => {
  const body = view();
  assert.match(body, /<ViewToggle|ViewToggle\b/);
  assert.match(body, /useState<"calendar" \| "list">|useState<ViewMode>/);
  const toggle = component("ViewToggle");
  assert.match(toggle, /Calendar/);
  assert.match(toggle, /List/);
  assert.match(toggle, /aria-pressed=|role="tab"/, "the active segment is announced");
});

test("list mode replaces the entire month grid", () => {
  const body = view();
  // Not a panel beside the grid, not a section under it: one or the other.
  assert.match(
    body,
    /view === "calendar" \? \(|view === "list" \? \(/,
    "the grid and the list are branches of the same slot",
  );
  assert.match(body, /<ListView/);
});

test("the list reads the WHOLE calendar, not the month the grid was showing", () => {
  const body = view();
  const call = body.slice(body.indexOf('usePluginData<CalendarData>'));
  const params = call.slice(0, call.indexOf(");"));
  assert.match(params, /calendarQuery\(/, "the query is shaped by the tested rule");
  assert.match(params, /view/, "and it depends on which surface is showing");
  // The 42-day window must not be hard-wired into the call any more.
  assert.doesNotMatch(
    params,
    /\{\s*companyId,\s*from,\s*to\s*\}/,
    "from/to are no longer sent unconditionally",
  );
});

test("full list mode does not show month navigation it does not obey", () => {
  const body = view();
  assert.match(
    body,
    /view === "calendar" && \(/,
    "the month arrows and label are calendar-only",
  );
  assert.match(body, /All publishing dates/, "the list says what it is showing instead");
  assert.match(
    body,
    /view === "list" &&/,
    "and that label only appears in list mode",
  );
});

test("the list label carries the total number of posts in it", () => {
  const body = view();
  const label = body.slice(body.indexOf("All publishing dates") - 400);
  assert.match(
    label.slice(0, 600),
    /listEntries\.length/,
    "how many posts the list is showing, counted from what it renders",
  );
});

test("the list is ordered by the shared rule: ascending, undated last", () => {
  const list = component("ListView");
  assert.match(list, /sortForList\(/);
  assert.doesNotMatch(list, /\.sort\(\(/, "no second ordering rule to drift from the first");
});

test("the list is one relaxed card per row, flexible down to 320px", () => {
  const list = component("ListView");
  // One column, always. A fixed multi-column track is what breaks at 320px.
  assert.doesNotMatch(
    list,
    /repeat\(\s*\d|gridTemplateColumns: "repeat\(auto/,
    "no fixed multi-column track",
  );
  assert.doesNotMatch(list, /minWidth: \d{3}/, "nothing forces a width a phone cannot give");

  const row = component("ListRow");
  assert.match(row, /flexWrap: "wrap"/, "the row reflows rather than overflowing");
  assert.match(row, /width: "100%"|flex: 1/, "and fills whatever width it is given");
  assert.doesNotMatch(row, /width: \d{3}/, "no fixed card width");
});

test("a list card carries date, status, title, caption and channel", () => {
  const row = component("ListRow");
  assert.match(row, /<StatusPill/);
  assert.match(row, /entry\.title/);
  assert.match(row, /captionExcerpt\(/, "an excerpt, flattened and bounded");
  assert.match(row, /entry\.channel &&/, "the channel is optional");
  assert.match(row, /dayLabel\(|dubaiDayKey\(/);
});

test("clicking a list card selects it, and the card is a single target", () => {
  const row = component("ListRow");
  assert.match(row, /onSelect\(entry\)/);
  assert.equal(row.split("<button").length - 1, 1, "one button per card");
  for (const nested of ["<a ", "<input", "<select", "<textarea"]) {
    assert.equal(row.includes(nested), false, `${nested} would be a second target`);
  }
});

test("the list covers unscheduled posts too, which is where they get a date", () => {
  const body = view();
  assert.match(body, /unscheduled/, "the undated posts reach the list");
  const list = component("ListView");
  assert.match(list, /entries/);
});

// ===========================================================================
// The rules come from the tested module, not from copies
// ===========================================================================

test("the view imports its rules from the pure module", () => {
  const imports = SOURCE.slice(0, SOURCE.indexOf("// ---"));
  assert.match(imports, /from "\.\.\/schedule\.js"/);
  for (const fn of [
    "buildCreateDraft",
    "captionExcerpt",
    "resolveDrop",
    "sortForList",
  ]) {
    assert.match(imports, new RegExp(`\\b${fn}\\b`), `${fn} is imported, not rewritten`);
  }
});
