#!/usr/bin/env node
// Launcher. From a checkout it runs the TypeScript source directly (Node type stripping);
// when installed as a package (inside node_modules, where Node won't strip types) it runs
// the JavaScript build in dist/, which `npm run build` / `prepare` produces.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(here), "..");
const installed = here.split(path.sep).includes("node_modules");
const built = path.join(root, "dist", "cli.js");
const args = installed || !existsSync(path.join(root, "src", "cli.ts"))
  ? [built]
  : ["--experimental-strip-types", "--no-warnings", path.join(root, "src", "cli.ts")];
const r = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
