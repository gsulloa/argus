#!/usr/bin/env node
// sync-changelog.mjs — copies the single-source root CHANGELOG.md into the
// generated output path consumed by the Vite frontend via a `?raw` import.
//
// Output: packages/app/src/generated/changelog.md  (gitignored)
//
// This file must be run before `vite dev`, `vite build`, `vitest`, etc. so the
// bundled copy is always in sync with the root changelog. It is wired into the
// `dev`, `build`, `test`, and `test:run` npm scripts for that reason. Never
// edit the generated copy directly — edit the root CHANGELOG.md instead.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  // scripts/ → packages/app/ → packages/ → repo root
  const repoRoot = join(scriptDir, "..", "..", "..");

  const srcPath = join(repoRoot, "CHANGELOG.md");
  if (!existsSync(srcPath)) {
    process.stderr.write(
      `sync-changelog: ERROR: root CHANGELOG.md not found at ${srcPath}\n` +
        `  Expected the single-source changelog at the repository root.\n`
    );
    process.exit(1);
  }

  const content = readFileSync(srcPath, "utf8");

  const outDir = join(scriptDir, "..", "src", "generated");
  mkdirSync(outDir, { recursive: true });

  const outPath = join(outDir, "changelog.md");
  writeFileSync(outPath, content, "utf8");

  process.stderr.write(`sync-changelog: wrote ${outPath}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
