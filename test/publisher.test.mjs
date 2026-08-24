/**
 * Where the worker looks for the X publisher.
 *
 * The default used to be `/home/openclaw/.hermes/scripts/x_publish.py` — the
 * layout of one particular machine. `paperclipai plugin install` copies the
 * built artifact and nothing else, so on any other host that path is a
 * publisher that does not exist, and `isConfigured` reports the X channel as
 * unavailable with no explanation beyond a missing file.
 *
 * The scripts now ship INSIDE the artifact, next to dist/. Resolving them
 * relative to the running module is what makes the plugin self-contained; the
 * environment override stays, because a host that keeps its publisher
 * somewhere else is still a legitimate deployment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  X_PUBLISH_TIMEOUT_MS,
  resolveXPublishScript,
} from "../dist/publisher.js";

// What `import.meta.url` is inside the bundled worker of an installed plugin.
const INSTALLED_WORKER = "file:///opt/paperclip/plugins/content-calendar/dist/worker.js";

test("the publisher ships with the plugin, beside dist/", () => {
  assert.equal(
    resolveXPublishScript(INSTALLED_WORKER, {}),
    "/opt/paperclip/plugins/content-calendar/scripts/x_publish.py",
  );
});

test("an operator's explicit path still wins", () => {
  assert.equal(
    resolveXPublishScript(INSTALLED_WORKER, {
      PAPERCLIP_X_PUBLISH_SCRIPT: "/srv/publishers/x_publish.py",
    }),
    "/srv/publishers/x_publish.py",
  );
});

test("an empty override is not an override", () => {
  // An unset variable that arrives as "" would otherwise resolve to a script
  // path of "", and the channel would report itself unconfigured forever.
  for (const value of ["", "   "]) {
    assert.equal(
      resolveXPublishScript(INSTALLED_WORKER, {
        PAPERCLIP_X_PUBLISH_SCRIPT: value,
      }),
      "/opt/paperclip/plugins/content-calendar/scripts/x_publish.py",
    );
  }
  assert.equal(
    resolveXPublishScript(INSTALLED_WORKER, { PAPERCLIP_X_PUBLISH_SCRIPT: undefined }),
    "/opt/paperclip/plugins/content-calendar/scripts/x_publish.py",
  );
});

test("a path is returned, not a file URL — it is handed to spawn", () => {
  const resolved = resolveXPublishScript(INSTALLED_WORKER, {});
  assert.ok(!resolved.startsWith("file:"), resolved);
  assert.ok(resolved.startsWith("/"), resolved);
});

// --- how long the worker waits for the publisher ---------------------------

test("the worker outlives the publisher's own timeout", () => {
  // scripts/x_publish.py bounds x-post.py at RUN_TIMEOUT_SECS = 600 and then
  // prints a JSON failure the adapter can report. The adapter's own spawn
  // timeout was 180s — it killed the publisher first, so a video upload that
  // was still going produced "no output from publisher" instead of the
  // publisher's reason, and X was left holding an upload nobody would claim.
  // The outer bound must sit ABOVE the inner one with room to print.
  assert.ok(
    X_PUBLISH_TIMEOUT_MS >= 660_000,
    `${X_PUBLISH_TIMEOUT_MS}ms must leave x_publish.py its 600s plus a margin`,
  );
  assert.ok(X_PUBLISH_TIMEOUT_MS > 600_000);
});

test("the X adapter spawns with that timeout and nothing else", () => {
  const channels = readFileSync(new URL("../src/channels.ts", import.meta.url), "utf8");
  assert.match(channels, /timeout: X_PUBLISH_TIMEOUT_MS/);
  assert.doesNotMatch(channels, /timeout: 180_000|timeout: 180000/);
});
