#!/usr/bin/env node
/**
 * ヌシ・オオヌシの自動公開前検査。
 * 上流データの一時的な欠損や形式変更で、釣り方が空のまま公開されることを防ぐ。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.BIGFISH_DB_PATH ?? path.join(ROOT, 'data', 'fishing.json');
const MIN_NUSHI = 300;
const MIN_OONUSHI = 30;

function fail(messages) {
  console.error('ヌシ・オオヌシ検査に失敗しました。自動公開を停止します。');
  for (const message of messages) console.error(`- ${message}`);
  process.exit(1);
}

const db = JSON.parse(await readFile(DB_PATH, 'utf8'));
const fish = Object.values(db.fish ?? {});
const nushi = fish.filter((item) => item.nushi);
const oonushi = nushi.filter((item) => item.oonushi);
const issues = [];

if (nushi.length < MIN_NUSHI) issues.push(`ヌシ数が下限を下回りました: ${nushi.length} < ${MIN_NUSHI}`);
if (oonushi.length < MIN_OONUSHI) issues.push(`オオヌシ数が下限を下回りました: ${oonushi.length} < ${MIN_OONUSHI}`);

for (const item of nushi) {
  const name = item.n?.ja ?? item.n?.en ?? `#${item.id}`;
  if (!item.nushiSpot || !item.spots?.includes(item.nushiSpot)) issues.push(`${name}: ヌシ判定用の釣り場が不正です`);
  if (!item.baitPath?.length) issues.push(`${name}: エサ経路がありません`);
  if (!item.hookset) issues.push(`${name}: フッキング情報がありません`);
  if (!item.tug) issues.push(`${name}: 引き情報がありません`);
  if (!item.hasConditions || item.unknownTime || item.unknownWeather) issues.push(`${name}: 時間または天候の条件が未確定です`);
  // ET時間は17.5のような端数を取り、夜間帯は 18→2 のように日付をまたぐ。
  // 既存の inHourRange と同じく、開始・終了が同じなら終日として扱う。
  if (!(Number.isFinite(item.startHour) && Number.isFinite(item.endHour)
      && item.startHour >= 0 && item.startHour < 24
      && item.endHour >= 0 && item.endHour <= 24)) {
    issues.push(`${name}: ET時間帯が不正です`);
  }
  if (!Array.isArray(item.weather) || !Array.isArray(item.prevWeather)) issues.push(`${name}: 天候データの形式が不正です`);
  if (!Array.isArray(item.predators)) issues.push(`${name}: 直感用の対象魚データの形式が不正です`);
}

if (issues.length) fail(issues.slice(0, 60));

const manual = nushi.filter((item) => item.condManual).length;
const intuition = nushi.filter((item) => item.predators?.length).length;
console.log(`ヌシ検査 OK: ${nushi.length}（オオヌシ ${oonushi.length}）、直感あり ${intuition}、手入力補正 ${manual}`);
