#!/usr/bin/env sh
set -eu

if [ ! -f .output/server/index.mjs ]; then
  pnpm build
fi

exec pnpm start
