/**
 * What a calendar card shows for its image.
 *
 * The month grid already receives `mediaFile` on every entry — the `calendar`
 * data handler projects it — but the chip ignored it, so a post with a native
 * asset attached looked identical to one with no image at all. The only place
 * the image was visible was the detail panel, which costs a case-detail read
 * per selection.
 *
 * The rule is pure and lives outside the component so it can be asserted here:
 * the thumbnail's src is derived from the entry the grid ALREADY has, so
 * rendering it adds no API call beyond fetching the bytes themselves.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chipThumbnail } from "../dist/ui/panel.js";

const ASSET = "0b6c3f2a-9d41-4c7e-8b52-1f6a8e0d4c33";

const entry = (over = {}) => ({
  id: "case-1",
  identifier: "PAP-C1",
  title: "Weekly signups chart",
  mediaFile: `asset:${ASSET}`,
  altText: null,
  ...over,
});

test("a card whose media_file is a native asset gets a thumbnail from the content endpoint", () => {
  const thumb = chipThumbnail(entry());
  assert.equal(thumb.src, `/api/assets/${ASSET}/content`);
});

test("the case's alt text is what the card's image announces", () => {
  const thumb = chipThumbnail(entry({ altText: "A chart of weekly signups" }));
  assert.equal(thumb.alt, "A chart of weekly signups");
});

test("with no alt text the card still names the image, and never announces an empty one", () => {
  assert.equal(chipThumbnail(entry()).alt, "Image for Weekly signups chart");
  // Whitespace is not alt text.
  assert.equal(chipThumbnail(entry({ altText: "   " })).alt, "Image for Weekly signups chart");
  assert.match(chipThumbnail(entry({ title: "" })).alt, /\S/);
});

test("nothing is rendered for a post with no image", () => {
  assert.equal(chipThumbnail(entry({ mediaFile: null })), null);
  assert.equal(chipThumbnail(entry({ mediaFile: "" })), null);
  assert.equal(chipThumbnail(null), null);
  assert.equal(chipThumbnail({}), null);
});

test("a legacy media_file renders no image rather than a broken one", () => {
  // Both still publish — the adapter treats them as host paths — but neither is
  // something this browser can load, and a broken-image icon on the card would
  // claim the post's image is missing when it is not.
  assert.equal(chipThumbnail(entry({ mediaFile: "signups.png" })), null);
  assert.equal(chipThumbnail(entry({ mediaFile: "/var/paperclip/media/signups.png" })), null);
  assert.equal(chipThumbnail(entry({ mediaFile: `asset:${ASSET}/../secret` })), null);
});

test("the content path form of media_file resolves to the same thumbnail", () => {
  // A case edited by hand or by an agent may carry the path the API hands back.
  const thumb = chipThumbnail(entry({ mediaFile: `/api/assets/${ASSET}/content` }));
  assert.equal(thumb.src, `/api/assets/${ASSET}/content`);
});
