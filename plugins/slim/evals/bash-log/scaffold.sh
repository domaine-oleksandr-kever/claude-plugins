#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/../_shared/make-log.cjs" > app.log
