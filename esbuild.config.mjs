import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

/**
 * Use the SDK worker preset as-is.
 *
 * The June scaffold added `zod` to `external`, inherited from a monorepo setup
 * where node_modules was on disk beside the plugin. The installed artifact has
 * NO node_modules — `paperclipai plugin install` copies built output only — so
 * anything left external fails at worker startup with
 *   ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
 * and the install aborts with "Worker initialize failed".
 *
 * The SDK preset externalises exactly react and react-dom, which the host
 * provides. Everything else must be bundled. Do not add to this list.
 */
const workerOptions = presets.esbuild.worker;

/**
 * The publish gate is also emitted as its own ESM file.
 *
 * It is a pure function with no imports, and it is the only thing standing
 * between a draft and a public post — so it is unit-tested directly rather
 * than through the bundled worker. Bundling it into worker.js alone would
 * leave the tests importing a file that does not exist, which is exactly the
 * CI failure this build step fixes.
 */
const gateOptions = {
  entryPoints: ["src/gate.ts"],
  outfile: "dist/gate.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  sourcemap: true,
  logLevel: "info",
};

/**
 * The same reasoning applies to every other module the unit tests import
 * directly: `node --test` loads built ESM from dist/, so a module that only
 * ever exists inside worker.js or ui/index.js cannot be tested at all.
 *
 * These are all small and dependency-free by design — the pure attachment
 * rules, the case projection/write-back client, the publish-time media
 * resolver, and the browser upload helper.
 */
const nodeModule = (name) => ({
  entryPoints: [`src/${name}.ts`],
  outfile: `dist/${name}.js`,
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  sourcemap: true,
  logLevel: "info",
});

const timeOptions = nodeModule("time");
const scheduleOptions = nodeModule("schedule");
const attachmentsOptions = nodeModule("attachments");
const casesOptions = nodeModule("cases");
const mediaOptions = nodeModule("media");
const channelsOptions = nodeModule("channels");
const xPublisherOptions = nodeModule("x-publisher");

/**
 * The browser-side modules that are worth testing on their own, emitted beside
 * the UI bundle: the upload helper (FormData, the page's fetch, the session
 * cookie) and the panel's pure rules (which card the open panel is showing,
 * and which section an action's outcome belongs in).
 */
const browserModule = (name) => ({
  entryPoints: [`src/ui/${name}.ts`],
  outfile: `dist/ui/${name}.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  logLevel: "info",
});

const uploadOptions = browserModule("upload");
const panelOptions = browserModule("panel");

const contexts = await Promise.all([
  esbuild.context(workerOptions),
  esbuild.context(presets.esbuild.manifest),
  esbuild.context(presets.esbuild.ui),
  esbuild.context(gateOptions),
  esbuild.context(timeOptions),
  esbuild.context(scheduleOptions),
  esbuild.context(attachmentsOptions),
  esbuild.context(casesOptions),
  esbuild.context(mediaOptions),
  esbuild.context(channelsOptions),
  esbuild.context(xPublisherOptions),
  esbuild.context(uploadOptions),
  esbuild.context(panelOptions),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(
    "esbuild watch mode enabled for worker, manifest, ui, gate, time, schedule, attachments, cases, media, channels, x-publisher, upload, panel",
  );
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
