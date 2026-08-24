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
import { cardMedia, chipThumbnail } from "../dist/ui/panel.js";

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

// --- video cards -----------------------------------------------------------
//
// The card model says WHAT to render, never how. A card that renders a video
// into an <img> shows a broken-image icon; one that renders an image into a
// <video> shows an empty black box. Both look like the post lost its media,
// so the decision is made here, on data the grid already has, and asserted.

test("a video post's card is a video, from the same content endpoint", () => {
  const media = cardMedia(entry({ mediaType: "video" }));
  assert.equal(media.kind, "video");
  assert.equal(media.src, `/api/assets/${ASSET}/content`);
});

test("an image post's card is unchanged by video support existing", () => {
  const media = cardMedia(entry({ mediaType: "image" }));
  assert.equal(media.kind, "image");
  assert.equal(media.src, `/api/assets/${ASSET}/content`);
  assert.deepEqual(media, { ...chipThumbnail(entry({ mediaType: "image" })) });
});

test("an entry from before media_type existed still renders as an image", () => {
  // A calendar bundle can outlive the worker that fed it. No mediaType key at
  // all is v0.3 data, and v0.3 data is an image.
  const media = cardMedia(entry());
  assert.equal(media.kind, "image");
});

test("a video card announces itself as a video to a screen reader", () => {
  assert.equal(
    cardMedia(entry({ mediaType: "video", altText: "A 20s product demo" })).alt,
    "A 20s product demo",
  );
  assert.equal(
    cardMedia(entry({ mediaType: "video" })).alt,
    "Video for Weekly signups chart",
  );
  assert.match(cardMedia(entry({ mediaType: "video", title: "" })).alt, /\S/);
});

test("media of a type this plugin will not render puts nothing on the card", () => {
  // `mediaType: null` is the projection saying "recorded, but not something we
  // render" — a webm attached through Paperclip's own UI, say. An empty card is
  // honest; a broken <img> is not.
  assert.equal(cardMedia(entry({ mediaType: null })), null);
  assert.equal(cardMedia(entry({ mediaType: null, altText: "x" })), null);
});

test("a video with no loadable reference is still nothing at all", () => {
  assert.equal(cardMedia(entry({ mediaType: "video", mediaFile: null })), null);
  assert.equal(
    cardMedia(entry({ mediaType: "video", mediaFile: "/var/media/clip.mp4" })),
    null,
  );
  assert.equal(cardMedia(null), null);
});
