/**
 * Gate tests — run with `node --test`. No framework, no extra dependency.
 *
 * The gate is the only thing standing between a draft and a public post, so it
 * is tested exhaustively and with no IO.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  enabledChannels: ["x"],
  lookbackHours: 6,
  alreadySent: false,
  adapterReady: true,
  paused: false,
  ...overrides,
});

test("publishes an approved, due, enabled case", () => {
  assert.equal(evaluate(input()).outcome, "publish");
});

test("approved + due publishes with no extra switch — that is the whole rule", () => {
  const d = evaluate(input());
  assert.equal(d.outcome, "publish");
  assert.equal(d.reason, "approved and due");
});

test("the emergency pause downgrades a due post to dry_run", () => {
  const d = evaluate(input({}, { paused: true }));
  assert.equal(d.outcome, "dry_run");
  assert.match(d.reason, /paused instance-wide/);
});

test("the emergency pause also stops Post Now — a stop a button can walk past is not a stop", () => {
  const d = evaluate(input({}, { paused: true, manual: true }));
  assert.equal(d.outcome, "dry_run");
  assert.match(d.reason, /paused instance-wide/);
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
  const d = evaluate(input({ status: "approved" }, { alreadySent: true }));
  assert.equal(d.reason, "already published");
});

// ---------------------------------------------------------------------------
// Post Now (manual). It is an AUTHORIZATION scoped to one case, not a bypass.
// These tests are the contract: they pin down exactly what a human click can
// and cannot override.
// ---------------------------------------------------------------------------

test("manual publishes and is attributed as manual", () => {
  const d = evaluate(input({}, { manual: true }));
  assert.equal(d.outcome, "publish");
  assert.match(d.reason, /manually/);
});

test("manual ignores the schedule: a future post can be sent now", () => {
  const d = evaluate(
    input({ publishAt: "2027-01-01T00:00:00Z" }, { manual: true }),
  );
  assert.equal(d.outcome, "publish");
});

test("manual ignores the catch-up window: a stale post can be sent now", () => {
  const d = evaluate(
    input({ publishAt: "2026-01-01T00:00:00Z" }, { manual: true }),
  );
  assert.equal(d.outcome, "publish");
});

test("manual works on a case with NO publish_at at all", () => {
  const d = evaluate(input({ publishAt: null }, { manual: true }));
  assert.equal(d.outcome, "publish");
});

test("manual CANNOT publish an unapproved case", () => {
  const d = evaluate(
    input({ status: "in_review", approved: false }, { manual: true }),
  );
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /needs "approved"/);
});

test("manual CANNOT double-post", () => {
  const d = evaluate(input({}, { manual: true, alreadySent: true }));
  assert.equal(d.outcome, "skipped");
  assert.equal(d.reason, "already published");
});

test("manual CANNOT repost a case that already has a publish_url", () => {
  const d = evaluate(input({ publishUrl: "https://x.com/u/1" }, { manual: true }));
  assert.equal(d.outcome, "skipped");
});

test("manual CANNOT publish a cancelled or done case", () => {
  for (const status of ["cancelled", "done"]) {
    const d = evaluate(input({ status, approved: false }, { manual: true }));
    assert.equal(d.outcome, "skipped", status);
  }
});

test("manual CANNOT publish without a caption", () => {
  const d = evaluate(input({ caption: null }, { manual: true }));
  assert.equal(d.outcome, "skipped");
});

test("manual CANNOT publish to a disabled channel", () => {
  const d = evaluate(input({}, { manual: true, enabledChannels: [] }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /not enabled/);
});

test("manual CANNOT publish through an unconfigured adapter", () => {
  const d = evaluate(input({}, { manual: true, adapterReady: false }));
  assert.equal(d.outcome, "skipped");
  assert.match(d.reason, /no configured adapter/);
});

test("paused defaults to false — publishing is on unless explicitly stopped", () => {
  const { paused, ...noPause } = input();
  void paused;
  assert.equal(evaluate(noPause).outcome, "publish");
});

test("a malformed paused value cannot silently halt the calendar", () => {
  // Only boolean true pauses; the worker coerces with `raw.paused === true`.
  assert.equal(evaluate(input({}, { paused: false })).outcome, "publish");
});

test("scheduled publishing does not depend on companies.list invocation scope", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /ctx\.companies\.list\(\)/);
  // The sweep is scoped by configuration, not by whichever company happened to
  // invoke the plugin: the job resolves PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID
  // from the process environment and sweeps exactly that company.
  const job = worker.slice(worker.indexOf("async function registerJobs("));
  assert.match(job, /resolveScheduledCompanyId\(process\.env\)/);
  assert.match(job, /publishSweep\(\s*ctx,\s*companyId,/);
  assert.match(worker, /env\.PAPERCLIP_CONTENT_CALENDAR_COMPANY_ID/);
});

// --- 0.3.0 regressions -----------------------------------------------------
//
// The editor panel added caption editing, native-asset attachments and a
// status dropdown. None of that is allowed to move the publish gate.

test("a native asset attachment does not change a single gate outcome", () => {
  const asset = "asset:8f14e45f-ceea-467a-9c1e-3a0a1b2c3d4e";

  assert.equal(evaluate(input({ mediaFile: asset })).outcome, "publish");
  assert.equal(
    evaluate(input({ mediaFile: asset, status: "in_review", approved: false })).outcome,
    "skipped",
  );
  assert.equal(
    evaluate(input({ mediaFile: asset, caption: null })).reason,
    "case has no caption",
  );
  assert.equal(
    evaluate(input({ mediaFile: asset }, { alreadySent: true })).reason,
    "already published",
  );
  assert.equal(
    evaluate(input({ mediaFile: asset }, { paused: true, manual: true })).outcome,
    "dry_run",
  );
});

test("an empty caption saved from the panel still blocks publishing, by either route", () => {
  // buildContentPatch turns "" into null, which is what toEntry already reads
  // back as "no caption" — the gate must keep treating that as a blocker.
  assert.equal(evaluate(input({ caption: null })).outcome, "skipped");
  assert.equal(evaluate(input({ caption: null }, { manual: true })).outcome, "skipped");
});
