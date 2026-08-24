/**
 * The `create-post` worker action.
 *
 * The browser cannot create a case: it has the session cookie but not the
 * board API key, and the key is what the Cases API authenticates with. So the
 * form collects a title, a caption and a DATE, and this action does everything
 * that has to be trusted:
 *
 *   - picks the slot ON THE SERVER, against every case the company has, so two
 *     operators creating on the same day cannot be handed the same 09:00;
 *   - mints the case key, without which `POST /cases` UPDATES an existing
 *     keyless case instead of creating one;
 *   - writes `draft` with a date and refuses to write anything that would make
 *     the post publishable.
 *
 * `src/worker.ts` calls `runWorker()` at module scope, so importing it here
 * would try to open a host connection. The registration is therefore asserted
 * against the SOURCE — that the action exists, that it routes through the
 * shared helpers rather than reimplementing them, and that it never writes a
 * channel or an approval — while the behaviour those helpers carry is covered
 * directly in schedule.test.mjs and create-case.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCreatePayload } from "../dist/cases.js";
import { firstFreeSlot } from "../dist/schedule.js";

const SOURCE = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");

/** One registered action, from its `ctx.actions.register` to the next one. */
function action(name) {
  const start = SOURCE.indexOf(`ctx.actions.register("${name}"`);
  assert.ok(start > 0, `the ${name} action is registered`);
  const next = SOURCE.indexOf("ctx.actions.register(", start + 1);
  return SOURCE.slice(start, next > 0 ? next : SOURCE.length);
}

test("the calendar has a create-post action", () => {
  const body = action("create-post");
  assert.match(body, /requireStr\(params\.companyId, "companyId"\)/);
  assert.match(body, /params\.title/, "the title comes from the form");
  assert.match(body, /params\.date/, "a DATE, not a datetime");
});

test("the slot is chosen on the server, against every case the company has", () => {
  const body = action("create-post");
  // Not from the browser's view of the month: a stale calendar, a filtered
  // channel, or a second operator would all hand out a slot that is taken.
  assert.match(body, /listSocialCases\(/, "reads the current cases first");
  assert.match(body, /firstFreeSlot\(/, "and picks the slot from the shared rule");
  assert.doesNotMatch(
    body,
    /params\.publishAt/,
    "the browser does not get to name the instant",
  );
});

test("the case key is minted here, so the create cannot become an update", () => {
  const body = action("create-post");
  assert.match(body, /newCaseKey\(\)/);
});

test("the write goes through the shared payload builder and nothing else", () => {
  const body = action("create-post");
  assert.match(body, /buildCreatePayload\(/);
  assert.match(body, /createSocialCase\(/);
  // The three things that would make a draft publishable, none of which this
  // action may write.
  assert.doesNotMatch(body, /channel:/, "no channel is set");
  assert.doesNotMatch(body, /publish_url/, "no publish url is set");
  assert.doesNotMatch(body, /"approved"/, "approval is not a create-time value");
});

test("a full day is refused with a reason rather than a slot that is taken", () => {
  const body = action("create-post");
  assert.match(body, /full|free slot/i);
});

test("the create is written to the activity log like every other case write", () => {
  const body = action("create-post");
  assert.match(body, /ctx\.activity\.log\(/);
  assert.match(body, /entityType: "case"/);
});

test("the action returns what the calendar needs to navigate and select", () => {
  const body = action("create-post");
  // The form's whole promise: land on the created post. That needs the id (to
  // select), the identifier (to label) and the instant (to know which month).
  assert.match(body, /\bid\b/);
  assert.match(body, /identifier/);
  assert.match(body, /publishAt/);
});

// --- the seam the action is made of, exercised for real --------------------

test("server-side slot selection and payload building compose into a draft", () => {
  // What the action does, with the IO removed: an existing 09:00 post pushes
  // the new one to 09:30, and the result is a draft with a date and no channel.
  const existing = [{ publishAt: "2026-09-11T05:00:00.000Z" }];
  const slot = firstFreeSlot("2026-09-11", existing.map((e) => e.publishAt));
  assert.equal(slot, "2026-09-11T05:30:00.000Z");

  const payload = buildCreatePayload({
    title: "Launch post",
    caption: null,
    publishAt: slot,
    key: "calendar-test",
  });
  assert.equal(payload.status, "draft");
  assert.deepEqual(payload.fields, { publish_at: "2026-09-11T05:30:00.000Z" });
});
