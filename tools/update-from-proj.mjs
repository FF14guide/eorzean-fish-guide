#!/usr/bin/env node
/**
 * 編集用ディレクトリ ../proj を、このGit管理リポジトリへ同期して検証する。
 * Windows / macOS / Linux で動作し、コミットとpushは行わない。
 *
 * SOURCE_ROOT=/path/to/proj node tools/update-from-proj.mjs
 */
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.env.SOURCE_ROOT ?? path.join(repoRoot, '..', 'proj'));
const excludedParts = new Set(['.git', 'node_modules', 'dist']);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    ...options,
  });
}

function isExcluded(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.some((part) => excludedParts.has(part))
    || relativePath === path.join('tools', '.cache')
    || relativePath.startsWith(`${path.join('tools', '.cache')}${path.sep}`);
}

async function collectIncluded(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const paths = new Set();
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (isExcluded(child)) continue;
    paths.add(child);
    if (entry.isDirectory()) {
      for (const nested of await collectIncluded(root, child)) paths.add(nested);
    }
  }
  return paths;
}

async function copyIncluded(sourceRoot, targetRoot, relative = '') {
  const entries = await readdir(path.join(sourceRoot, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (isExcluded(child)) continue;
    const source = path.join(sourceRoot, child);
    const target = path.join(targetRoot, child);
    if (entry.isDirectory()) {
      await mkdir(target, { recursive: true });
      await copyIncluded(sourceRoot, targetRoot, child);
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true, preserveTimestamps: true });
    }
  }
}

async function removeStale(targetRoot, allowed, relative = '') {
  const entries = await readdir(path.join(targetRoot, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (isExcluded(child)) continue;
    const target = path.join(targetRoot, child);
    if (!allowed.has(child)) {
      await rm(target, { recursive: true, force: true });
      console.log(`削除   ${child}`);
      continue;
    }
    if (entry.isDirectory()) await removeStale(targetRoot, allowed, child);
  }
}

async function main() {
  if (!existsSync(sourceRoot)) {
    throw new Error(`編集用ソースが見つかりません: ${sourceRoot}\nSOURCE_ROOT=/path/to/proj を指定して再実行してください。`);
  }
  if (!existsSync(path.join(repoRoot, '.git'))) {
    throw new Error(`Gitリポジトリではありません: ${repoRoot}`);
  }

  const dirty = run('git', ['status', '--porcelain']).trim();
  if (dirty) {
    console.error('エラー: 作業ツリーに未コミットの変更があります。先にコミットまたは退避してください。');
    process.stdout.write(`${dirty}\n`);
    process.exit(1);
  }

  console.log('[1/5] リモートの更新を早送りで取得します');
  run('git', ['pull', '--ff-only'], { stdio: 'inherit' });

  console.log(`[2/5] 編集用ソースを同期します: ${sourceRoot}`);
  const allowed = await collectIncluded(sourceRoot);
  await copyIncluded(sourceRoot, repoRoot);
  await removeStale(repoRoot, allowed);
  console.log('同期   完了');

  console.log('[3/5] 空白エラーを検査します');
  run('git', ['diff', '--check'], { stdio: 'inherit' });

  console.log('[4/5] 公開用ファイルをビルドします');
  const auditFile = path.join(repoRoot, 'tools', 'mooch-audit.md');
  const backupDir = await mkdtemp(path.join(os.tmpdir(), 'eorzean-fish-guide-'));
  const auditBackup = path.join(backupDir, 'mooch-audit.md');
  const auditExisted = existsSync(auditFile);
  if (auditExisted) await cp(auditFile, auditBackup, { force: true });
  try {
    run('npm', ['run', 'build'], { stdio: 'inherit' });
  } finally {
    if (auditExisted && existsSync(auditBackup)) {
      await cp(auditBackup, auditFile, { force: true });
    } else if (existsSync(auditFile)) {
      await rm(auditFile, { force: true });
    }
    await rm(backupDir, { recursive: true, force: true });
  }

  console.log('[5/5] コミット対象の差分を表示します');
  run('git', ['status', '--short'], { stdio: 'inherit' });
  run('git', ['diff', '--stat'], { stdio: 'inherit' });
  console.log('\n確認後、次のコマンドで公開してください。');
  console.log('git add -A && git diff --cached --stat && git commit -m "更新内容" && git push');
}

main().catch((error) => {
  console.error(`エラー: ${error.message}`);
  process.exit(1);
});
