import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// `zod` is a transitive dep of @paperclipai/shared and must stay external.
const workerOptions = {
  ...presets.esbuild.worker,
  external: [...(presets.esbuild.worker.external ?? []), "zod"],
};

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
