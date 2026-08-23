import test from "node:test";
import assert from "node:assert/strict";
import {
  dubaiDayKey,
  dubaiLocalToIso,
  dubaiMonth,
  dubaiTime,
  dubaiYear,
  isoToDubaiLocalInput,
} from "../dist/time.js";

const DUBAI_MIDNIGHT = "2026-08-23T20:51:00Z";

test("an instant after Dubai midnight belongs to 24 August", () => {
  assert.equal(dubaiDayKey(DUBAI_MIDNIGHT), "2026-08-24");
});

test("calendar time displays in Dubai without a UTC suffix", () => {
  assert.equal(dubaiTime(DUBAI_MIDNIGHT), "00:51");
});

test("a stored UTC instant populates the Dubai datetime-local control", () => {
  assert.equal(isoToDubaiLocalInput(DUBAI_MIDNIGHT), "2026-08-24T00:51");
});

test("a Dubai datetime-local value saves as the correct UTC instant", () => {
  assert.equal(dubaiLocalToIso("2026-08-24T00:51"), "2026-08-23T20:51:00.000Z");
});

test("Today uses the Dubai calendar date, not UTC", () => {
  const now = new Date("2026-08-23T20:48:00Z");
  assert.equal(dubaiYear(now), 2026);
  assert.equal(dubaiMonth(now), 7);
  assert.equal(dubaiDayKey(now), "2026-08-24");
});

test("invalid local input is rejected instead of silently shifting", () => {
  assert.throws(() => dubaiLocalToIso("2026-02-30T12:00"), /valid Dubai date/);
});
