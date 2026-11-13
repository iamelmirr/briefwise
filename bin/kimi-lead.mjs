#!/usr/bin/env node
// Launcher: runs the TypeScript source directly with Node's built-in type stripping.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", src, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
