/**
 * `set-media` refuses media this plugin cannot publish.
 *
 * Paperclip's case attachment route checks no content type at all, and its own
 * allowlist is wider than ours: a `video/webm` uploaded through Paperclip's UI
 * is a perfectly real attachment on the case. `set-media` verified only that
 * the asset WAS attached and then wrote its content type into `media_type`
 * verbatim. The result was a case whose media_type is a value nothing renders
 * and nothing publishes:
 *
 *   - `cardMedia` reads media_type null → the month card shows nothing,
 *   - `selectedMedia` → the panel previews nothing,
 *   - the X publisher rejects `.webm` at publish time,
 *
 * i.e. a post that looks attached right up until the moment it is due. The
 * refusal has to happen where the operator is still standing there — before the
 * patch is written — with a reason naming what was refused.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertPublishableMedia } from "../dist/cases.js";

const ASSET_ID = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";

const attachment = (contentType) => ({
  id: "attachment-1",
  assetId: ASSET_ID,
  contentPath: `/api/assets/${ASSET_ID}/content`,
  contentType,
  byteSize: 2048,
  originalFilename: "clip.webm",
  createdAt: null,
});

test("an attachment this plugin publishes is returned with its kind", () => {
  assert.equal(assertPublishableMedia(attachment("image/png"), "PAP-C1"), "image");
  assert.equal(assertPublishableMedia(attachment("video/mp4"), "PAP-C1"), "video");
  assert.equal(assertPublishableMedia(attachment("VIDEO/QUICKTIME"), "PAP-C1"), "video");
  assert.equal(
    assertPublishableMedia(attachment("image/jpeg; charset=binary"), "PAP-C1"),
    "image",
  );
});

test("a type Paperclip accepts but this calendar cannot publish is refused", () => {
  assert.throws(
    () => assertPublishableMedia(attachment("video/webm"), "PAP-C1"),
    (err) => {
      // Clear enough to act on: what, which case, which asset, and what to do.
      assert.match(err.message, /video\/webm/);
      assert.match(err.message, /PAP-C1/);
      assert.match(err.message, new RegExp(ASSET_ID));
      assert.match(err.message, /image\/png/, "the accepted types are named");
      assert.match(err.message, /nothing was changed/i);
      return true;
    },
  );
});

test("an attachment with no usable content type is refused rather than guessed", () => {
  for (const type of ["", "   ", "application/octet-stream", "image/svg+xml", null, undefined]) {
    assert.throws(
      () => assertPublishableMedia(attachment(type), "PAP-C1"),
      /nothing was changed/i,
      `${String(type)} is not something this plugin publishes`,
    );
  }
});

// --- where the worker calls it ---------------------------------------------

const WORKER = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

test("set-media refuses before it patches, not after", () => {
  const start = WORKER.indexOf('ctx.actions.register("set-media"');
  assert.ok(start > 0, "the action still exists");
  const action = WORKER.slice(start, WORKER.indexOf("ctx.actions.register", start + 1));

  const guard = action.indexOf("assertPublishableMedia(");
  const patch = action.indexOf("buildMediaPatch(");
  assert.ok(guard > 0, "the guard is called");
  assert.ok(patch > 0, "the patch is still built");
  assert.ok(
    guard < patch,
    "a refused type must never reach media_file — ordering IS the fix",
  );
});
