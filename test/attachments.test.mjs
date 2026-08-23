/**
 * Attachment rules — pure logic, no IO.
 *
 * Paperclip's own limits are the reference:
 *  - server/dist/attachment-types.js  DEFAULT_ALLOWED_TYPES / MAX_ATTACHMENT_BYTES
 *  - server/dist/routes/cases.js:1138 POST /cases/:id/attachments enforces the
 *    company byte cap but NOT a content type, so the type check has to happen
 *    here or nowhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  assetContentPath,
  assetRef,
  parseAssetRef,
  validateImageUpload,
} from "../dist/attachments.js";

test("a non-image file is rejected before any upload is attempted", () => {
  const result = validateImageUpload(
    { name: "notes.pdf", type: "application/pdf", size: 1024 },
    { maxBytes: 10 * 1024 * 1024 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /application\/pdf/);
});

test("a file over the company byte cap is rejected with the real limit in the message", () => {
  const result = validateImageUpload(
    { name: "hero.png", type: "image/png", size: 11 * 1024 * 1024 },
    { maxBytes: 10 * 1024 * 1024 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /10\.0 MB/);
});

test("a jpeg inside the cap is accepted", () => {
  const result = validateImageUpload(
    { name: "hero.jpg", type: "image/jpeg", size: 512 * 1024 },
    { maxBytes: 10 * 1024 * 1024 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
});

test("a zero-byte file is rejected here, not by a 422 from the server", () => {
  const result = validateImageUpload(
    { name: "empty.png", type: "image/png", size: 0 },
    { maxBytes: 10 * 1024 * 1024 },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /empty/i);
});

// --- media_file as a native asset reference -------------------------------

test("an uploaded asset is referenced natively, not by a host path", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(assetRef(id), `asset:${id}`);
  assert.equal(parseAssetRef(`asset:${id}`), id);
});

test("the content path the API returns is also a valid reference", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(parseAssetRef(`/api/assets/${id}/content`), id);
  assert.equal(
    parseAssetRef(`http://127.0.0.1:3100/api/assets/${id}/content`),
    id,
  );
});

test("a legacy host filename is NOT an asset reference and keeps publishing as a file", () => {
  assert.equal(parseAssetRef("2026-08-24-launch.png"), null);
  assert.equal(parseAssetRef("/home/openclaw/social/out/launch.png"), null);
  assert.equal(parseAssetRef(null), null);
  assert.equal(parseAssetRef("asset:not-a-uuid"), null);
});

test("the preview URL is the native asset content endpoint", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(assetContentPath(id), `/api/assets/${id}/content`);
});

// --- parseAssetRef is a validator, not a substring search -------------------
//
// `media_file` is operator- and agent-writable text that ends up being
// interpolated into `/api/assets/<id>/content` and into a temp FILE NAME. An
// unanchored match would hand back whatever surrounded the uuid, so the checks
// below are about what is REJECTED.

test("asset: accepts only a bare canonical uuid, never a uuid with anything glued to it", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(parseAssetRef(`asset:xx${id}`), null);
  assert.equal(parseAssetRef(`asset:${id}xx`), null);
  assert.equal(parseAssetRef(`asset:${id} ${id}`), null);
  assert.equal(parseAssetRef(`asset:${id}?download=1`), null);
  assert.equal(parseAssetRef(`asset:${id}#frag`), null);
  assert.equal(parseAssetRef("asset:"), null);
  assert.equal(parseAssetRef("asset:   "), null);
});

test("asset: cannot smuggle a path out of the temp dir or the assets route", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(parseAssetRef(`asset:../../etc/passwd`), null);
  assert.equal(parseAssetRef(`asset:${id}/../../etc/passwd`), null);
  assert.equal(parseAssetRef(`asset:/../${id}`), null);
  assert.equal(parseAssetRef(`asset:..%2F..%2F${id}`), null);
});

test("an uppercase uuid is canonicalised to lowercase rather than rejected", () => {
  const id = "8F14E45F-CEEA-467A-9C1E-3A0A1B2C3D4E";
  assert.equal(parseAssetRef(`asset:${id}`), id.toLowerCase());
  assert.equal(parseAssetRef(`/api/assets/${id}/content`), id.toLowerCase());
});

test("the content path form must have the uuid as an EXACT path segment", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(parseAssetRef(`/api/assets/x${id}/content`), null);
  assert.equal(parseAssetRef(`/api/assets/${id}x/content`), null);
  assert.equal(parseAssetRef(`/api/assets/${id}.png/content`), null);
  assert.equal(parseAssetRef(`/api/assets/${id}%2f..%2fsecrets/content`), null);
});

test("the content path form must be the whole path, not a fragment of a longer one", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(parseAssetRef(`/api/assets/${id}/content/../../etc/passwd`), null);
  assert.equal(parseAssetRef(`/api/assets/${id}/contents`), null);
  assert.equal(parseAssetRef(`/api/assets/${id}/metadata`), null);
  assert.equal(parseAssetRef(`/evil/api/assets/${id}/content`), null);
  assert.equal(parseAssetRef(`../api/assets/${id}/content`), null);
  // A query string on the real route is still the real route.
  assert.equal(parseAssetRef(`/api/assets/${id}/content?v=2`), id);
  assert.equal(parseAssetRef(`http://127.0.0.1:3100/api/assets/${id}/content?v=2`), id);
});

test("a uuid mentioned in prose is not an asset reference", () => {
  const id = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";
  assert.equal(parseAssetRef(`see asset:${id} for the image`), null);
  assert.equal(parseAssetRef(id), null, "a bare uuid is not a reference either");
});
