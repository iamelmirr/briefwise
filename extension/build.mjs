// Bundles the extension host code (with the Briefwise core from ../src) and the webview.
import * as esbuild from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
fs.cpSync("../templates", "templates", { recursive: true });

const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    // the core resolves its templates via import.meta.url; the extension passes templatesDir instead
    define: { "import.meta.url": "__briefwiseImportMetaUrl" },
    banner: { js: "const __briefwiseImportMetaUrl = require('url').pathToFileURL(__filename).href;" },
  },
  { entryPoints: ["webview/main.ts"], outfile: "dist/webview.js", bundle: true, platform: "browser", format: "iife", target: "chrome120" },
  { entryPoints: ["webview/style.css"], outfile: "dist/webview.css", bundle: true, target: "chrome120" },
];

for (const b of builds) {
  const opts = { ...b, logLevel: "info", minify: !watch, sourcemap: watch ? "inline" : false };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
