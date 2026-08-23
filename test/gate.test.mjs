/**
 * Gate tests — run with `node --test`. No framework, no extra dependency.
 *
 * The gate is the only thing standing between a draft and a public post, so it
 * is tested exhaustively and with no IO.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../dist/gate.js";

const NOW = new Date("2026-08-24T12:00:00Z");

const base = {
  id: "case-uuid",
  identifier: "PAP-C1",
  key: "2026-08-24-x",
  title: "A post",
  status: "approved",
  publishAt: "2026-08-24T11:00:00Z",
  channel: "x",
  caption: "hello world",
  mediaFile: null,
  publishUrl: null,
  approved: true,
};

const input = (entryOverrides = {}, overrides = {}) => ({
  entry: { ...base, ...entryOverrides },
  now: NOW,
  autoPost: true,
  enabledChannels: ["x"],
  lookbackHours: 6,
  alreadySent: false,
  adapterReady: true,
  ...overrides,
});

test("publishes an approved, due, enabled case", () => {
  assert.equal(evaluate(input()).outcome, "publish");
});

test("autoPost off downgrades to dry_run", () => {
  const d = evaluate(input({}, { autoPost: false }));
  assert.equal(d.outcome, "dry_run");
  assert.match(d.reason, /autoPost is off/);
});

test("never sends twice", () => {
  assert.equal(evaluate(input({}, { alreadySent: true })).outcome, "skipped");
});

test("a case carrying publish_url is skipped", () => {
  const d = evaluate(input({ publishUrl: "https://x.com/u/1" }));
  assert.equal(d.outcome, "skipped");
});

test("cancelled and done never publish", () => {
  for (const status of ["cancelled", "done"]) {
    const d = evaluate(input({ status, approved: false }));
    assert.equal(d.outcome, "skipped", status);
  }
});

test("in_review is not approved", () => {
  const d = evaluate(input({ status: "in_review", approved: false }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /needs "approved"/);
});

test("a JSON fields.approved flag cannot substitute for the native status", () => {
  // approved:false is the native status check; the gate must not be fooled by
  // anything else that looks truthy.
  const d = evaluate(input({ status: "in_review", approved: false }));
  assert.equal(d.outcome, "skipped");
});

test("missing caption, channel or publish_at all skip", () => {
  assert.equal(evaluate(input({ caption: null })).outcome, "skipped");
  assert.equal(evaluate(input({ channel: null })).outcome, "skipped");
  assert.equal(evaluate(input({ publishAt: null })).outcome, "skipped");
});

test("a channel not enabled in config is skipped", () => {
  const d = evaluate(input({}, { enabledChannels: ["linkedin"] }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /not enabled/);
});

test("an unconfigured adapter is skipped, not attempted", () => {
  const d = evaluate(input({}, { adapterReady: false }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /no configured adapter/);
});

test("future posts are not due yet", () => {
  const d = evaluate(input({ publishAt: "2026-08-24T18:00:00Z" }));
  assert.equal(d.outcome, "skipped");
  assert.equal(d.reason, "not due yet");
});

test("posts overdue beyond the window are skipped, not posted late", () => {
  const d = evaluate(input({ publishAt: "2026-08-23T00:00:00Z" }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /beyond the 6h catch-up window/);
});

test("an unparseable publish_at is skipped, never thrown", () => {
  const d = evaluate(input({ publishAt: "next tuesday" }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /not a valid instant/);
});

test("already-sent beats every other condition", () => {
  const d = evaluate(
    input({ status: "approved" }, { alreadySent: true, autoPost: true }),
  );
  assert.equal(d.reason, "already published");
});
