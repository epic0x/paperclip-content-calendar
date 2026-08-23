#!/usr/bin/env node
/**
 * Dry-run the calendar's grouping logic against the REAL cases on this
 * instance, without installing the plugin.
 *
 * The point is to find out what the calendar would actually show before it is
 * mounted in front of anyone — how many cases carry a publish_at, how many are
 * natively approved, and therefore how many the publish tick would pick up.
 */
import fs from "node:fs";
import os from "node:os";

const BASE = "http://127.0.0.1:3100";
const COMPANY = "b276d33f-a226-4fd1-95fa-b3f3114ccd9d";

const auth = JSON.parse(
  fs.readFileSync(`${os.homedir()}/.paperclip/auth.json`, "utf8"),
);
const token = auth.credentials[BASE].token;

const res = await fetch(
  `${BASE}/api/companies/${COMPANY}/cases?type=social_post&limit=200`,
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!res.ok) {
  console.error("cases API:", res.status);
  process.exit(1);
}
const payload = await res.json();
const raw = Array.isArray(payload) ? payload : (payload.cases ?? payload.data ?? []);

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

const cases = raw.map((c) => {
  const f = c.fields ?? {};
  return {
    ref: str(c.identifier) ?? str(c.key) ?? "unknown",
    status: str(c.status) ?? "draft",
    caption: str(f.caption),
    channel: str(f.channel) ?? "x",
    publishAt: str(f.publish_at),
    altText: str(f.alt_text),
    mediaFile: str(f.media_file) ?? str(f.media_path),
  };
});

const live = cases.filter((c) => c.status !== "cancelled");
const byStatus = {};
for (const c of live) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;

const byDate = {};
for (const c of live) {
  const d = c.publishAt ? c.publishAt.split("T")[0] : "unscheduled";
  (byDate[d] ??= []).push(c);
}

const now = Date.now();
const due = live.filter(
  (c) => c.status === "approved" && c.caption && c.publishAt && Date.parse(c.publishAt) <= now,
);

console.log("CASES (excluding cancelled):", live.length);
console.log("by native status:", byStatus);
console.log();

const dates = Object.keys(byDate).filter((d) => d !== "unscheduled").sort();
console.log("scheduled dates:", dates.length ? `${dates[0]} → ${dates.at(-1)}` : "none");
console.log("unscheduled (no publish_at):", byDate.unscheduled?.length ?? 0);
console.log();

console.log("next 10 days as the calendar would render them:");
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
for (let i = 0; i < 10; i++) {
  const iso = new Date(today.getTime() + i * 86400000).toISOString().slice(0, 10);
  const posts = byDate[iso] ?? [];
  const cells = posts
    .map((p) => `${p.ref}[${p.status}${p.mediaFile ? "+img" : ""}]`)
    .join(" ");
  console.log(` ${iso}  ${posts.length ? cells : "—"}`);
}

console.log();
console.log("WOULD PUBLISH RIGHT NOW:", due.length);
for (const d of due) console.log("  ", d.ref, d.publishAt);

// Integrity checks the UI depends on.
// 280 is an X limit, not a universal one. LinkedIn posts are legitimately
// long; flagging them as defects was a bug in this check, not in the data.
const overLimit = live.filter(
  (c) => c.channel === "x" && c.caption && c.caption.length > 280,
);
const mediaNoAlt = live.filter((c) => c.mediaFile && !c.altText);
const missingMedia = live.filter(
  (c) => c.mediaFile && !fs.existsSync(`${os.homedir()}/social/out/${c.mediaFile}`),
);

console.log();
console.log("INTEGRITY");
console.log("  X captions over 280:", overLimit.length, overLimit.map((c) => c.ref).join(" "));
console.log("  media without alt:", mediaNoAlt.length, mediaNoAlt.map((c) => c.ref).join(" "));
console.log("  media file missing on disk:", missingMedia.length,
  missingMedia.map((c) => `${c.ref}:${c.mediaFile}`).join(" "));
