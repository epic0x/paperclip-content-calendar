/**
 * Case projection and write-back.
 *
 * Traced against the installed Paperclip server:
 *  - GET /api/cases/:id returns the case row plus
 *    `attachments: [{ id, asset, createdAt, updatedAt }]`
 *    (server/dist/routes/cases.js, loadCaseDetail)
 *  - the case LIST endpoint returns bare rows with no attachments, which is why
 *    attachment metadata can only come from a per-selection detail read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  CasesApiError,
  PANEL_STATUSES,
  assertAttachedAsset,
  buildContentPatch,
  downloadAsset,
  isPanelStatus,
  fetchCaseDetail,
  describeSetMediaFailure,
  buildMediaPatch,
  patchCaseFields,
  toDetail,
} from "../dist/cases.js";

const ASSET_ID = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";

const detailResponse = (overrides = {}) => ({
  id: "case-uuid",
  identifier: "PAP-C1",
  key: "2026-08-24-x",
  caseType: "social_post",
  title: "A post",
  summary: null,
  status: "in_review",
  fields: {
    caption: "hello world",
    channel: "x",
    publish_at: "2026-08-24T11:00:00Z",
    media_file: `asset:${ASSET_ID}`,
    alt_text: "A screenshot of the dashboard",
  },
  attachments: [
    {
      id: "attachment-uuid",
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
      asset: {
        id: ASSET_ID,
        companyId: "company-uuid",
        contentType: "image/png",
        byteSize: 84_213,
        sha256: "abc",
        originalFilename: "hero.png",
        createdAt: "2026-08-24T09:00:00.000Z",
      },
    },
  ],
  ...overrides,
});

test("case detail projects native attachments into what the panel renders", () => {
  const detail = toDetail(detailResponse());

  assert.deepEqual(detail.attachments, [
    {
      id: "attachment-uuid",
      assetId: ASSET_ID,
      contentPath: `/api/assets/${ASSET_ID}/content`,
      contentType: "image/png",
      byteSize: 84_213,
      originalFilename: "hero.png",
      createdAt: "2026-08-24T09:00:00.000Z",
    },
  ]);
});

test("the active image is the one media_file points at, not simply the newest", () => {
  const newer = {
    id: "attachment-2",
    createdAt: "2026-08-24T10:00:00.000Z",
    asset: {
      id: "11111111-2222-3333-4444-555555555555",
      contentType: "image/webp",
      byteSize: 2048,
      originalFilename: "newer.webp",
    },
  };
  const detail = toDetail(
    detailResponse({
      attachments: [...detailResponse().attachments, newer],
    }),
  );

  assert.equal(detail.attachments.length, 2);
  assert.equal(detail.activeAttachment.assetId, ASSET_ID);
  assert.equal(detail.legacyMediaFile, false);
});

test("a case with no attachment reports an empty state rather than a broken image", () => {
  const detail = toDetail(
    detailResponse({ attachments: [], fields: { caption: "hi" } }),
  );
  assert.deepEqual(detail.attachments, []);
  assert.equal(detail.activeAttachment, null);
  assert.equal(detail.legacyMediaFile, false);
});

test("a legacy host filename is flagged and NOTHING is presented as the post image", () => {
  // The case still publishes from the host path. Previewing whatever happens to
  // be attached as "the image" would tell the operator the post carries an
  // image it will not actually publish.
  const detail = toDetail(
    detailResponse({
      fields: { caption: "hi", media_file: "2026-08-24-launch.png" },
    }),
  );
  assert.equal(detail.legacyMediaFile, true);
  assert.equal(detail.mediaFile, "2026-08-24-launch.png");
  assert.equal(detail.activeAttachment, null);
  // ...but the bytes are still on the case, so they are reported as history.
  assert.deepEqual(
    detail.unreferencedAttachments.map((a) => a.assetId),
    [ASSET_ID],
  );
});

test("with no media_file at all, an attachment is history and never the post image", () => {
  const detail = toDetail(detailResponse({ fields: { caption: "hi" } }));
  assert.equal(detail.mediaFile, null);
  assert.equal(detail.activeAttachment, null);
  assert.equal(detail.legacyMediaFile, false);
  assert.equal(detail.attachments.length, 1);
  assert.deepEqual(
    detail.unreferencedAttachments.map((a) => a.assetId),
    [ASSET_ID],
    "attached, but nothing points at it",
  );
});

test("media_file pointing at an asset that is not attached previews nothing", () => {
  const detail = toDetail(
    detailResponse({
      fields: {
        caption: "hi",
        media_file: "asset:99999999-9999-4999-9999-999999999999",
      },
    }),
  );
  assert.equal(detail.activeAttachment, null, "a dangling reference is not an image");
  assert.equal(detail.legacyMediaFile, false, "it IS a reference, just a broken one");
  assert.deepEqual(
    detail.unreferencedAttachments.map((a) => a.assetId),
    [ASSET_ID],
  );
});

test("everything except the referenced asset is history, whatever the upload order", () => {
  const newer = {
    id: "attachment-2",
    createdAt: "2026-08-24T10:00:00.000Z",
    asset: {
      id: "11111111-2222-4333-8444-555555555555",
      contentType: "image/webp",
      byteSize: 2048,
      originalFilename: "newer.webp",
    },
  };
  const detail = toDetail(
    detailResponse({ attachments: [...detailResponse().attachments, newer] }),
  );
  assert.equal(detail.activeAttachment.assetId, ASSET_ID);
  assert.deepEqual(
    detail.unreferencedAttachments.map((a) => a.assetId),
    ["11111111-2222-4333-8444-555555555555"],
  );
});

test("alt text and caption ride along on the detail projection", () => {
  const detail = toDetail(detailResponse());
  assert.equal(detail.caption, "hello world");
  assert.equal(detail.altText, "A screenshot of the dashboard");
  assert.equal(detail.approved, false);
  assert.equal(detail.status, "in_review");
});

// --- what KIND of media a card is looking at -------------------------------
//
// The month grid gets calendar entries and nothing else — no attachment
// metadata, because that only exists on GET /api/cases/:id and reading it per
// card would be one round trip per post per render. So the case field itself
// has to say whether media_file is an image or a video.

test("a case carrying a video projects as a video", () => {
  const detail = toDetail(
    detailResponse({
      fields: {
        media_file: `asset:${ASSET_ID}`,
        media_type: "video/mp4",
      },
    }),
  );
  assert.equal(detail.mediaType, "video");
});

test("an asset attached before media_type existed is still an image", () => {
  // Every case written by v0.3.x carries an image and no media_type. Absent is
  // the answer, not a missing one — treating it as unknown would blank the
  // thumbnail on every post that already works.
  const detail = toDetail(detailResponse());
  assert.equal(detail.mediaType, "image");
});

test("a post with no media has no media type at all", () => {
  const detail = toDetail(detailResponse({ fields: { caption: "hi" } }));
  assert.equal(detail.mediaType, null);
});

test("a stored type this plugin does not render is reported as neither, not guessed as an image", () => {
  const detail = toDetail(
    detailResponse({
      fields: { media_file: `asset:${ASSET_ID}`, media_type: "video/webm" },
    }),
  );
  assert.equal(
    detail.mediaType,
    null,
    "rendering a webm into an <img> would show a broken image and claim it is the post",
  );
});

test("the stored type is read case- and whitespace-insensitively", () => {
  const detail = toDetail(
    detailResponse({
      fields: { media_file: `asset:${ASSET_ID}`, media_type: " VIDEO/MP4 " },
    }),
  );
  assert.equal(detail.mediaType, "video");
});

// --- what a save actually sends -------------------------------------------

test("saving a caption sends only the caption, so nothing else can be clobbered", () => {
  assert.deepEqual(buildContentPatch({ caption: "  hello world  " }), {
    caption: "hello world",
  });
});

test("clearing a field is deliberate: empty text saves as null, absent keys stay untouched", () => {
  assert.deepEqual(buildContentPatch({ caption: "", altText: "   " }), {
    caption: null,
    alt_text: null,
  });
  assert.deepEqual(buildContentPatch({ altText: "a chart" }), {
    alt_text: "a chart",
  });
  assert.deepEqual(buildContentPatch({}), {});
});

test("attaching an image points media_file at the native asset, never a host path", () => {
  assert.deepEqual(
    buildMediaPatch({
      assetId: ASSET_ID,
      contentType: "image/png",
      altText: "a chart",
    }),
    {
      media_file: `asset:${ASSET_ID}`,
      media_type: "image/png",
      alt_text: "a chart",
    },
  );
});

test("attaching a video records WHAT it is, in the same patch that points at it", () => {
  // media_file and media_type move together or not at all. A media_file left
  // with a stale media_type beside it is a post that renders as the wrong thing
  // and publishes down the wrong X upload path.
  assert.deepEqual(
    buildMediaPatch({ assetId: ASSET_ID, contentType: "video/mp4" }),
    {
      media_file: `asset:${ASSET_ID}`,
      media_type: "video/mp4",
    },
  );
  assert.deepEqual(
    buildMediaPatch({ assetId: ASSET_ID, contentType: " VIDEO/QuickTime " }),
    {
      media_file: `asset:${ASSET_ID}`,
      media_type: "video/quicktime",
    },
  );
});

test("replacing a video with an image rewrites media_type rather than leaving it stale", () => {
  const patch = buildMediaPatch({ assetId: ASSET_ID, contentType: "image/jpeg" });
  assert.equal(patch.media_type, "image/jpeg");
});

// --- write-back over the real HTTP path ------------------------------------
//
// patchCaseFields talks to the loopback API with global fetch (ctx.http.fetch
// is SSRF-guarded and rejects 127.0.0.1), so stubbing globalThis.fetch
// exercises the actual request the worker makes.

const CFG = {
  apiBaseUrl: "http://127.0.0.1:3100",
  boardApiKeyRef: "secret-ref",
  paused: false,
  channels: ["x"],
  lookbackHours: 6,
};

const CTX = {
  secrets: { resolve: async () => "board-key-value" },
  logger: { info() {}, warn() {}, error() {} },
  http: {
    fetch: async () => {
      throw new Error("public fetch must not be used for the loopback API");
    },
  },
};

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("saving a caption keeps every other field — PATCH replaces `fields` wholesale", async (t) => {
  const calls = stubFetch(t, (url, init) =>
    init.method === "PATCH"
      ? json({ ...detailResponse(), fields: JSON.parse(init.body).fields })
      : json(detailResponse()),
  );

  await patchCaseFields(
    CTX,
    CFG,
    "PAP-C1",
    buildContentPatch({ caption: "a new caption" }),
    undefined,
    "company-uuid",
  );

  assert.equal(calls.length, 2, "reads the case first, then writes it back");
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[0].url, /\/api\/cases\/PAP-C1$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer board-key-value");

  const sent = JSON.parse(calls[1].init.body);
  assert.deepEqual(sent.fields, {
    caption: "a new caption",
    channel: "x",
    publish_at: "2026-08-24T11:00:00Z",
    media_file: `asset:${ASSET_ID}`,
    alt_text: "A screenshot of the dashboard",
  });
  assert.equal("status" in sent, false, "a caption save must not move the status");
});

test("a status change writes the NATIVE case status and still preserves fields", async (t) => {
  const calls = stubFetch(t, (url, init) =>
    init.method === "PATCH"
      ? json({ ...detailResponse(), status: "approved" })
      : json(detailResponse()),
  );

  const updated = await patchCaseFields(
    CTX,
    CFG,
    "PAP-C1",
    {},
    "approved",
    "company-uuid",
  );

  const sent = JSON.parse(calls[1].init.body);
  assert.equal(sent.status, "approved", "native cases.status, not a JSON field");
  assert.deepEqual(sent.fields, detailResponse().fields);
  assert.equal(updated.status, "approved");
});

test("attaching new media leaves caption, channel and publish_at alone, and carries its type", async (t) => {
  const calls = stubFetch(t, (url, init) =>
    init.method === "PATCH"
      ? json({ ...detailResponse(), fields: JSON.parse(init.body).fields })
      : json(detailResponse()),
  );

  const newAsset = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await patchCaseFields(
    CTX,
    CFG,
    "PAP-C1",
    buildMediaPatch({
      assetId: newAsset,
      contentType: "video/mp4",
      altText: "the new clip",
    }),
    undefined,
    "company-uuid",
  );

  // Paperclip REPLACES fields wholesale, so media_type has to survive the merge
  // in the same request that repoints media_file — not a second write that can
  // fail on its own and leave the two disagreeing.
  const sent = JSON.parse(calls[1].init.body);
  assert.deepEqual(sent.fields, {
    caption: "hello world",
    channel: "x",
    publish_at: "2026-08-24T11:00:00Z",
    media_file: `asset:${newAsset}`,
    media_type: "video/mp4",
    alt_text: "the new clip",
  });
});

test("an API failure surfaces the status and body instead of reporting success", async (t) => {
  stubFetch(t, (url, init) =>
    init.method === "PATCH"
      ? json({ error: "Case is locked" }, 409)
      : json(detailResponse()),
  );

  await assert.rejects(
    () =>
      patchCaseFields(
        CTX,
        CFG,
        "PAP-C1",
        buildContentPatch({ caption: "x" }),
        undefined,
        "company-uuid",
      ),
    (err) => {
      assert.equal(err.name, "CasesApiError");
      assert.equal(err.status, 409);
      assert.match(err.body, /Case is locked/);
      return true;
    },
  );
});

test("detail is one authenticated read for the selected case, attachments included", async (t) => {
  const calls = stubFetch(t, () => json(detailResponse()));

  const detail = await fetchCaseDetail(CTX, CFG, "case-uuid", "company-uuid");

  assert.equal(calls.length, 1, "one request per selection, not per card");
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[0].url, /\/api\/cases\/case-uuid$/);
  assert.equal(
    detail.activeAttachment.contentPath,
    `/api/assets/${ASSET_ID}/content`,
  );
  assert.equal(detail.identifier, "PAP-C1");
});

// --- what the panel is allowed to do ---------------------------------------

test("the panel's status list is exactly the four review states", () => {
  assert.deepEqual(PANEL_STATUSES, ["draft", "in_review", "approved", "cancelled"]);
  assert.equal(isPanelStatus("approved"), true);
  assert.equal(isPanelStatus("done"), false, "completing a case is not a calendar action");
  assert.equal(isPanelStatus("in_progress"), false);
});

test("media_file can only be pointed at an asset actually attached to this case", () => {
  const detail = toDetail(detailResponse());
  assert.equal(assertAttachedAsset(detail, ASSET_ID).assetId, ASSET_ID);
  assert.throws(
    () => assertAttachedAsset(detail, "99999999-9999-9999-9999-999999999999"),
    /not attached to PAP-C1/,
  );
});

test("asset bytes come from the native content endpoint with the board key", async (t) => {
  const calls = stubFetch(t, () =>
    new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }),
  );

  const asset = await downloadAsset(CTX, CFG, ASSET_ID, "company-uuid");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://127.0.0.1:3100/api/assets/${ASSET_ID}/content`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer board-key-value");
  assert.equal(asset.contentType, "image/png");
  assert.deepEqual([...asset.bytes], [137, 80, 78, 71]);
});

test("a missing asset fails loudly so the publish attempt is recorded as failed", async (t) => {
  stubFetch(t, () => new Response(JSON.stringify({ error: "Asset not found" }), { status: 404 }));
  await assert.rejects(
    () => downloadAsset(CTX, CFG, ASSET_ID, "company-uuid"),
    /404/,
  );
});

// --- what the operator sees vs what the server records ---------------------

test("a set-media failure is described with the case AND asset that failed", () => {
  // The browser only gets the thrown message. Whoever reads the worker log
  // afterwards needs to know WHICH case and WHICH asset, or a repointing that
  // failed is untraceable once the panel is closed.
  const line = describeSetMediaFailure({
    identifier: "PAP-C1",
    assetId: ASSET_ID,
    companyId: "company-uuid",
    err: new CasesApiError("PATCH /api/cases/PAP-C1 -> 409", 409, "Case is locked"),
  });

  assert.match(line, /set-media/);
  assert.match(line, /PAP-C1/);
  assert.match(line, new RegExp(ASSET_ID));
  assert.match(line, /company-uuid/);
  assert.match(line, /409/);
});

test("a non-Error failure is still described rather than logged as [object Object]", () => {
  const line = describeSetMediaFailure({
    identifier: "PAP-C2",
    assetId: ASSET_ID,
    companyId: "company-uuid",
    err: "connection reset",
  });
  assert.match(line, /connection reset/);
  assert.match(line, /PAP-C2/);
  assert.ok(!line.includes("[object Object]"));
});

test("the persisted media_type is the normalised content type", () => {
  // media_type is read back by `cardMedia` and by the publish path, both of
  // which match it exactly. Persisting `video/mp4; charset=binary` verbatim
  // wrote a value that neither of them recognises, so the card went blank and
  // the post could not tell an operator why.
  const patch = buildMediaPatch({
    assetId: ASSET_ID,
    contentType: "VIDEO/MP4; charset=binary",
  });
  assert.equal(patch.media_type, "video/mp4");
  assert.equal(patch.media_file, `asset:${ASSET_ID}`);
  assert.equal(
    buildMediaPatch({ assetId: ASSET_ID, contentType: "  Image/PNG  " }).media_type,
    "image/png",
  );
});
