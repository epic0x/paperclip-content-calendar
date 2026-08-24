/**
 * The open panel renders WHAT `selectedMedia` decided.
 *
 * `MediaSection` already computes `selectedMedia(detail)` — the rule that reads
 * the ATTACHMENT's own content type and answers image, video, or nothing — and
 * then threw the answer away: the preview was a hardcoded <img>. So a case with
 * an mp4 attached previewed as a broken image icon, which reads as "your media
 * is gone" about a post whose media is fine, and the panel's copy went on
 * calling every attachment an "image".
 *
 * The component itself is JSX with React hooks and the plugin SDK's providers,
 * neither of which this suite has a renderer for. The regression is therefore
 * asserted against the SOURCE: that the computed `preview` is what reaches the
 * DOM, which element each kind gets, that a video's playback attributes are the
 * panel's (real controls, never autoplay), and that the operator-facing copy
 * and the accept hint stopped hardcoding "image".
 *
 * A source test is a blunt instrument, so it is written against strings that
 * only exist if the behaviour is right, not against formatting.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
  new URL("../src/ui/CalendarView.tsx", import.meta.url),
  "utf8",
);

/** The MediaSection component, from its declaration to the next one. */
function mediaSection() {
  const start = SOURCE.indexOf("function MediaSection(");
  assert.ok(start > 0, "MediaSection still exists");
  const after = SOURCE.indexOf("\nfunction ", start + 1);
  return SOURCE.slice(start, after > 0 ? after : SOURCE.length);
}

/** The preview branch: from the broken-media check to the end of the frame. */
function previewBlock() {
  const section = mediaSection();
  const start = section.indexOf("brokenAsset === attachment.assetId");
  assert.ok(start > 0, "the broken-media branch still exists");
  return section.slice(start, section.indexOf("originalFilename ?? \"attachment\""));
}

test("the preview the panel computed is the preview the panel renders", () => {
  const block = previewBlock();
  // The whole bug: `preview` was computed and then ignored.
  assert.match(block, /preview\.kind/, "the element is chosen by preview.kind");
  assert.match(block, /src=\{preview\.src\}/, "the source comes from preview");
  assert.doesNotMatch(
    block,
    /src=\{attachment\.contentPath\}/,
    "the raw attachment path is no longer wired straight into an element",
  );
});

test("a video attachment is previewed as a video, an image as an image", () => {
  const block = previewBlock();
  assert.match(block, /preview\.kind === "video" \?/);
  const video = block.indexOf("<video");
  const img = block.indexOf("<img");
  assert.ok(video > 0, "a video element exists");
  assert.ok(img > 0, "an image element exists");
  assert.ok(video < img, "the video is the video branch, the img the fallback");
});

test("the panel's video has real controls, no autoplay, and loads only its header", () => {
  const block = previewBlock();
  const video = block.slice(block.indexOf("<video"), block.indexOf("<img"));
  assert.match(video, /\bcontrols\b/, "this is where a post is checked before it goes out");
  assert.match(video, /playsInline/, "iOS must not take the video fullscreen");
  assert.match(video, /preload=\{?"?metadata/, "a preview is not a download");
  assert.doesNotMatch(
    video,
    /autoPlay(?!=\{false\})/,
    "opening a post is not a request to play it",
  );
});

test("media of a type the panel cannot render previews nothing, not a broken element", () => {
  const block = previewBlock();
  // `selectedMedia` returns null for a type this plugin does not render; the
  // panel has to have a third branch for it or it renders an empty <img>.
  assert.match(
    block,
    /preview \?|preview !== null|preview \?\?/,
    "there is an explicit no-preview branch",
  );
});

test("the panel's copy calls it media, because it is not always an image", () => {
  const section = mediaSection();
  assert.match(section, />Media</, "the section label");
  assert.match(section, /aria-label=\{attachment \? "Replace media" : "Attach media"\}/);
  assert.match(section, /No media attached to this post\./);
  assert.match(section, /This post has no media set/);
  // Nothing operator-facing in this section may still say "image" flatly.
  assert.doesNotMatch(section, /No image attached to this post/);
  assert.doesNotMatch(section, /"Replace image"|"Attach image"/);
});

test("the accept hint lists the types the picker actually accepts", () => {
  const section = mediaSection();
  // The picker's `accept` is built from `allowedTypes`, which falls back
  // through allowedMediaTypes → allowedImageTypes. The hint under it used
  // `data?.allowedImageTypes` directly, so a worker offering video advertised
  // images only — and against an older worker it printed an empty list.
  assert.match(section, /\{allowedTypes\.join\(", "\)\}/);
  assert.doesNotMatch(
    section,
    /\(data\?\.allowedImageTypes \?\? \[\]\)\.join/,
    "the hint no longer reads a field the picker does not use",
  );
});
