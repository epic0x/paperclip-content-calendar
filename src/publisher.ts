/**
 * Where the publisher scripts live.
 *
 * The X adapter shells out to `x_publish.py`, which in turn spawns its sibling
 * `x-post.py`. Both are packaged INSIDE the installed plugin artifact, beside
 * `dist/`:
 *
 *   <plugin>/dist/worker.js      ← this code, bundled
 *   <plugin>/scripts/x_publish.py
 *   <plugin>/scripts/x-post.py
 *
 * so the path is derived from the running module rather than hard-coded to a
 * particular machine's home directory. `paperclipai plugin install` copies the
 * built artifact and nothing else; a default pointing anywhere outside it is a
 * publisher that only exists on the box it was written on.
 *
 * Pure and injectable so the rule is unit-tested rather than discovered at
 * publish time, which is the one moment it must not be wrong.
 */

import { fileURLToPath } from "node:url";

/** Env var an operator can set to run a publisher from somewhere else. */
export const X_PUBLISH_SCRIPT_ENV = "PAPERCLIP_X_PUBLISH_SCRIPT";

/**
 * How long the worker waits for `x_publish.py`.
 *
 * MUST OUTLIVE THE INNER BOUND. `x_publish.py` gives `x-post.py` 600 seconds
 * (`RUN_TIMEOUT_SECS`) and then prints a JSON failure saying so — that line is
 * the only thing that tells an operator a video upload ran out of time. The
 * adapter's spawn timeout was 180 s, so it killed the publisher four hundred
 * seconds before the publisher could report anything: every slow video publish
 * came back as "no output from publisher", with an upload still in flight at X
 * that nothing would ever claim.
 *
 * 660 s = the inner 600 plus a minute for the publisher to kill its own child,
 * drain its pipes and print. The outer bound is now a backstop for a publisher
 * that has stopped enforcing its own, which is what an outer bound is for.
 */
export const X_PUBLISH_TIMEOUT_MS = 660_000;

/**
 * The `x_publish.py` this worker will spawn.
 *
 * @param moduleUrl `import.meta.url` of the calling module — inside the
 *   bundled worker that is `<plugin>/dist/worker.js`.
 * @param env process environment, injected.
 */
export function resolveXPublishScript(
  moduleUrl: string,
  env: Record<string, string | undefined>,
): string {
  const override = (env[X_PUBLISH_SCRIPT_ENV] ?? "").trim();
  if (override) return override;
  // `../scripts/` from dist/worker.js is the artifact's own scripts directory.
  return fileURLToPath(new URL("../scripts/x_publish.py", moduleUrl));
}
