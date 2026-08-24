/**
 * Publishing natively attached media.
 *
 * The Node X adapter takes a temporary file path, but durable media identity is
 * always a Paperclip asset reference. Asset bytes are fetched from the native
 * content endpoint and materialised only for the duration of one attempt.
 * Host-local filenames are rejected by the fresh public plugin.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveMediaForPublish, tempFileNameFor } from "../dist/media.js";

const ASSET_ID = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";

const deps = (overrides = {}) => ({
  downloaded: [],
  written: [],
  removed: [],
  ...overrides,
});

function makeDeps(state, opts = {}) {
  let attempt = 0;
  return {
    newAttemptId: () => `attempt${(attempt += 1)}`,
    downloadAsset: async (assetId) => {
      state.downloaded.push(assetId);
      if (opts.downloadError) throw new Error(opts.downloadError);
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: opts.contentType ?? "image/png",
      };
    },
    writeTempFile: async (name, bytes) => {
      state.written.push({ name, size: bytes.length });
      return `/tmp/${name}`;
    },
    removeFile: async (path) => {
      state.removed.push(path);
    },
  };
}

test("a host-local media path is rejected before publishing", async () => {
  const state = deps();

  await assert.rejects(
    resolveMediaForPublish("2026-08-24-launch.png", makeDeps(state)),
    /Paperclip asset/i,
  );
  assert.deepEqual(state.downloaded, []);
  assert.deepEqual(state.written, []);
  assert.deepEqual(state.removed, []);
});

test("a native asset is materialised in a temp file and cleaned up afterwards", async () => {
  const state = deps();
  const media = await resolveMediaForPublish(`asset:${ASSET_ID}`, makeDeps(state));

  assert.deepEqual(state.downloaded, [ASSET_ID]);
  assert.equal(state.written.length, 1);
  assert.match(state.written[0].name, /\.png$/, "extension follows the content type");
  assert.ok(state.written[0].name.includes(ASSET_ID));
  assert.equal(state.written[0].size, 3);
  assert.equal(media.path, `/tmp/${state.written[0].name}`);
  assert.equal(media.assetId, ASSET_ID);

  await media.cleanup();
  assert.deepEqual(state.removed, [media.path]);
});

test("a failed download stops the post rather than publishing it text-only", async () => {
  const state = deps();
  await assert.rejects(
    () =>
      resolveMediaForPublish(
        `asset:${ASSET_ID}`,
        makeDeps(state, { downloadError: "404 Asset not found" }),
      ),
    /404 Asset not found/,
  );
  assert.deepEqual(state.written, []);
});

test("an absent or blank media field resolves to text-only publishing", async () => {
  for (const mediaFile of [null, undefined, "", "   "]) {
    const state = deps();
    const media = await resolveMediaForPublish(mediaFile, makeDeps(state));
    assert.equal(media.path, null);
    assert.equal(media.assetId, null);
    await media.cleanup();
    assert.deepEqual(state.downloaded, []);
    assert.deepEqual(state.written, []);
    assert.deepEqual(state.removed, []);
  }
});

test("a jpeg asset gets a .jpg temp file", async () => {
  const state = deps();
  await resolveMediaForPublish(
    `asset:${ASSET_ID}`,
    makeDeps(state, { contentType: "image/jpeg" }),
  );
  assert.match(state.written[0].name, /\.jpg$/);
});

test("the content path form of media_file resolves natively too", async () => {
  const state = deps();
  const media = await resolveMediaForPublish(
    `/api/assets/${ASSET_ID}/content`,
    makeDeps(state),
  );
  assert.equal(media.assetId, ASSET_ID);
  assert.deepEqual(state.downloaded, [ASSET_ID]);
});

// --- one temp file per ATTEMPT, not one per asset --------------------------
//
// The scheduled sweep and Post Now can both be resolving the same case at the
// same moment. When both wrote `content-calendar-<assetId>.png`, whichever
// finished first deleted the file the other one was about to hand to the X
// upload — a publish that failed with a missing file for no reason visible
// anywhere.

test("two attempts on the same asset get different files, so neither cleans up the other's", async () => {
  const state = deps();
  const d = makeDeps(state);

  const scheduled = await resolveMediaForPublish(`asset:${ASSET_ID}`, d);
  const manual = await resolveMediaForPublish(`asset:${ASSET_ID}`, d);

  assert.notEqual(scheduled.path, manual.path, "same path = one attempt deletes the other's file");
  assert.match(scheduled.path, /\.png$/, "the extension still follows the content type");
  assert.match(manual.path, /\.png$/);

  await scheduled.cleanup();
  assert.deepEqual(state.removed, [scheduled.path], "only its own temp copy");

  await manual.cleanup();
  assert.deepEqual(state.removed, [scheduled.path, manual.path]);
});

test("the attempt id comes from the caller, so the name is a pure function of its inputs", () => {
  const a = tempFileNameFor(ASSET_ID, "image/jpeg", "attempt-1");
  const b = tempFileNameFor(ASSET_ID, "image/jpeg", "attempt-2");

  assert.notEqual(a, b);
  assert.equal(a, tempFileNameFor(ASSET_ID, "image/jpeg", "attempt-1"));
  assert.match(a, /\.jpg$/);
  assert.ok(a.includes(ASSET_ID), "still traceable back to the asset");
  assert.match(tempFileNameFor(ASSET_ID, "application/pdf", "x"), /\.bin$/);
});

test("a temp name is always a single file name, never a path", () => {
  for (const name of [
    tempFileNameFor("../../etc/passwd", "image/png", "x"),
    tempFileNameFor(ASSET_ID, "image/png", "../../evil"),
    tempFileNameFor("", "image/png", ""),
  ]) {
    assert.ok(!name.includes("/"), `${name} must not contain a separator`);
    assert.ok(!name.includes("\\"), `${name} must not contain a separator`);
    assert.ok(!name.includes(".."), `${name} must not contain ..`);
    assert.match(name, /^content-calendar-/);
  }
});

// --- video -----------------------------------------------------------------
//
// The publish script and X both sniff on the EXTENSION as well as the bytes,
// and the chunked upload path is chosen from it. A video written to a `.bin`
// temp file is a video X refuses.

test("an mp4 asset is materialised as an .mp4, not a .bin", async () => {
  const state = deps();
  await resolveMediaForPublish(
    `asset:${ASSET_ID}`,
    makeDeps(state, { contentType: "video/mp4" }),
  );
  assert.match(state.written[0].name, /\.mp4$/);
});

test("a quicktime asset is materialised as a .mov", async () => {
  const state = deps();
  await resolveMediaForPublish(
    `asset:${ASSET_ID}`,
    makeDeps(state, { contentType: "video/quicktime" }),
  );
  assert.match(state.written[0].name, /\.mov$/);
});

test("the video temp name is still one attempt-scoped file name, never a path", () => {
  const a = tempFileNameFor(ASSET_ID, "video/mp4", "attempt-1");
  const b = tempFileNameFor(ASSET_ID, "video/mp4", "attempt-2");
  assert.notEqual(a, b, "a sweep and a Post Now must not delete each other's copy");
  assert.match(a, /\.mp4$/);
  assert.match(tempFileNameFor(ASSET_ID, "VIDEO/QUICKTIME", "x"), /\.mov$/);
  for (const name of [
    tempFileNameFor("../../etc/passwd", "video/mp4", "x"),
    tempFileNameFor(ASSET_ID, "video/mp4", "../../evil"),
  ]) {
    assert.ok(!name.includes("/"), `${name} must not contain a separator`);
    assert.ok(!name.includes(".."), `${name} must not contain ..`);
  }
});

test("a content type carrying parameters still picks the right extension", () => {
  // `video/mp4; charset=binary` is a real thing to find on an asset row, and
  // it used to fall off the end of the extension table into `.bin` — which
  // sends an mp4 up X's IMAGE path, where it is rejected. The extension is
  // load-bearing, so the lookup normalises exactly like everything else does.
  assert.match(tempFileNameFor(ASSET_ID, "video/mp4; charset=binary", "x"), /\.mp4$/);
  assert.match(tempFileNameFor(ASSET_ID, "VIDEO/MP4 ;charset=binary", "x"), /\.mp4$/);
  assert.match(tempFileNameFor(ASSET_ID, "image/png; name=hero.png", "x"), /\.png$/);
  // An unknown type is still .bin: naming bytes we cannot name is worse.
  assert.match(tempFileNameFor(ASSET_ID, "video/webm; charset=binary", "x"), /\.bin$/);
});
