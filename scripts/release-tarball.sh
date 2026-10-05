#!/bin/sh
# Build the installable pi-web-voice tarball in a scratch git worktree and
# copy it next to the repository (pi-web-voice-<version>.tgz).
#
# The build must never run in the development checkout itself: a production
# .next there breaks `npm run dev` (see AGENTS.md). A tarball install also
# needs the prebuilt .next, because Next cannot build from any path that
# contains node_modules — which is where every installed package lives.
#
# Usage: scripts/release-tarball.sh
set -eu

repo_root="$(git rev-parse --show-toplevel)"
version="$(node -p "require('$repo_root/package.json').version")"
tarball="pi-web-voice-$version.tgz"

worktree="$(mktemp -d)/pi-web-voice"
trap 'rm -rf "$(dirname "$worktree")"' EXIT
git -C "$repo_root" worktree add --detach "$worktree" HEAD >/dev/null

(
  cd "$worktree"
  npm install --no-audit --no-fund
  npm run build
  npm pack --silent
)

mv "$worktree/$tarball" "$repo_root/$tarball"
git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true

echo
echo "Built $repo_root/$tarball"
echo "Install it with:"
echo "  npm install -g $repo_root/$tarball"
