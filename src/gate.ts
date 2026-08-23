/**
 * The publish gate.
 *
 * Every reason a case may or may not be published lives here, as one pure
 * function over data. It has no IO, so it is trivially testable and it is the
 * single place to audit before anything can reach a public channel.
 */

import type { CalendarEntry } from "./cases.js";

export type GateOutcome = "publish" | "dry_run" | "skipped";

export interface GateDecision {
  outcome: GateOutcome;
  reason: string;
}

export interface GateInput {
  entry: CalendarEntry;
  now: Date;
  autoPost: boolean;
  enabledChannels: string[];
  lookbackHours: number;
  /** True when publish_attempts already holds a 'sent' row for this case. */
  alreadySent: boolean;
  /** True when a channel adapter exists AND reports itself configured. */
  adapterReady: boolean;
}

export function evaluate(input: GateInput): GateDecision {
  const {
    entry,
    now,
    autoPost,
    enabledChannels,
    lookbackHours,
    alreadySent,
    adapterReady,
  } = input;

  // 1. Already out. Highest precedence: never double-post.
  if (alreadySent) {
    return { outcome: "skipped", reason: "already published" };
  }
  if (entry.publishUrl) {
    return {
      outcome: "skipped",
      reason: "case already carries a publish_url",
    };
  }

  // 2. Terminal states never publish.
  if (entry.status === "cancelled") {
    return { outcome: "skipped", reason: "case is cancelled" };
  }
  if (entry.status === "done") {
    return { outcome: "skipped", reason: "case is done" };
  }

  // 3. Approval — the NATIVE case status, not a JSON field.
  if (!entry.approved) {
    return {
      outcome: "skipped",
      reason: `case status is "${entry.status}", needs "approved"`,
    };
  }

  // 4. Must have something to say.
  if (!entry.caption) {
    return { outcome: "skipped", reason: "case has no caption" };
  }

  // 5. Must have a channel, and it must be switched on.
  if (!entry.channel) {
    return { outcome: "skipped", reason: "case has no channel" };
  }
  if (!enabledChannels.includes(entry.channel.toLowerCase())) {
    return {
      outcome: "skipped",
      reason: `channel "${entry.channel}" is not enabled in plugin config`,
    };
  }
  if (!adapterReady) {
    return {
      outcome: "skipped",
      reason: `no configured adapter for channel "${entry.channel}"`,
    };
  }

  // 6. Timing.
  if (!entry.publishAt) {
    return { outcome: "skipped", reason: "case has no publish_at" };
  }
  const due = Date.parse(entry.publishAt);
  if (Number.isNaN(due)) {
    return {
      outcome: "skipped",
      reason: `publish_at is not a valid instant: "${entry.publishAt}"`,
    };
  }
  if (due > now.getTime()) {
    return { outcome: "skipped", reason: "not due yet" };
  }
  const ageHours = (now.getTime() - due) / 3_600_000;
  if (ageHours > lookbackHours) {
    return {
      outcome: "skipped",
      reason: `overdue by ${ageHours.toFixed(1)}h, beyond the ${lookbackHours}h catch-up window — reschedule it rather than posting late`,
    };
  }

  // 7. Everything passed. The last gate is the operator switch.
  if (!autoPost) {
    return {
      outcome: "dry_run",
      reason: "would publish, but autoPost is off",
    };
  }

  return { outcome: "publish", reason: "due and approved" };
}
