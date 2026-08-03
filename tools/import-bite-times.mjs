#!/usr/bin/env node
/**
 * ヒットタイムの取り込み — Lodinn の釣り場別統計から
 *
 *   node tools/import-bite-times.mjs            全釣り場を取り込む
 *   node tools/import-bite-times.mjs 139 26     指定した釣り場だけ
 *
 * 取得元は Lodinn 氏が公開している釣り場ごとの集計 JSON。
 * Fisher's Intuition Bot（okuRaku/ff14-fishers-intuition-bot）の /biterates が
 * 使っているのと同じデータで、Teamcraft の Allagan Reports に集まった
 * プレイヤーの実測を集計したもの。釣り場IDもアイテムIDもゲーム内のものなので、
 * こちらのデータとそのまま突き合わせられる。
 *
 * 元データは1釣り場あたり 270KB ほどある（KDE曲線などを含むため）。
 * サイトに載せるのは要約と圧縮したヒストグラムだけにして、data/bite-times.json に書く。
 *
 * ヒストグラムのビンは 0.5 秒刻み・70本（0〜35秒）。
 * 撒き餌あり(chummed)となし(unchummed)が別々に入っている。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// GitHub Pages の実体。lodinn.github.io/assets/... と同じ中身。
const BASE = process.env.LODINN_BASE
  ?? 'https://raw.githubusercontent.com/lodinn/lodinn.github.io/gh-pages/assets/spot_data';

const BIN_SEC = 0.5;          // ヒストグラム1本あたりの秒数
const CONCURRENCY = 24;
const MIN_CATCHES = 8;        // これ未満のサンプルは統計として採らない
const MIN_HIST_CATCHES = 40;  // 分布そのものを保存する最低サンプル数

const log = (...a) => console.log('·', ...a);

/**
 * ヒストグラムを "開始ビン:値の並び" という文字列に詰める。
 * 値はピークを 35 とした 0〜35 の相対値で、1ビンあたり base36 の1文字。
 * スパークラインを描くのに十分な精度で、JSON配列より 4 倍ほど小さい。
 */
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
function packHistogram(bins) {
  if (!bins?.length) return null;
  const peak = Math.max(...bins);
  if (peak <= 0) return null;
  const q = bins.map((v) => Math.round((v / peak) * 35));   // 先に量子化してから端を削る
  let s = q.findIndex((v) => v > 0);
  let e = q.length - 1;
  while (e > s && q[e] === 0) e--;
  if (s < 0 || e <= s) return null;
  let str = '';
  for (let i = s; i <= e; i++) str += B36[q[i]];
  return `${s}:${str}`;
}

/** ヒストグラムから、全体の n% を含む範囲を秒で返す */
function rangeFrom(bins, coverage = 0.98) {
  if (!bins?.length) return null;
  const total = bins.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const cut = (total * (1 - coverage)) / 2;
  let acc = 0, lo = null, hi = null;
  for (let i = 0; i < bins.length; i++) {
    acc += bins[i];
    if (lo === null && acc >= cut) lo = i * BIN_SEC;
    if (acc >= total - cut) { hi = (i + 1) * BIN_SEC; break; }
  }
  return lo === null || hi === null ? null : [lo, hi];
}

