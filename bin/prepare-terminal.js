// node-pty 1.1.0 ships macOS spawn-helper binaries without executable bits.
// Remove this workaround once the upstream package preserves those modes.
//
// This runs as postinstall in several contexts where node-pty is not resolvable
// yet and must not fail the install:
//   - npm's git-dependency preparation for `npm install -g github:...` runs the
//     postinstall in the temp clone before any dependency is installed there
//     (npm/cli#6984, npm/cli#8440). The outer install runs this script again in
//     the real package directory, where node-pty exists.
//   - `npm install --ignore-scripts` flows that still trigger rebuilds.
/* eslint-disable @typescript-eslint/no-require-imports */
const { chmodSync, statSync } = require("node:fs");
const { dirname, join } = require("node:path");

if (process.platform === "darwin") {
  let root;
  try {
    root = dirname(require.resolve("node-pty/package.json"));
  } catch {
    console.warn("prepare-terminal: node-pty is not installed yet; skipping spawn-helper permission fix.");
    process.exit(0);
  }
  for (const directory of ["build/Release", "build/Debug", `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, directory, "spawn-helper");
    const stat = statSync(helper, { throwIfNoEntry: false });
    if (stat?.isFile() && (stat.mode & 0o111) !== 0o111) chmodSync(helper, stat.mode | 0o111);
  }
}
