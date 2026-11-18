#!/usr/bin/env bash
# Fail if the committed dist/ does not match a fresh build of src/.
# Used by CI and the pre-push hook so the shipped prebuilt dist never drifts.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >/dev/null

if [ -n "$(git status --porcelain -- dist)" ]; then
  echo "error: committed dist/ is out of date. Run 'npm run build' and commit dist/." >&2
  git status --porcelain -- dist >&2
  exit 1
fi
echo "dist/ is in sync with src/"
