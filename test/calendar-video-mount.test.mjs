/**
 * ONE video element, in the one place a video is meant to play.
 *
 * A month of posts is ~30 cards, and the list view is every post the company
 * has. Every `<video>` mounted is a media element the browser allocates, a
 * decoder it may attach, and — even at `preload="metadata"` — a range request
 * per card the moment the month renders. Thirty of those to open a calendar is
 * a cost paid by everyone, every render, so that a handful of 18-pixel squares
 * can show a frame nobody can see anyway.
 *
 * So the compact card and the list row render a STATIC play tile — markup and
 * a glyph, no media element, no network — and the only `<video>` in the file is
 * the one in the selected post's panel, which is where an operator actually
 * checks what is about to go out.
 *
 * There is no React renderer in this project, so this is asserted against the
 * source. That is a blunt instrument, and it is used bluntly on purpose: the
 * property is "how many video elements exist in this file", which is exactly
 * the kind of thing a source count answers well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("../src/ui/CalendarView.tsx", import.meta.url),
  "utf8",
);

/** One component, from its declaration to the next top-level one. */
function component(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  const next = SOURCE.indexOf("\nfunction ", start + 1);
  return SOURCE.slice(start, next > 0 ? next : SOURCE.length);
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

test("the whole calendar file mounts exactly one video element", () => {
  assert.equal(
    occurrences(SOURCE, "<video"),
    1,
    "one <video> in the file, and it is the selected post's preview",
  );
});

test("the one video element is the selected post's panel preview", () => {
  const panel = component("MediaSection");
  assert.equal(occurrences(panel, "<video"), 1);
  // i.e. every other <video> in the file is inside this component — there are
  // none elsewhere, which the count above already fixed.
});

test("a compact month-grid card never mounts a video", () => {
  const chip = component("EntryChip");
  assert.doesNotMatch(chip, /<video/, "no media element on a grid card");
  assert.doesNotMatch(
    chip,
    /preload=/,
    "nothing on a grid card asks the network for video bytes",
  );
});

test("a list row never mounts a video", () => {
  const row = component("ListRow");
  assert.doesNotMatch(row, /<video/);
  assert.doesNotMatch(row, /preload=/);
});

test("both card surfaces render media through the same static tile", () => {
  // One helper, so a video card cannot regress into a media element in one
  // place while staying static in the other.
  const tile = component("MediaTile");
  assert.doesNotMatch(tile, /<video/, "the tile is markup, not a player");
  assert.match(tile, /<img/, "an image is still a real image");
  assert.match(tile, /loading="lazy"/, "image thumbnails stay lazy");
  assert.match(
    tile,
    /kind === "video"/,
    "the tile branches on the kind the card model decided",
  );

  for (const name of ["EntryChip", "ListRow"]) {
    assert.match(component(name), /<MediaTile/, `${name} renders through the tile`);
  }
});

test("the static video tile says it is a video without playing one", () => {
  const tile = component("MediaTile");
  // A play glyph and an accessible name. A silent grey square would read as
  // media that failed to load.
  assert.match(tile, /aria-label=|role="img"/, "it announces itself");
  assert.match(tile, /▶|&#9654;|play/i, "it looks like a video");
});

test("image thumbnails are lazy everywhere they appear on a card", () => {
  // Every <img> outside the detail panel's own preview loads lazily.
  const tile = component("MediaTile");
  const imgs = tile.split("<img").length - 1;
  assert.equal(imgs, 1, "one image element in the tile");
  assert.match(tile, /decoding="async"/, "and it decodes off the main thread");
});
