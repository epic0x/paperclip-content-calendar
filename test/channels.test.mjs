import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { adapterFor, readRange } = await import("../dist/channels.js");

const completeRefs = {
  apiKeyRef: { type: "secret_ref", secretId: "api-key" },
  apiSecretRef: { type: "secret_ref", secretId: "api-secret" },
  accessTokenRef: { type: "secret_ref", secretId: "access-token" },
  accessSecretRef: { type: "secret_ref", secretId: "access-secret" },
};

const config = (xCredentials = completeRefs) => ({ xCredentials });

test("production range reads honor offsets and return only bytes available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "calendar-range-"));
  const path = join(dir, "clip.bin");
  try {
    await writeFile(path, Buffer.from("0123456789"));
    assert.equal(Buffer.from(await readRange(path, 3, 4)).toString(), "3456");
    assert.equal(Buffer.from(await readRange(path, 8, 8)).toString(), "89");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("X is configured from references without resolving secret values", async () => {
  let resolutions = 0;
  const ctx = {
    secrets: {
      async resolve() {
        resolutions += 1;
        throw new Error("secret store should not be called by isConfigured");
      },
    },
  };
  const adapter = adapterFor("x");
  assert.ok(adapter);

  assert.equal(await adapter.isConfigured(ctx, config(), "11111111-1111-4111-8111-111111111111"), true);
  assert.equal(resolutions, 0);
});

test("X is unconfigured when any secret reference is absent", async () => {
  const adapter = adapterFor("x");
  assert.ok(adapter);
  const refs = { ...completeRefs, accessSecretRef: undefined };

  assert.equal(
    await adapter.isConfigured({ secrets: {} }, config(refs), "11111111-1111-4111-8111-111111111111"),
    false,
  );
});

test("a secret-store error becomes a failed publish for the active company", async () => {
  const companyId = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const ctx = {
    secrets: {
      async resolve(ref, scope) {
        calls.push({ ref, scope });
        throw new Error("backend unavailable: do not expose this detail");
      },
    },
  };
  const adapter = adapterFor("x");
  assert.ok(adapter);

  const result = await adapter.publish(ctx, config(), companyId, {
    entry: { id: "case-1" },
    caption: "Safe caption",
    mediaFile: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.url, null);
  assert.match(result.error, /credential resolution failed/i);
  assert.doesNotMatch(result.error, /backend unavailable/i);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.scope.companyId === companyId));
});