async function fetchSpot(id) {
  const res = await fetch(`${BASE}/${id}.json`);
  if (!res.ok) return null;
  return res.json();
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

/**
 * 対象の釣り場ID。生成済みのデータがあればそこから、
 * 無ければ Teamcraft の釣り場一覧から直接取る。
 * こうしておくと data/fishing.json をリポジトリに置かなくてよい。
 */
async function allSpotIds() {
  try {
    const db = JSON.parse(await readFile(path.join(ROOT, 'data', 'fishing.json'), 'utf8'));
    return db.spots.map((s) => s.id);
  } catch {
    log('data/fishing.json が無いので Teamcraft から釣り場一覧を取得');
    const url = 'https://raw.githubusercontent.com/ffxiv-teamcraft/ffxiv-teamcraft'
      + '/staging/libs/data/src/lib/json/fishing-spots.json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`釣り場一覧の取得に失敗: HTTP ${res.status}`);
    return (await res.json()).map((s) => s.id);
  }
}

async function main() {
  const argIds = process.argv.slice(2).map(Number).filter(Boolean);
  const spotIds = argIds.length ? argIds : await allSpotIds();

  log(`${spotIds.length} 釣り場を確認`);

  const records = {};
  const fishStats = {};       // Lodinn 側にしかない引き・フッキングを拾う
  let found = 0, missing = 0, bytes = 0;

  await pool(spotIds, CONCURRENCY, async (spotId, idx) => {
    if (idx % 100 === 0 && idx) log(`  ${idx}/${spotIds.length} …`);
    let data;
    try { data = await fetchSpot(spotId); } catch { data = null; }
    if (!data?.rates) { missing++; return; }
    found++;
    bytes += JSON.stringify(data).length;

    // 引き・フッキング・スナッグ（こちらに無い魚のぶんを補完する）
    for (const [fid, f] of Object.entries(data.fish ?? {})) {
      fishStats[fid] ??= {
        tug: [null, 'light', 'medium', 'heavy'][f.tug] ?? null,
        hookset: f.hookset === 1 ? 'プレシジョン' : f.hookset === 2 ? 'パワフル' : null,
        snagging: !!f.snagging,
      };
    }

    for (const perPatch of Object.values(data.rates)) {
      for (const [baitId, perBait] of Object.entries(perPatch)) {
        const baitTotal = data.bait?.[baitId]?.total ?? 0;
        for (const [fishId, r] of Object.entries(perBait)) {
          if (!r || (r.catches ?? 0) < MIN_CATCHES) continue;
          const bt = data.bait?.[baitId]?.bitetimes?.[fishId];
          const unchummed = bt?.unchummed_bins;
          const chummed = bt?.chummed_bins;

          // 元データの bitetime_low / high は外れ値をそのまま含むことがある
          // （「0〜104秒」のような値になる）。分布があるならそちらの 2〜98% を採る。
          const range = unchummed?.some((v) => v > 0) ? rangeFrom(unchummed, 0.96) : null;
          const lo = range ? range[0] : r.bitetime_low;
          const hi = range ? range[1] : r.bitetime_high;
          const chumRange = chummed?.some((v) => v > 0) ? rangeFrom(chummed, 0.96) : null;

          const rec = {
            lo: lo ?? null,
            hi: hi ?? null,
            n: Math.round(r.catches),
            miss: Math.round(r.bayesian_misses ?? 0),
          };
          if (baitTotal > 0) {
            rec.rate = Math.round(((r.catches + (r.bayesian_misses ?? 0)) / baitTotal) * 1000) / 10;
          }
          if (chumRange) { rec.clo = chumRange[0]; rec.chi = chumRange[1]; }
          if (r.catches >= MIN_HIST_CATCHES) {
            const h = packHistogram(unchummed);
            if (h) rec.h = h;
            const ch = packHistogram(chummed);
            if (ch) rec.ch = ch;
          }
          records[`${spotId}:${fishId}:${baitId}`] = rec;
        }
      }
    }
  });

  const out = {
    $comment: [
      'ヒットタイム。tools/import-bite-times.mjs が生成する（手で足しても良い）。',
      'キーは "釣り場ID:魚ID:エサID"。',
      'lo / hi = 撒き餌なしのヒット秒数レンジ（分布の 2〜98%）。clo / chi = 撒き餌ありのレンジ。',
      'n = 釣れた回数、miss = 推定の空振り回数、rate = そのエサでの釣果率(%)。',
      'h / ch = ヒット秒数の分布。"開始ビン:値" 形式で、値は base36 の1文字（ピーク=z）、1ビン 0.5 秒。',
    ],
    meta: {
      source: 'Lodinn — FFXIV fishing statistics（Teamcraft の Allagan Reports をもとに集計）',
      importedAt: new Date().toISOString(),
      spotsWithData: found,
      spotsWithoutData: missing,
    },
    fishStats,
    records,
  };

  // 手書きの実測があれば上書きで混ぜる（data/bite-times.manual.json）
  try {
    const manual = JSON.parse(await readFile(path.join(ROOT, 'data', 'bite-times.manual.json'), 'utf8'));
    const rec = manual.records ?? {};
    Object.assign(records, rec);
    if (Object.keys(rec).length) log(`手書きの記録 ${Object.keys(rec).length} 件を反映`);
  } catch { /* 無くてよい */ }

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(path.join(ROOT, 'data', 'bite-times.json'), json);

  out.meta.maxSec = Math.max(...Object.values(records).map((r) => r.hi ?? 0));
  await writeFile(path.join(ROOT, 'data', 'bite-times.json'), JSON.stringify(out));
  const withHist = Object.values(records).filter((r) => r.h).length;
  console.log(
    `\n取得元 ${(bytes / 1024 / 1024).toFixed(0)} MB を圧縮 → ${(json.length / 1024 / 1024).toFixed(2)} MB` +
    `\n釣り場 ${found}（データなし ${missing}）` +
    `\n釣り場×魚×エサ ${Object.keys(records).length} 件（うち分布つき ${withHist} 件）` +
    `\n引き・フッキングの補完候補 ${Object.keys(fishStats).length} 種` +
    `\n\n次: node tools/build.mjs でサイトに反映`,
  );
}

main().catch((e) => { console.error('取り込み失敗:', e.message); process.exit(1); });
