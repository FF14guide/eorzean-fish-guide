#!/usr/bin/env bash
# Windows / macOS / Linux 共通の更新処理を、Node.js版へ委譲する互換ラッパー。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/update-from-proj.mjs" "$@"
