/**
 * Creating a social_post case from the calendar.
 *
 * Traced against the installed Paperclip server
 * (server/dist/routes/cases.js, `POST /companies/:companyId/cases`):
 *
 *   const createCaseSchema = z.object({
 *     projectId, caseType, key, title, summary, status, fields, parentCaseId
 *   }).strict();
 *
 * Two properties of that route decide this whole module:
 *
 *  1. `.strict()` — an unknown key is a 400, not an ignored field. The payload
 *     is built rather than spread.
 *
 *  2. IT UPSERTS ON `(companyId, caseType, key)`, and the key filter is
 *     `body.key ? eq(cases.key, body.key) : isNull(cases.key)`. Posting a new
 *     case with NO key therefore matches the first existing social_post case
 *     that also has no key and UPDATES it — overwriting its title, status and
 *     entire `fields` object. "Create" without a key is a destructive write.
 *     Every create must carry a key of its own.
 *
 * And the calendar's own rule: a case created here is a DRAFT with a date and
 * nothing else. No channel, no approval, no publish_url — so the publish gate
 * cannot send it no matter what the sweep finds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreatePayload,
  createSocialCase,
  newCaseKey,
} from "../dist/cases.js";
import { evaluate } from "../dist/gate.js";

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

const created = (over = {}) => ({
  id: "new-case-uuid",
  identifier: "PAP-C42",
  key: "cal-abc",
  caseType: "social_post",
  title: "Launch post",
  summary: null,
  status: "draft",
  fields: { publish_at: "2026-09-11T05:00:00.000Z" },
  ...over,
});

// --- the payload -----------------------------------------------------------

test("a created post is a native draft carrying a date and nothing else", () => {
  const payload = buildCreatePayload({
    title: "Launch post",
    caption: "hello",
    publishAt: "2026-09-11T05:00:00.000Z",
    key: "cal-abc",
  });

  assert.deepEqual(payload, {
    caseType: "social_post",
    key: "cal-abc",
    title: "Launch post",
    status: "draft",
    fields: {
      publish_at: "2026-09-11T05:00:00.000Z",
      caption: "hello",
    },
  });
});

test("nothing that could make the post publishable is ever written", () => {
  const payload = buildCreatePayload({
    title: "Launch post",
    caption: "hello",
    publishAt: "2026-09-11T05:00:00.000Z",
    key: "cal-abc",
  });
  assert.equal("channel" in payload.fields, false);
  assert.equal("publish_url" in payload.fields, false);
  assert.equal("approved" in payload.fields, false);
  assert.equal("media_file" in payload.fields, false);
  assert.equal(payload.status, "draft", "approval is the native status");
});

test("the publish gate refuses a freshly created post on its own terms", () => {
  // The real interlock, not a claim about it: run the gate over the case this
  // module produces, at a moment its publish date has already passed, with the
  // channel enabled and the adapter ready. It must still not go out.
  const payload = buildCreatePayload({
    title: "Launch post",
    caption: "hello",
    publishAt: "2026-09-11T05:00:00.000Z",
    key: "cal-abc",
  });
  const entry = {
    id: "new-case-uuid",
    identifier: "PAP-C42",
    title: payload.title,
    status: payload.status,
    publishAt: payload.fields.publish_at,
    channel: payload.fields.channel ?? null,
    caption: payload.fields.caption ?? null,
    publishUrl: null,
    approved: payload.status === "approved",
  };
  const decision = evaluate({
    entry,
    now: new Date("2026-09-11T06:00:00.000Z"),
    enabledChannels: ["x"],
    lookbackHours: 6,
    alreadySent: false,
    adapterReady: true,
    paused: false,
    manual: true,
  });
  assert.equal(decision.outcome, "skipped");
});

test("an empty caption is omitted rather than written as an empty string", () => {
  const payload = buildCreatePayload({
    title: "Launch post",
    caption: "   ",
    publishAt: "2026-09-11T05:00:00.000Z",
    key: "cal-abc",
  });
  assert.deepEqual(payload.fields, { publish_at: "2026-09-11T05:00:00.000Z" });
});

test("the payload carries only keys the strict server schema accepts", () => {
  const allowed = new Set([
    "projectId",
    "caseType",
    "key",
    "title",
    "summary",
    "status",
    "fields",
    "parentCaseId",
  ]);
  const payload = buildCreatePayload({
    title: "T",
    caption: "c",
    publishAt: "2026-09-11T05:00:00.000Z",
    key: "cal-abc",
  });
  for (const k of Object.keys(payload)) {
    assert.ok(allowed.has(k), `${k} would be rejected by .strict()`);
  }
});

test("a title and a valid publish instant are required", () => {
  const base = {
    title: "T",
    publishAt: "2026-09-11T05:00:00.000Z",
    key: "cal-abc",
  };
  assert.throws(() => buildCreatePayload({ ...base, title: "  " }), /title/i);
  assert.throws(() => buildCreatePayload({ ...base, publishAt: "soon" }), /publish/i);
  assert.throws(() => buildCreatePayload({ ...base, publishAt: "" }), /publish/i);
});

test("a post must be created on a :00 or :30 Dubai slot, like every other write", () => {
  assert.throws(
    () =>
      buildCreatePayload({
        title: "T",
        publishAt: "2026-09-11T05:07:00.000Z",
        key: "cal-abc",
      }),
    /slot/i,
  );
});

test("a create without a key is refused, because the server would UPDATE instead", () => {
  // `isNull(cases.key)` matches any existing keyless social_post case. This is
  // the one that silently destroys somebody else's post.
  for (const key of [undefined, null, "", "   "]) {
    assert.throws(
      () =>
        buildCreatePayload({
          title: "T",
          publishAt: "2026-09-11T05:00:00.000Z",
          key,
        }),
      /key/i,
    );
  }
});

test("a generated key is unique and within the server's 512-character limit", () => {
  const a = newCaseKey();
  const b = newCaseKey();
  assert.notEqual(a, b);
  assert.ok(a.length > 8 && a.length <= 512);
  assert.match(a, /^[A-Za-z0-9_.:-]+$/);
});

// --- the request itself ----------------------------------------------------

test("a create is one authenticated POST to the company's cases endpoint", async (t) => {
  const calls = stubFetch(t, () => json(created(), 201));

  const res = await createSocialCase(
    CTX,
    CFG,
    buildCreatePayload({
      title: "Launch post",
      caption: "hello",
      publishAt: "2026-09-11T05:00:00.000Z",
      key: "cal-abc",
    }),
    "company-uuid",
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:3100/api/companies/company-uuid/cases",
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer board-key-value");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    caseType: "social_post",
    key: "cal-abc",
    title: "Launch post",
    status: "draft",
    fields: { publish_at: "2026-09-11T05:00:00.000Z", caption: "hello" },
  });

  assert.equal(res.created, true, "201 means a new case");
  assert.equal(res.entry.id, "new-case-uuid");
  assert.equal(res.entry.identifier, "PAP-C42");
  assert.equal(res.entry.publishAt, "2026-09-11T05:00:00.000Z");
  assert.equal(res.entry.status, "draft");
  assert.equal(res.entry.approved, false);
  assert.equal(res.entry.channel, null);
  assert.equal(res.entry.publishUrl, null);
});

test("a 200 is reported as an upsert, not as a fresh create", async (t) => {
  // The route answers 200 when it matched an existing (caseType, key). The
  // caller has to be able to tell, because a create that quietly updated
  // something is the failure mode this key exists to prevent.
  stubFetch(t, () => json(created(), 200));
  const res = await createSocialCase(
    CTX,
    CFG,
    buildCreatePayload({
      title: "Launch post",
      publishAt: "2026-09-11T05:00:00.000Z",
      key: "cal-abc",
    }),
    "company-uuid",
  );
  assert.equal(res.created, false);
});

test("a refused create surfaces the status and body instead of a blank card", async (t) => {
  stubFetch(t, () =>
    json({ error: "Cases are disabled" }, 403),
  );
  await assert.rejects(
    () =>
      createSocialCase(
        CTX,
        CFG,
        buildCreatePayload({
          title: "T",
          publishAt: "2026-09-11T05:00:00.000Z",
          key: "cal-abc",
        }),
        "company-uuid",
      ),
    (err) => {
      assert.equal(err.name, "CasesApiError");
      assert.equal(err.status, 403);
      assert.match(err.body, /Cases are disabled/);
      return true;
    },
  );
});

test("a response wrapped in { case } is projected the same way", async (t) => {
  stubFetch(t, () => json({ case: created() }, 201));
  const res = await createSocialCase(
    CTX,
    CFG,
    buildCreatePayload({
      title: "Launch post",
      publishAt: "2026-09-11T05:00:00.000Z",
      key: "cal-abc",
    }),
    "company-uuid",
  );
  assert.equal(res.entry.identifier, "PAP-C42");
});
