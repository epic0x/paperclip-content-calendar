/**
 * The two pure decisions the detail panel makes.
 *
 * Both used to live inside the component as ad-hoc state, and both were wrong
 * in a way a DOM test would have described badly:
 *
 *  1. the open panel rendered the entry object captured at click time, so a
 *     status, publish_url or schedule change that arrived with a calendar
 *     refresh — from this browser or another one — was invisible until the
 *     operator closed and reopened the post;
 *  2. every action's failure message went to one shared result area that lives
 *     inside the Post Now block, and that block is not rendered at all once a
 *     post has been published. A failed status change on a published post
 *     therefore failed silently.
 *
 * They are pure functions here so the rules can be asserted directly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  actionFailure,
  actionSuccess,
  publishMessage,
  reconcileSelection,
  statusMessage,
} from "../dist/ui/panel.js";

const entry = (over = {}) => ({
  id: "case-1",
  identifier: "PAP-C1",
  title: "A post",
  status: "in_review",
  publishAt: "2026-08-24T11:00:00Z",
  publishUrl: null,
  approved: false,
  ...over,
});

const calendar = (over = {}) => ({
  days: [{ date: "2026-08-24", entries: [entry()] }],
  unscheduled: [],
  ...over,
});

// --- selection reconciliation ---------------------------------------------

test("refreshed calendar data wins over the entry captured when the card was clicked", () => {
  const stale = entry({ status: "in_review", approved: false });
  const fresh = entry({
    status: "approved",
    approved: true,
    publishUrl: "https://x.com/u/status/1",
    publishAt: "2026-08-25T06:30:00Z",
  });

  const result = reconcileSelection(stale, calendar({
    days: [{ date: "2026-08-25", entries: [fresh] }],
  }));

  assert.equal(result.status, "approved");
  assert.equal(result.approved, true);
  assert.equal(result.publishUrl, "https://x.com/u/status/1");
  assert.equal(result.publishAt, "2026-08-25T06:30:00Z");
});

test("the match is by case id, not by position, and searches the unscheduled list too", () => {
  const stale = entry({ id: "case-2", status: "draft" });
  const result = reconcileSelection(
    stale,
    calendar({
      days: [{ date: "2026-08-24", entries: [entry({ id: "case-1" })] }],
      unscheduled: [entry({ id: "case-2", status: "approved", approved: true })],
    }),
  );
  assert.equal(result.id, "case-2");
  assert.equal(result.status, "approved");
});

test("an optimistic update survives only until real data carries that id", () => {
  // The panel may set status locally so the Post Now button unlocks in place.
  const optimistic = entry({ status: "approved", approved: true });
  // The refresh says the write did not land: the case is still in review.
  const result = reconcileSelection(optimistic, calendar());
  assert.equal(result.status, "in_review", "the server, not the browser, is the truth");
});

test("a selection the refreshed data does not contain is kept, not dropped", () => {
  // Out of the visible month, filtered, or mid-refresh. Closing the operator's
  // open panel because a fetch came back thin is worse than a stale field.
  const stale = entry({ id: "case-99" });
  assert.equal(reconcileSelection(stale, calendar()), stale);
  assert.equal(reconcileSelection(stale, null), stale);
  assert.equal(reconcileSelection(stale, { days: null, unscheduled: null }), stale);
});

test("nothing selected reconciles to nothing", () => {
  assert.equal(reconcileSelection(null, calendar()), null);
  assert.equal(reconcileSelection(null, null), null);
});

// --- where an action's outcome is allowed to appear ------------------------

test("a failed status change is a STATUS message and never a publish one", () => {
  const feedback = actionFailure("status", new Error("Case is locked"));

  assert.equal(feedback.ok, false);
  assert.match(statusMessage(feedback).text, /Case is locked/);
  assert.equal(
    publishMessage(feedback),
    null,
    "the Post Now result area is not rendered on a published post",
  );
});

test("a failed publish is a PUBLISH message and never a status one", () => {
  const feedback = actionFailure("post", new Error("no credentials"));
  assert.match(publishMessage(feedback).text, /no credentials/);
  assert.equal(statusMessage(feedback), null);
});

test("a non-Error rejection still produces readable text", () => {
  assert.match(actionFailure("status", "boom").text, /boom/);
  assert.match(actionFailure("status", { code: 500 }).text, /\S/);
});

test("a success is routed the same way, so one action cannot clear another's error", () => {
  const posted = actionSuccess("post", "Posted → https://x.com/u/status/1");
  assert.equal(posted.ok, true);
  assert.match(publishMessage(posted).text, /x\.com/);
  assert.equal(statusMessage(posted), null);
  assert.equal(statusMessage(null), null);
  assert.equal(publishMessage(null), null);
});
