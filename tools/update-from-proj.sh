#!/usr/bin/env bash
# 編集用ディレクトリ ../proj から、このGit管理リポジトリへ安全に反映する。
# このスクリプトはコミットやpushを行わない。内容を確認してから手動で公開すること。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$(cd "${REPO_ROOT}/../proj" && pwd)}"

if [[ ! -d "${SOURCE_ROOT}" ]]; then
  echo "エラー: 編集用ソースが見つかりません: ${SOURCE_ROOT}" >&2
  echo "SOURCE_ROOT=/path/to/proj を指定して再実行してください。" >&2
  exit 1
fi

if [[ ! -d "${REPO_ROOT}/.git" ]]; then
  echo "エラー: Gitリポジトリではありません: ${REPO_ROOT}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "エラー: 作業ツリーに未コミットの変更があります。" >&2
  echo "先に変更をコミットするか、内容を退避してから実行してください。" >&2
  git status --short >&2
  exit 1
fi

echo "[1/5] リモートの更新を早送りで取得します"
git pull --ff-only

echo "[2/5] 編集用ソースを同期します: ${SOURCE_ROOT}"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='tools/.cache/' \
  "${SOURCE_ROOT}/" "${REPO_ROOT}/"

echo "[3/5] 空白・競合マーカーを検査します"
git diff --check
if grep -RInE '^(<<<<<<<|=======|>>>>>>>)' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist .; then
  echo "エラー: 未解決の競合マーカーが見つかりました。" >&2
  exit 1
fi

echo "[4/5] 公開用ファイルをビルドします"
# build.mjs は監査用の tools/mooch-audit.md を更新する。同期後の内容を退避し、
# ビルドの副作用だけがコミット対象に混ざらないようにする。
AUDIT_FILE="tools/mooch-audit.md"
AUDIT_BACKUP="$(mktemp)"
if [[ -f "${AUDIT_FILE}" ]]; then
  cp "${AUDIT_FILE}" "${AUDIT_BACKUP}"
fi
trap 'rm -f "${AUDIT_BACKUP}"' EXIT
npm run build
if [[ -f "${AUDIT_FILE}" ]] && ! cmp -s "${AUDIT_FILE}" "${AUDIT_BACKUP}"; then
  cp "${AUDIT_BACKUP}" "${AUDIT_FILE}"
  echo "注記: ビルドが生成した ${AUDIT_FILE} の変更は作業ツリーから除外しました。"
fi

echo "[5/5] コミット対象の差分を表示します"
git status --short
git diff --stat

echo
echo "確認後、次のコマンドで公開してください。"
echo 'git add -A && git diff --cached --stat && git commit -m "更新内容" && git push'
