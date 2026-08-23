/**
 * Browser upload helper.
 *
 * The request shape is copied from what the Paperclip UI itself does
 * (server/ui-dist/assets/index-CfgXTNC9.js):
 *
 *   uploadAttachment: (companyId, issueId, file) => {
 *     const fd = new FormData(); fd.append("file", file);
 *     return api.postForm(`/companies/${companyId}/issues/${issueId}/attachments`, fd)
 *   }
 *   // api.postForm -> fetch(`/api${path}`, { credentials: "include", body: fd })
 *   // Content-Type is deliberately NOT set for FormData bodies.
 *
 * The case equivalent is POST /api/cases/:id/attachments
 * (server/dist/routes/cases.js:1138), which creates the asset, links it to the
 * case, and emits an `attachment_added` case event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { uploadCaseImage } from "../dist/ui/upload.js";

const ASSET_ID = "8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";

const pngFile = (name = "hero.png", bytes = 2048) =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });

const created = () => ({
  id: "attachment-uuid",
  companyId: "company-uuid",
  caseId: "case-uuid",
  assetId: ASSET_ID,
  createdAt: "2026-08-24T09:00:00.000Z",
  asset: {
    id: ASSET_ID,
    contentType: "image/png",
    byteSize: 2048,
    originalFilename: "hero.png",
  },
});

test("the image is posted to the case's native attachment endpoint as multipart", async () => {
  const calls = [];
  const result = await uploadCaseImage({
    caseId: "case-uuid",
    file: pngFile(),
    maxBytes: 10 * 1024 * 1024,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(created()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/cases/case-uuid/attachments");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get("file").name, "hero.png");
  assert.equal(
    calls[0].init.headers?.["Content-Type"],
    undefined,
    "the browser must set the multipart boundary itself",
  );

  assert.deepEqual(result, {
    attachmentId: "attachment-uuid",
    assetId: ASSET_ID,
    contentPath: `/api/assets/${ASSET_ID}/content`,
    contentType: "image/png",
    byteSize: 2048,
    originalFilename: "hero.png",
  });
});

test("a rejected upload surfaces the server's reason — never a silent success", async () => {
  await assert.rejects(
    () =>
      uploadCaseImage({
        caseId: "case-uuid",
        file: pngFile(),
        maxBytes: 10 * 1024 * 1024,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "Attachment exceeds 5242880 bytes" }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    (err) => {
      assert.equal(err.name, "UploadError");
      assert.equal(err.status, 422);
      assert.match(err.message, /Attachment exceeds 5242880 bytes/);
      return true;
    },
  );
});

test("a 2xx with no asset id is a failure, not an attachment", async () => {
  await assert.rejects(
    () =>
      uploadCaseImage({
        caseId: "case-uuid",
        file: pngFile(),
        maxBytes: 10 * 1024 * 1024,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    /returned no asset id/,
  );
});

test("an invalid file never reaches the network", async () => {
  let called = false;
  await assert.rejects(
    () =>
      uploadCaseImage({
        caseId: "case-uuid",
        file: new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
        maxBytes: 10 * 1024 * 1024,
        fetchImpl: async () => {
          called = true;
          return new Response("{}", { status: 201 });
        },
      }),
    /application\/pdf/,
  );
  assert.equal(called, false);
});

test("an HTML error page still produces a readable message", async () => {
  await assert.rejects(
    () =>
      uploadCaseImage({
        caseId: "case-uuid",
        file: pngFile(),
        maxBytes: 10 * 1024 * 1024,
        fetchImpl: async () =>
          new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      }),
    /502 Bad Gateway/,
  );
});
