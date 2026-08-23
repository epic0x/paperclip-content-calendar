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

const contexts = await Promise.all([
  esbuild.context(workerOptions),
  esbuild.context(presets.esbuild.manifest),
  esbuild.context(presets.esbuild.ui),
  esbuild.context(gateOptions),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("esbuild watch mode enabled for worker, manifest, ui, gate");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
