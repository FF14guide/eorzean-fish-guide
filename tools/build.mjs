#!/usr/bin/env node
/**
 * ヌシ図鑑 — データビルダー
 *
 * コミュニティが公開しているオープンデータを取得し、
 * サイトが読む単一の JSON (data/fishing.json) に正規化する。
 *
 *   node tools/build.mjs            通常ビルド（キャッシュがあれば使う）
 *   node tools/build.mjs --refresh  ソースを再ダウンロード
 *
 * 取得元:
 *   - FFXIV Teamcraft (MIT)   釣り場ごとの魚リスト、全アイテム名
 *   - FFX|V Fish Tracker      出現条件・エサ・引き・フッキング・天候・伝承録
 *   - bite-times.json         ヒットタイム（このリポジトリで管理する自前データ）
 *
 * パッチ後はこれを流すだけで釣り場と魚が追従する。
 */

import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const REFRESH = process.argv.includes('--refresh');
// 公開先のURL。OGP・canonical・sitemap に使う。
// 例: SITE_URL=https://fish.example.com node tools/build.mjs
const SITE_URL = (process.env.SITE_URL ?? '').replace(/\/$/, '');

const TC = 'https://raw.githubusercontent.com/ffxiv-teamcraft/ffxiv-teamcraft/staging/libs/data/src/lib/json';
const FT = 'https://raw.githubusercontent.com/icykoneko/ff14-fish-tracker-app/master';
// ゲームから吸い出したシートのミラー。XIVAPI を直接叩かなくても同じ内容が手に入る。
const DM = 'https://raw.githubusercontent.com/xivapi/ffxiv-datamining/master/csv';
// オーシャンフィッシングの伝説魚・時間限定魚。ゲームデータには時間帯が入っていないため、
// StreamDeck プラグイン（momokotomoko）が持っている一覧を借りる。
const OF = 'https://raw.githubusercontent.com/momokotomoko/ffxivStreamDeckOceanFishingPlugin/master'
  + '/Sources/com.elgato.ffxivoceanfishing.sdPlugin';
// AutoHook（Dalamud プラグイン / BSD 3-Clause）が銛の魚影サイズと速さを持っている。
// ゲームデータにも他のコミュニティデータにも無い情報なので、ここから借りる。
const AH = 'https://raw.githubusercontent.com/PunishXIV/AutoHook/main/AutoHook/Data/FishData';
// Ice's Cosmic Exploration（GPL-3.0）はコスモのミッションごとに AutoHook のプリセットを持っている。
// そこにエサと対象魚が入っているので、コスモ唯一のデータ源として使う。
const ICE = 'https://raw.githubusercontent.com/LeontopodiumNivale14/Ices-Cosmic-Exploration/Main-Branch'
  + '/ICE/Utilities/GatheringHelper';

const SOURCES = {
  'fishing-spots.json': `${TC}/fishing-spots.json`,
  'items.json': `${TC}/items.json`,
  'places.json': `${TC}/places.json`,
  'fish-parameter.json': `${TC}/fish-parameter.json`,
  'item-icons.json': `${TC}/item-icons.json`,
  'maps.json': `${TC}/maps.json`,
  'collectables.json': `${TC}/collectables.json`,
  'ff14fish-data.js': `${FT}/js/app/data.js`,
  'SpearfishingItem.csv': `${DM}/ja/SpearfishingItem.csv`,
  'SpearfishingNotebook.csv': `${DM}/en/SpearfishingNotebook.csv`,
  'GatheringPointBase.csv': `${DM}/en/GatheringPointBase.csv`,
  'FishParameterSheet.csv': `${DM}/ja/FishParameter.csv`,
  'IKDRoute_ja.csv': `${DM}/ja/IKDRoute.csv`,
  'IKDRoute_en.csv': `${DM}/en/IKDRoute.csv`,
  'IKDRoute_de.csv': `${DM}/de/IKDRoute.csv`,
  'IKDRoute_fr.csv': `${DM}/fr/IKDRoute.csv`,
  'FishParameter_en.csv': `${DM}/en/FishParameter.csv`,
  'SpearfishingItem_en.csv': `${DM}/en/SpearfishingItem.csv`,
  'IKDSpot.csv': `${DM}/en/IKDSpot.csv`,
  'IKDRouteTable.csv': `${DM}/en/IKDRouteTable.csv`,
  'TerritoryType.csv': `${DM}/en/TerritoryType.csv`,
  'ExVersion_ja.csv': `${DM}/ja/ExVersion.csv`,
  'ExVersion_en.csv': `${DM}/en/ExVersion.csv`,
  'ExVersion_de.csv': `${DM}/de/ExVersion.csv`,
  'ExVersion_fr.csv': `${DM}/fr/ExVersion.csv`,
  'ocean-indigo.json': `${OF}/oceanFishingDatabase%20-%20Indigo%20Route.json`,
  'ocean-ruby.json': `${OF}/oceanFishingDatabase%20-%20Ruby%20Route.json`,
  'IKDFishParam.csv': `${DM}/en/IKDFishParam.csv`,
  'autohook-fish.json': `${AH}/fish_list.json`,
  'autohook-sources.json': `${AH}/fishing-sources.json`,
  'ice-sinus.cs': `${ICE}/Fishing_Sinus.cs`,
  'ice-phaenna.cs': `${ICE}/Fishing_Phaenna.cs`,
  'ice-oizys.cs': `${ICE}/Fishing_Oizys.cs`,
  'ice-aux.cs': `${ICE}/Fishing_Aux.cs`,
  'WKSMissionUnit_ja.csv': `${DM}/ja/WKSMissionUnit.csv`,
  'WKSMissionUnit_en.csv': `${DM}/en/WKSMissionUnit.csv`,
  'IKDContentBonus_ja.csv': `${DM}/ja/IKDContentBonus.csv`,
  'IKDContentBonus_en.csv': `${DM}/en/IKDContentBonus.csv`,
  'Recipe.csv': `${DM}/en/Recipe.csv`,
  'GCSupplyDuty.csv': `${DM}/en/GCSupplyDuty.csv`,
  'GatheringLeve.csv': `${DM}/en/GatheringLeve.csv`,
};

/**
 * オーシャンフィッシングの運行位相。
 * 便は UTC の 2 時間ちょうどごとに出る。144 便で 12 日かけて一周する。
 *
 *   chunk = floor(unix秒 / 7200)
 *   航路  = IKDRouteTable[(chunk + PHASE) % 144]
 *
 * PHASE は、独立した2つのコミュニティ実装（proyebat の計算機と
 * momokotomoko の StreamDeck プラグイン）が持つ運行表を、ゲームの
 * IKDRouteTable と突き合わせて求めたもの。両者はオフセットも回転量も
 * 違うのに、ゲームの表に対しては揃って 41 になる。
 * もし将来ズレたら、ここだけ直せばよい。
 */
const OCEAN_PHASE = 41;

const log = (...a) => console.log('·', ...a);

async function fetchSource(name, url) {
  const dest = path.join(CACHE, name);
  if (!REFRESH && existsSync(dest)) {
    log(`cache  ${name}`);
    return readFile(dest, 'utf8');
  }
  log(`fetch  ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  await mkdir(CACHE, { recursive: true });
  await writeFile(dest, text);
  return text;
}

/** 1行目がヘッダの CSV を、引用符を尊重して行オブジェクトの配列にする */

/** 1秒刻みのヒストグラムを、こちらの 0.5 秒刻み・base36 形式に詰め直す */
function packHist(hist) {
  const secs = Object.keys(hist).map(Number).sort((a, b) => a - b);
  if (!secs.length) return null;
  const start = Math.round(secs[0] / 0.5);
  const end = Math.round(secs[secs.length - 1] / 0.5);
  const peak = Math.max(...Object.values(hist));
  const vals = [];
  for (let bin = start; bin <= end; bin++) {
    const sec = bin * 0.5;
    const v = hist[sec] ?? hist[Math.floor(sec)] ?? 0;
    vals.push(Math.round((v / peak) * 35).toString(36));
  }
  return `${start}:${vals.join('')}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => {
    const o = {};
    head.forEach((h, i) => (o[h] = r[i]));
    return o;
  });
}

/**
 * ff14fish の data.js は `const DATA = {...}` という JS リテラル。
 * トップレベルのキーが引用符なしなので JSON.parse は通らない。
 * 副作用のない純粋なデータ定義なので、隔離した関数として評価する。
 */
function parseFishTracker(src) {
  return new Function(`${src}; return DATA;`)();
}

// ─── 引き / フッキングの日本語表記 ──────────────────────────────
const TUG_JA = { light: '！', medium: '！！', heavy: '！！！' };
const TUG_RANK = { light: 1, medium: 2, heavy: 3 };
// 実際のアクション名。「パワフル」だけだと何のことか分からないので略さない。
// 日本語版の正式名称は「ストロングフッキング」。「パワフル」というアクションは存在しない。
// （Action.csv: 4103 ストロングフッキング / 4179 プレシジョンフッキング）
const HOOKSET = {
  Precision: { ja: 'プレシジョンフッキング', en: 'Precision Hookset', de: 'Präziser Anhieb', fr: 'Ferrage précise', icon: '001116' },
  Powerful:  { ja: 'ストロングフッキング',   en: 'Powerful Hookset', de: 'Kräftiger Anhieb', fr: 'Ferrage puissante', icon: '001115' },
};
const LURE = {
  Modest:    { ja: 'モデストルアー',   en: 'Modest Lure',    de: 'Zurückhaltender Köder', fr: 'Leurre modeste' },
  Ambitious: { ja: 'アンビシャスルアー', en: 'Ambitious Lure', de: 'Ehrgeiziger Köder',     fr: 'Leurre ambitieux' },
};

async function main() {
  const raw = {};
  await Promise.all(Object.entries(SOURCES).map(async ([n, u]) => { raw[n] = await fetchSource(n, u); }));

  const tcSpots = JSON.parse(raw['fishing-spots.json']);
  const items = JSON.parse(raw['items.json']);
  const places = JSON.parse(raw['places.json']);
  const fishParam = JSON.parse(raw['fish-parameter.json']);
  const itemIcons = JSON.parse(raw['item-icons.json']);
  const mapsAll = JSON.parse(raw['maps.json']);
  const D = parseFishTracker(raw['ff14fish-data.js']);

  const LANGS = ['ja', 'en', 'de', 'fr'];
  const ikdRoute = {
    ja: parseCsv(raw['IKDRoute_ja.csv']),
    en: parseCsv(raw['IKDRoute_en.csv']),
    de: parseCsv(raw['IKDRoute_de.csv']),
    fr: parseCsv(raw['IKDRoute_fr.csv']),
  };
  const ikdRouteEn = ikdRoute.en;
  const ikdSpot = parseCsv(raw['IKDSpot.csv']);
  // 航路の寄港地（通常＋幻海流）だけが本当のオーシャンフィッシング
  const oceanMain = new Set(ikdSpot.map((r) => Number(r.SpotMain)).filter(Boolean));
  const oceanSub = new Set(ikdSpot.map((r) => Number(r.SpotSub)).filter(Boolean));
  // Teamcraft が特殊コンテンツ用に割り当てる合成ID。通常の釣り場と混ざらないよう境界にする。
  const SPECIAL_ID_FROM = 10000;
  // 航路のどちら側の寄港地か。IKDRoute の 1-12 が近海、13 以降が遠洋。
  const spotById2 = new Map(ikdSpot.map((r) => [r['#'], r]));
  const sideOfSpot = new Map();
  for (const r of ikdRoute.en) {
    const rid = Number(r['#']);
    if (!rid) continue;
    const side = rid <= 12 ? 'near' : 'far';
    for (const k of [0, 1, 2]) {
      const sp = spotById2.get(r[`Spot[${k}]`]);
      for (const v of [Number(sp?.SpotMain), Number(sp?.SpotSub)]) {
        if (v && !sideOfSpot.has(v)) sideOfSpot.set(v, side);
      }
    }
  }
  const routeSide = (id) => sideOfSpot.get(id) ?? 'near';

  const exOfSpot = (id, territoryId, placeId, zoneId) => {
    if (oceanMain.has(id) || oceanSub.has(id)) return OCEAN_EX;
    const sp = id >= SPECIAL_ID_FROM ? specialOf(zoneId) : null;
    if (sp) return sp.ex;
    if (territoryId != null && exOfTerritory.has(territoryId)) return exOfTerritory.get(territoryId);
    if (placeId != null && exOfPlace.has(Number(placeId))) return exOfPlace.get(Number(placeId));
    return 0;
  };
  const ikdTable = parseCsv(raw['IKDRouteTable.csv']);
  // 釣り場がどの拡張のものかは TerritoryType.ExVersion で分かる
  const territories = parseCsv(raw['TerritoryType.csv']);
  const exOfTerritory = new Map(territories.map((r) => [Number(r['#']), Number(r.ExVersion)]));
  // 銛の釣り場は Teamcraft に無く自前で組み立てるので、地図は territory から引く
  const mapOfTerritory = new Map(territories.map((r) => [Number(r['#']), Number(r.Map)]).filter(([, m]) => m));
  // territory_id が分からない釣り場のために、地名からも拡張を引けるようにしておく
  const exOfPlace = new Map();
  for (const r of territories) {
    const pn = Number(r.PlaceName);
    if (!pn || exOfPlace.has(pn)) continue;
    exOfPlace.set(pn, Number(r.ExVersion));
  }
  const OCEAN_EX = -1;    // オーシャンフィッシングは拡張で括れないので独立させる

  // Teamcraft は特殊コンテンツの釣り場をすべて「ディアデム諸島」に入れてしまうので、
  // data/spot-groups.json の振り分け表で正しいグループに戻す。
  let groupCfg = { groups: {}, rules: [] };
  try {
    groupCfg = JSON.parse(await readFile(path.join(ROOT, 'data', 'spot-groups.json'), 'utf8'));
  } catch { /* 無くてよい */ }
  const groupIds = {};                       // 'diadem' → -2, 'island' → -3 …
  Object.keys(groupCfg.groups ?? {}).forEach((k, i) => { groupIds[k] = -2 - i; });
  /** 釣り場の zoneId から、特別なグループとエリア名を引く */
  function specialOf(zoneId) {
    const z = Number(zoneId);
    if (!z) return null;
    for (const r of groupCfg.rules ?? []) {
      const hit = r.zone != null ? z === r.zone : z >= r.from && z <= r.to;
      if (!hit) continue;
      if (r.expansion != null) return { ex: r.expansion, area: r.area ?? null };
      return { ex: groupIds[r.group], area: r.area ?? null };
    }
    return null;
  }
  const exRows = { ja: parseCsv(raw['ExVersion_ja.csv']), en: parseCsv(raw['ExVersion_en.csv']),
                   de: parseCsv(raw['ExVersion_de.csv']), fr: parseCsv(raw['ExVersion_fr.csv']) };
  const spearItems = parseCsv(raw['SpearfishingItem.csv']);
  const spearNotes = parseCsv(raw['SpearfishingNotebook.csv']);
  const gpBases = parseCsv(raw['GatheringPointBase.csv']);
  const fishSheet = parseCsv(raw['FishParameterSheet.csv']);

  // 銛：採集ポイント → SpearfishingItem 行 → 実際のアイテム
  const spearByRow = new Map(spearItems.map((r) => [r['#'], r]));
  const gpbItems = new Map(gpBases.map((r) => [
    Number(r['#']),
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => r[`Item[${i}]`]).filter((v) => v && v !== '0'),
  ]));

  // 釣り手帳の説明文。日本語と英語だけ（4言語ぶん持つとデータが倍近くなるため）
  const fishDesc = new Map();
  const addDesc = (rows, key, lang) => {
    for (const r of rows) {
      const id = Number(r.Item);
      if (!id || !r[key]) continue;
      const cur = fishDesc.get(id) ?? {};
      cur[lang] = r[key];
      fishDesc.set(id, cur);
    }
  };
  addDesc(fishSheet, 'Text', 'ja');
  addDesc(parseCsv(raw['FishParameter_en.csv']), 'Text', 'en');
  addDesc(spearItems, 'Description', 'ja');
  addDesc(parseCsv(raw['SpearfishingItem_en.csv']), 'Description', 'en');

  // ヒットタイム（tools/import-bite-times.mjs が作る、または手書き）
  let biteTimes = {};
  let biteFishStats = {};
  let biteMeta = null;
  const btPath = path.join(ROOT, 'data', 'bite-times.json');
  try {
    await access(btPath);
    const bt = JSON.parse(await readFile(btPath, 'utf8'));
    biteTimes = bt.records ?? {};
    biteFishStats = bt.fishStats ?? {};
    biteMeta = bt.meta ?? null;
    log(`bite   ${Object.keys(biteTimes).length} 件のヒットタイム記録`);
  } catch {
    log('bite   ヒットタイム記録なし（tools/import-bite-times.mjs で取り込める）');
  }

  // ─── 名前解決 ────────────────────────────────────────────────
  // アイコンは XIVAPI v2 のアセットパス（Teamcraft が持っている対応表をそのまま使う）
  const iconOf = (id) => itemIcons[id] ?? null;
  /** {ja,en,de,fr} を返す。欠けている言語は英語→日本語の順で埋める */
  const fill = (o) => {
    const base = o.en || o.ja || Object.values(o).find(Boolean) || '?';
    const out = {};
    for (const l of LANGS) out[l] = o[l] || base;
    return out;
  };
  const nameOf = (id) => {
    const ft = D.ITEMS[id];
    if (ft) return { n: fill({ ja: ft.name_ja, en: ft.name_en, de: ft.name_de, fr: ft.name_fr }), icon: iconOf(id) };
    const tc = items[id];
    if (tc) return { n: fill(tc), icon: iconOf(id) };
    const s = `#${id}`;
    return { n: { ja: s, en: s, de: s, fr: s }, icon: iconOf(id) };
  };
  const placeN = (id) => (places[id] ? fill(places[id]) : null);
  const placeName = (id) => placeN(id)?.ja ?? null;

  // ─── コスモエクスプローラーのミッション ────────────────
  // 釣り場そのものより「どのミッションで行くか」が実用的なので、地名にミッション名を添える。
  const missionRows = { ja: parseCsv(raw['WKSMissionUnit_ja.csv']), en: parseCsv(raw['WKSMissionUnit_en.csv']) };
  const missionsByPlace = new Map();
  for (const r of missionRows.ja) {
    const pn = Number(r.PlaceName);
    if (!pn || !r.Name) continue;
    const en = missionRows.en.find((x) => x['#'] === r['#']);
    if (!missionsByPlace.has(pn)) missionsByPlace.set(pn, []);
    missionsByPlace.get(pn).push(fill({ ja: r.Name, en: en?.Name || r.Name }));
  }

  // ─── コスモエクスプローラー：ミッションごとの釣り方 ────────
  // ICE のプリセットは base64 + gzip で埋め込まれている。展開してエサと対象魚を取り出す。
  const missionFishing = {};
  let iceMissions = 0;
  const PLANET = {
    'ice-sinus.cs': { ja: 'シヌス・アルドルム', en: 'Sinus Ardorum' },
    'ice-phaenna.cs': { ja: 'ファエンナ', en: 'Phaenna' },
    'ice-oizys.cs': { ja: 'オイジュス', en: 'Oizys' },
    'ice-aux.cs': { ja: 'アウクセシア', en: 'Auxesia' },
  };
  for (const key of ['ice-sinus.cs', 'ice-phaenna.cs', 'ice-oizys.cs', 'ice-aux.cs']) {
    const src = raw[key];
    if (!src) continue;
    // FishingPreset[番号] … "AH6_……" の組を素直に拾う
    for (const chunk of src.split('FishingPreset[').slice(1)) {
      const id = chunk.slice(0, chunk.indexOf(']'));
      const at = chunk.indexOf('"AH6_');
      if (!/^\d+$/.test(id) || at < 0 || at > 120) continue;
      const b64 = chunk.slice(at + 5, chunk.indexOf('"', at + 5));
      try {
        const j = JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
        // どのエサで、どの引きを、どのフッキングで獲るか
        const HOOK_ACTION = { 4179: 'Precision', 4103: 'Powerful', 296: 'Normal', 26871: 'Stellar' };
        const TUG_KEY = { PatienceWeak: 1, PatienceStrong: 2, PatienceLegendary: 3 };
        const steps = [];
        for (const b of j.ListOfBaits ?? []) {
          if (!b.Enabled) continue;
          const baitId = Number(b.BaitFish?.Id);
          if (!(baitId > 0)) continue;
          const nh = b.NormalHook ?? {};
          const tugs = [];
          for (const [key, rank] of Object.entries(TUG_KEY)) {
            const cfg = nh[key];
            if (!cfg?.HooksetEnabled) continue;
            tugs.push({
              tug: rank,
              hookset: HOOK_ACTION[cfg.HooksetType] ?? null,
              // 秒数指定があるものだけ拾う（多くは指定なし）
              min: cfg.PrecisionHookTypeMin || cfg.PowerfulHookTypeMin || cfg.NormalHookTypeMin || null,
              max: cfg.PrecisionHookTypeMax || cfg.PowerfulHookTypeMax || cfg.NormalHookTypeMax || null,
            });
          }
          steps.push({
            bait: baitId,
            tugs,
            double: !!nh.UseDoubleHook,
            triple: !!nh.UseTripleHook,
            timeout: nh.TimeoutMax || null,
          });
        }
        const baits = steps.map((x) => x.bait);
        const fishes = (j.ListOfFish ?? []).map((x) => Number(x.Fish?.Id)).filter(Boolean);
        // 魚ごとの立ち回り。セイムキャスト＝当たりを引いたら同じ魚を狙い続ける指示。
        const targets = (j.ListOfFish ?? []).filter((x) => x.Enabled).map((x) => {
          const acts = [];
          if (x.IdenticalCast?.Enabled) acts.push('identical');   // セイムキャスト
          if (x.SurfaceSlap?.Enabled) acts.push('slap');          // 撒き餌
          if (x.Mooch?.Enabled) acts.push('mooch');               // 泳がせ
          if (x.SparefulHand?.Enabled) acts.push('spare');
          if (x.Multihook?.Enabled) acts.push('multi');
          const nh = x.NormalHook ?? {};
          if (nh.UseDoubleHook) acts.push('double');
          if (nh.UseTripleHook) acts.push('triple');
          return { id: Number(x.Fish?.Id), acts };
        }).filter((x) => x.id);
        if (!baits.length && !fishes.length) continue;
        missionFishing[id] = { baits, fishes, targets, steps, planet: PLANET[key] };
        iceMissions++;
      } catch { /* 壊れているものは飛ばす */ }
    }
  }
  if (iceMissions) log(`ice    コスモのミッション ${iceMissions} 件から釣り方を取得`);

  // ミッションIDから釣り場を割り出し、コスモの釣り場はミッション名で見せる
  const missionPlace = new Map();
  for (const r of missionRows.ja) {
    const pn = Number(r.PlaceName);
    if (pn && r.Name) missionPlace.set(r['#'], pn);
  }
  const fishingMissionsByPlace = new Map();
  // ランクはゲーム内の表記に合わせる（LevelGroup 1〜6 → D/C/B/A/EX/EX+）
  const RANK_LABEL = { 1: 'D', 2: 'C', 3: 'B', 4: 'A', 5: 'EX', 6: 'EX+' };
  const cosmoMissions = [];
  for (const [mid, data] of Object.entries(missionFishing)) {
    const pn = missionPlace.get(mid);
    if (!pn) continue;
    const ja = missionRows.ja.find((x) => x['#'] === mid);
    const en = missionRows.en.find((x) => x['#'] === mid);
    if (!ja?.Name) continue;
    // 名前の先頭にゲーム内のランクアイコン（私用領域の文字）が入っているので落とす。
    // ランクはバッジで別に出す。
    const strip = (x) => (x ?? '').replace(/[\uE000-\uF8FF]/g, '').trim();
    const n = fill({ ja: strip(ja.Name), en: strip(en?.Name) || strip(ja.Name) });
    if (!fishingMissionsByPlace.has(pn)) fishingMissionsByPlace.set(pn, []);
    fishingMissionsByPlace.get(pn).push({ n, ...data });
    cosmoMissions.push({
      id: Number(mid), n, place: placeN(pn), placeId: pn,
      silver: Number(ja.SilverStarRequirement) || null,
      gold: Number(ja.GoldStarRequirement) || null,
      rank: Number(ja.LevelGroup) || null,
      rankLabel: RANK_LABEL[Number(ja.LevelGroup)] ?? null,
      planet: data.planet ? fill(data.planet) : null,
      ...data,
    });
  }
  cosmoMissions.sort((a, b) => a.id - b.id);

  // ─── 釣り場 ──────────────────────────────────────────────────
  const spearIds = new Set(Object.keys(D.SPEARFISHING_SPOTS).map(Number));
  const spots = [];
  for (const s of tcSpots) {
    const ft = D.FISHING_SPOTS[s.id] || D.SPEARFISHING_SPOTS[s.id];
    const n = ft
      ? fill({ ja: ft.name_ja, en: ft.name_en, de: ft.name_de, fr: ft.name_fr })
      : placeN(s.zoneId) ?? fill({ en: `Spot ${s.id}` });
    const territoryId = ft?.territory_id ?? null;
    const wr = territoryId != null ? D.WEATHER_RATES[territoryId] : null;
    const reg = wr ? D.REGIONS[wr.region_id] : null;
    spots.push({
      id: s.id,
      n,
      // コスモは「どのミッションで行くか」が実用的なので、釣りミッションだけを添える
      zoneKey: Number(s.zoneId) || null,
      missions: fishingMissionsByPlace.get(Number(s.zoneId))?.map((m) => m.n)
        ?? missionsByPlace.get(Number(s.zoneId)) ?? null,
      // 船上や特殊エリアは地図を出しても意味がないので抑止する
      noMap: (groupCfg.noMap ?? []).includes(String(s.zoneId)) ||
             (groupCfg.noMap ?? []).includes(String(s.placeId)),
      area: (() => {
        // オーシャンフィッシングは「エンデバー号」でまとめず、近海／遠洋で分ける
        if (oceanMain.has(s.id) || oceanSub.has(s.id)) {
          return routeSide(s.id) === 'far'
            ? fill({ ja: '遠洋航路', en: 'Ruby Route', de: 'Rubinroute', fr: 'Route Rubis' })
            : fill({ ja: '近海航路', en: 'Indigo Route', de: 'Indigoroute', fr: 'Route Indigo' });
        }
        const sp = s.id >= 10000 ? specialOf(s.zoneId) : null;
        if (sp?.area) return fill(sp.area);
        // Teamcraft が親をディアデムにしてしまう合成釣り場は、自分の地名を親にも使う
        if (s.id >= 10000) return placeN(s.zoneId) ?? fill({ en: 'Unknown', ja: '不明' });
        return placeN(s.placeId) ?? fill({ en: 'Unknown', ja: '不明' });
      })(),
      region: reg ? fill({ ja: reg.name_ja, en: reg.name_en, de: reg.name_de, fr: reg.name_fr }) : null,
      territoryId,
      level: s.level ?? null,
      x: s.coords?.x ?? null,
      y: s.coords?.y ?? null,
      spear: spearIds.has(s.id),
      // 合成釣り場は mapId が実際と違うので、振り分け表の指定を優先する
      mapId: groupCfg.maps?.[s.zoneId]?.mapId ?? s.mapId ?? null,
      // ミッションのある釣り場は、その地名から座標を引き直す
      x: s.coords?.x ?? null,
      y: s.coords?.y ?? null,
      ex: exOfSpot(s.id, territoryId, s.placeId, s.zoneId),
      ocean: oceanMain.has(s.id) || oceanSub.has(s.id),
      spectral: oceanSub.has(s.id),
      fishes: s.fishes.slice(),
    });
  }
  // 銛（スピアフィッシング）の釣り場。Teamcraft の fishing-spots には入っていないので
  // SpearfishingNotebook → GatheringPointBase → SpearfishingItem の順に辿って組み立てる。
  // 釣り場IDは GatheringPointBase の行番号で、Fish Tracker 側の採番と一致する。
  const known = new Set(spots.map((s) => s.id));
  for (const note of spearNotes) {
    const baseId = Number(note.GatheringPointBase);
    if (!baseId || known.has(baseId)) continue;
    const fishes = (gpbItems.get(baseId) ?? [])
      .map((rowId) => Number(spearByRow.get(rowId)?.Item ?? 0))
      .filter(Boolean);
    if (!fishes.length) continue;
    const ft = D.SPEARFISHING_SPOTS[baseId];
    const terr = Number(note.TerritoryType) || null;
    const wr = terr != null ? D.WEATHER_RATES[terr] : null;
    const zone = wr ? D.ZONES[wr.zone_id] : null;
    const reg = wr ? D.REGIONS[wr.region_id] : null;
    spots.push({
      id: baseId,
      n: ft
        ? fill({ ja: ft.name_ja, en: ft.name_en, de: ft.name_de, fr: ft.name_fr })
        : placeN(note.PlaceName) ?? fill({ en: `Spearfishing ${baseId}` }),
      area: zone
        ? fill({ ja: zone.name_ja, en: zone.name_en, de: zone.name_de, fr: zone.name_fr })
        : fill({ en: 'Unknown', ja: '不明' }),
      region: reg ? fill({ ja: reg.name_ja, en: reg.name_en, de: reg.name_de, fr: reg.name_fr }) : null,
      territoryId: terr,
      level: Number(note.GatheringLevel) || null,
      x: null,
      y: null,
      spear: true,
      mapId: terr != null ? mapOfTerritory.get(terr) ?? null : null,
      ex: exOfSpot(baseId, terr, note.PlaceName, null),
      fishes,
    });
    known.add(baseId);
  }

  // 魚が1匹も紐づかない釣り場は落とす。
  // あわせて、上流に釣りデータがまったく無いグループ（コスモ・ディアデム）も外す。
  const dropGroups = new Set((groupCfg.drop ?? []).map((k) => groupIds[k]));
  const usableSpots = spots.filter((s) => s.fishes.length > 0 && !dropGroups.has(s.ex));
  // 中身が何も分からない釣り場（魚に条件もエサも実測も無い）は出さない
  const informative = (s) => s.missions?.length || s.fishes.some((id) => {
    const f = fish[id];
    return f && (f.hasConditions || f.baitPath.length || f.ahBite);
  });

  // ─── 魚 ──────────────────────────────────────────────────────
  const spearFishIds = new Set(spearItems.map((r) => Number(r.Item)).filter(Boolean));
  const spotOf = new Map(usableSpots.map((s) => [s.id, s]));
  const fishSpots = new Map(); // fishId -> spotId[]
  for (const s of usableSpots) {
    for (const f of s.fishes) {
      if (!fishSpots.has(f)) fishSpots.set(f, []);
      fishSpots.get(f).push(s.id);
    }
  }

  const fish = {};
  for (const [id, spotIds] of fishSpots) {
    const c = D.FISH[id];
    const p = fishParam[id];
    const n = nameOf(id);
    const entry = {
      id,
      n: n.n,
      icon: n.icon,
      spots: spotIds,
      level: p?.level ?? null,
      stars: p?.stars ?? 0,
      // 出現条件（条件が判明している魚のみ）
      startHour: c?.startHour ?? 0,
      endHour: c?.endHour ?? 24,
      weather: c?.weatherSet ?? [],
      prevWeather: c?.previousWeatherSet ?? [],
      baitPath: c?.bestCatchPath ?? [],
      predators: c?.predators ?? [],
      intuition: c?.intuitionLength ?? null,
      tug: c?.tug ?? null,
      tugJa: c?.tug ? TUG_JA[c.tug] : null,
      tugRank: c?.tug ? TUG_RANK[c.tug] : null,
      hookset: c?.hookset ? HOOKSET[c.hookset] ?? null : null,
      lure: c?.lure ? LURE[c.lure] ?? null : null,
      snagging: !!c?.snagging,
      fishEyes: !!c?.fishEyes,
      bigFish: !!c?.bigFish,
      folklore: c?.folklore && D.FOLKLORE[c.folklore]
        ? fill({
            ja: D.FOLKLORE[c.folklore].name_ja, en: D.FOLKLORE[c.folklore].name_en,
            de: D.FOLKLORE[c.folklore].name_de, fr: D.FOLKLORE[c.folklore].name_fr,
          })
        : null,
      collectable: !!c?.collectable,
      gig: c?.gig && c.gig !== 'UNKNOWN' ? c.gig : null,
      patch: c?.patch ?? null,
      desc: fishDesc.get(id) ?? null,
      spear: !!spearFishIds.has(id),
      unknownWeather: !!c?.dataMissing?.weatherRestricted,
      unknownTime: !!c?.dataMissing?.timeRestricted,
      hasConditions: !!c,
    };
    // 引き・フッキングが未収録の魚は、実測統計のほうから埋める
    const st = biteFishStats[id];
    if (st) {
      if (!entry.tug && st.tug) {
        entry.tug = st.tug;
        entry.tugJa = TUG_JA[st.tug];
        entry.tugRank = TUG_RANK[st.tug];
        entry.tugFromStats = true;
      }
      if (!entry.hookset && HOOKSET[st.hookset]) {
        entry.hookset = HOOKSET[st.hookset];
        entry.tugFromStats = true;
      }
      if (!entry.snagging && st.snagging) entry.snagging = true;
    }
    fish[id] = entry;
  }

  // ─── 銛の魚影（大きさと速さ）──────────────────────────
  // AutoHook の fish_list.json より。ゲーム内の表示と同じ 3 段階／12 段階。
  const GIG_SIZE = { 1: 'Small', 2: 'Normal', 3: 'Large' };
  const GIG_SPEED = {
    100: { ja: '超低速', en: 'Super Slow' },   150: { ja: '極低速', en: 'Extremely Slow' },
    200: { ja: '低速',   en: 'Very Slow' },    250: { ja: 'やや低速', en: 'Slow' },
    300: { ja: '普通',   en: 'Average' },      350: { ja: 'やや高速', en: 'Fast' },
    400: { ja: '高速',   en: 'Very Fast' },    450: { ja: '極高速', en: 'Extremely Fast' },
    500: { ja: '超高速', en: 'Super Fast' },   550: { ja: '最高速', en: 'Hyper Fast' },
    600: { ja: '爆速',   en: 'Mega Fast' },
  };
  let gigCount = 0;
  try {
    for (const r of JSON.parse(raw['autohook-fish.json'])) {
      const f = fish[r.ItemId];
      if (!f) continue;
      const size = GIG_SIZE[r.Size];
      const speed = GIG_SPEED[r.Speed];
      if (!size && !speed) continue;
      if (size) f.gig = size;
      if (speed) f.gigSpeed = fill(speed);
      gigCount++;
    }
    log(`gig    魚影の大きさ・速さ ${gigCount} 種`);
  } catch (e) { log(`gig    取り込み失敗: ${e.message}`); }

  // 取り出したエサを魚に反映する
  let iceBait = 0;
  for (const { baits, fishes } of Object.values(missionFishing)) {
    if (!baits.length) continue;
    for (const id of fishes) {
      const f = fish[id];
      if (!f || f.baitPath.length) continue;
      f.baitPath = [baits[0]];
      iceBait++;
    }
  }
  if (iceBait) log(`ice    エサ ${iceBait} 種を補完`);

  // ─── AutoHook の実測（エサ・引き・フッキング・ヒットタイム）────
  // Lodinn が扱っていない釣り場（ディアデムなど）の穴を埋める。
  // 既に値があるものは触らない。
  let ahBait = 0, ahTug = 0, ahBite = 0;
  try {
    // AutoHook の tug は 0=！！(medium) / 1=！！！(heavy) / 2=！(light)。
    // hookset は 1=ストロング / 2=プレシジョン。Fish Tracker と 821 種で突き合わせて確認済み。
    const AH_TUG = { 0: ['medium', 2], 1: ['heavy', 3], 2: ['light', 1] };
    const sources = JSON.parse(raw['autohook-sources.json']);
    for (const [itemId, list] of Object.entries(sources)) {
      const f = fish[itemId];
      if (!f || !list.length) continue;
      const top = list[0];
      if (!f.baitPath.length && top.bait) { f.baitPath = [top.bait]; ahBait++; }
      if (!f.tug && AH_TUG[top.tug]) {
        const [tug, rank] = AH_TUG[top.tug];
        f.tug = tug;
        f.tugRank = rank;
        f.tugJa = '！'.repeat(rank);
        ahTug++;
      }
      // AutoHook の hookset は 1=ストロング / 2=プレシジョン（Lodinn と同じ並び）
      if (!f.hookset && top.hookset) {
        f.hookset = top.hookset === 2 ? HOOKSET.Precision : HOOKSET.Powerful;
        f.tugFromStats = true;
      }
      if (top.snagging) f.snagging = true;
    }
    // ヒットタイムのヒストグラム。Lodinn が持っていない釣り場×魚だけを足す。
    // AutoHook 側は 1 秒刻み、こちらは 0.5 秒刻みなので、ビン位置を合わせて詰め直す。
    let ahHist = 0;
    for (const r of JSON.parse(raw['autohook-fish.json'])) {
      const f = fish[r.ItemId];
      if (!f) continue;
      if (r.BiteTimeMin && r.BiteTimeMax && !f.bite) {
        f.ahBite = [r.BiteTimeMin, r.BiteTimeMax];
        ahBite++;
      }
      for (const [spotId, hist] of Object.entries(r.BiteTimeHistogram ?? {})) {
        const bait = r.InitialBait || 0;
        const key = `${spotId}:${r.ItemId}:${bait}`;
        if (biteTimes[key]) continue;                 // 実測統計があるならそちらを優先
        const secs = Object.keys(hist).map(Number).sort((a, b) => a - b);
        if (!secs.length) continue;
        const total = Object.values(hist).reduce((a, b) => a + b, 0);
        if (total < 30) continue;                     // 少なすぎるものは採らない
        // 2〜98 パーセンタイルでレンジを取り、外れ値を落とす
        let acc = 0; let lo = null; let hi = secs[secs.length - 1];
        for (const sec of secs) {
          acc += hist[sec];
          if (lo == null && acc >= total * 0.02) lo = sec;
          if (acc >= total * 0.98) { hi = sec; break; }
        }
        biteTimes[key] = {
          lo: lo ?? secs[0], hi, n: total, rate: null,
          h: packHist(hist), src: 'autohook',
        };
        ahHist++;
      }
    }
    if (ahHist) log(`autohook ヒストグラム ${ahHist} 件を追加`);
    log(`autohook エサ ${ahBait} / 引き ${ahTug} / ヒットタイム ${ahBite} 種を補完`);
  } catch (e) { log(`autohook 取り込み失敗: ${e.message}`); }

  // ─── 手で補った条件 ──────────────────────────────────────
  // 上流がまだ持っていない魚（主に最新パッチのオオヌシ）を data/fish-conditions.json で補う。
  // 上流が対応したら、そちらが自動で使われるよう「上流に無いときだけ」上書きする。
  let manualCond = { fish: {} };
  try { manualCond = JSON.parse(await readFile(path.join(ROOT, 'data', 'fish-conditions.json'), 'utf8')); }
  catch { /* 無くてよい */ }
  let manualApplied = 0;
  for (const [id, c] of Object.entries(manualCond.fish ?? {})) {
    const f = fish[id];
    if (!f) { log(`cond   ID ${id} (${c.name ?? ''}) は魚に見つからず`); continue; }
    // 上流が条件を持っているなら触らない。ただしエサや直感だけの補完は通す。
    const upstreamHasCond = f.hasConditions && !f.unknownTime && !f.unknownWeather;
    if (upstreamHasCond && c.start == null && !c.weather) {
      if (c.bait && !f.baitPath.length) f.baitPath = c.bait;
      if (c.predators && !f.predators.length) f.predators = c.predators;
      if (c.intuition != null) f.intuition = c.intuition;
      if (c.note) { f.condNote = c.note; f.condManual = true; f.condVerified = c.verified !== false; }
      manualApplied++;
      continue;
    }
    if (upstreamHasCond) continue;
    if (c.start != null) { f.startHour = c.start; f.endHour = c.end ?? 24; }
    if (c.weather) f.weather = c.weather;
    if (c.prevWeather) f.prevWeather = c.prevWeather;
    if (c.bait) f.baitPath = c.bait;
    if (c.predators) f.predators = c.predators;
    if (c.intuition != null) f.intuition = c.intuition;
    if (c.lure) f.lure = LURE[c.lure] ?? null;
    f.hasConditions = true;
    f.unknownTime = false;
    f.unknownWeather = false;
    f.condManual = true;
    f.condVerified = c.verified !== false;
    if (c.note) f.condNote = c.note;
    manualApplied++;
  }
  if (manualApplied) log(`cond   手入力の条件 ${manualApplied} 種を反映`);

  // ─── 制約なしとみなす魚 ──────────────────────────────────
  // 上流の Fish Tracker は「時間や天候の制約がある魚」しか扱っていない。
  // そこに載っていないのに実測が大量にある魚は、制約なしと考えるのが自然なので、
  // 「未収録」ではなく「終日・不問」として扱う。ヌシは対象外。
  const ASSUME_FREE_CATCHES = 100;
  const catchTotal = {};
  for (const [k, r] of Object.entries(biteTimes)) {
    const fid = Number(k.split(':')[1]);
    catchTotal[fid] = (catchTotal[fid] ?? 0) + (r.n ?? 0);
  }
  let assumedFree = 0;
  for (const f of Object.values(fish)) {
    if (f.hasConditions || f.bigFish) continue;
    if ((catchTotal[f.id] ?? 0) < ASSUME_FREE_CATCHES) continue;
    f.hasConditions = true;      // 終日・天候不問として扱う
    f.condAssumed = true;        // 推定であることは残す
    f.catches = catchTotal[f.id];
    assumedFree++;
  }

  // ─── ヌシ / オオヌシ の判別 ────────────────────────────────
  // 釣り手帳の並び順で、ひとつの釣り場に大物が2匹いるとき、後ろがオオヌシ。
  // （拡張ごとの数が実際のオオヌシ数と一致することを確認済み）
  for (const s of usableSpots) {
    const bigs = s.fishes.filter((id) => fish[id]?.bigFish);
    bigs.forEach((id, i) => {
      fish[id].nushi = true;
      fish[id].oonushi = bigs.length > 1 && i === bigs.length - 1;
      fish[id].nushiSpot = s.id;
    });
  }

  // ─── エサ ────────────────────────────────────────────────────
  // bestCatchPath は「どちらでも釣れる」場合に候補を配列で持つ。ほぐして全部登録する。
  const baitIds = new Set();
  for (const f of Object.values(fish)) {
    for (const b of f.baitPath) {
      if (Array.isArray(b)) b.forEach((x) => baitIds.add(x));
      else baitIds.add(b);
    }
  }
  for (const key of Object.keys(biteTimes)) baitIds.add(Number(key.split(':')[2]));
  // コスモのミッションで使うエサ（アイテム名からしか引けないものがある）
  for (const m of Object.values(missionFishing)) for (const b of m.baits ?? []) baitIds.add(b);
  const baits = {};
  for (const id of baitIds) {
    if (!id) continue;
    const n = nameOf(id);
    baits[id] = { id, n: n.n, icon: n.icon, isFish: !!fish[id] };
  }

  // ─── 天候 ────────────────────────────────────────────────────
  const weatherTypes = {};
  for (const [id, w] of Object.entries(D.WEATHER_TYPES)) {
    // アイコン番号からアセットのパスを組み立てる（アイテムと同じ形式）
    const folder = String(Math.floor(Number(w.icon) / 1000) * 1000).padStart(6, '0');
    weatherTypes[id] = {
      n: fill({ ja: w.name_ja, en: w.name_en, de: w.name_de, fr: w.name_fr }),
      icon: w.icon ? `/api/asset?path=ui/icon/${folder}/${w.icon}_hr1.tex&format=png` : null,
    };
  }
  const weatherRates = {};
  for (const [tid, wr] of Object.entries(D.WEATHER_RATES)) {
    weatherRates[tid] = { rates: wr.weather_rates, zoneId: wr.zone_id, regionId: wr.region_id };
  }

  // コスモと蒼天街は同じ地名の釣り場が何本も並ぶので、魚をまとめて 1 本にする
  for (const groupEx of [groupIds.cosmo, groupIds.diadem]) {
    if (groupEx == null) continue;
    const merged = new Map();
    for (const sp of usableSpots.filter((x) => x.ex === groupEx)) {
      const key = sp.n.ja;
      if (!merged.has(key)) { merged.set(key, sp); continue; }
      const head = merged.get(key);
      for (const id of sp.fishes) if (!head.fishes.includes(id)) head.fishes.push(id);
      head.missions = head.missions ?? sp.missions;
      head.fishes = [...new Set(head.fishes)];
      sp.merged = true;
    }
    const n0 = usableSpots.length;
    const keep = usableSpots.filter((x) => !x.merged);
    usableSpots.length = 0; usableSpots.push(...keep);
    if (n0 !== usableSpots.length) log(`spot   同じ地名の釣り場 ${n0 - usableSpots.length} 件を統合`);
  }

  // ディアデム諸島の第二次・第三次復興は終了したコンテンツで、
  // 専用エサも入手できない。魚は残っているが釣れないので印を付ける。
  // 第二次・第三次復興は終了したコンテンツで専用エサも入手できない。魚ごと外す。
  let retired = 0;
  const retiredIds = new Set();
  for (const f of Object.values(fish)) {
    if (!/^第[二三]次復興用/.test(f.n.ja)) continue;
    retiredIds.add(f.id);
    delete fish[f.id];
    retired++;
  }
  for (const sp of usableSpots) sp.fishes = sp.fishes.filter((id) => !retiredIds.has(id));
  if (retired) log(`spot   終了したコンテンツの魚 ${retired} 種を除外`);

  // 情報が何も無い釣り場を落とす
  const before = usableSpots.length;
  const kept = usableSpots.filter(informative);
  usableSpots.length = 0;
  usableSpots.push(...kept);
  if (before !== usableSpots.length) log(`spot   情報の無い釣り場 ${before - usableSpots.length} 件を除外`);

  // ListOfFish が空のミッションは「エサだけ指定して何でも釣る」形。
  // その場合は同じ地名の釣り場にいる魚を候補として出す。
  const fishByPlace = new Map();
  for (const sp of usableSpots) {
    const pn = Number(sp.zoneKey ?? 0);
    if (!pn) continue;
    if (!fishByPlace.has(pn)) fishByPlace.set(pn, new Set());
    for (const id of sp.fishes) fishByPlace.get(pn).add(id);
  }
  const spotByZone = new Map();
  for (const sp of usableSpots) if (sp.zoneKey) spotByZone.set(sp.zoneKey, sp.id);
  for (const m of cosmoMissions) m.spotId = spotByZone.get(m.placeId) ?? null;
  for (const m of cosmoMissions) {
    if (m.fishes.length) continue;
    m.fishes = [...(fishByPlace.get(m.placeId) ?? [])];
    m.anyFish = true;
  }
  // ─── 拡張 → エリア の並び（ゲーム内の順に近づける） ────────
  const expansions = {
    [OCEAN_EX]: {
      id: OCEAN_EX,
      n: { ja: 'オーシャンフィッシング', en: 'Ocean Fishing', de: 'Ozeanfischen', fr: 'Pêche en mer' },
    },
  };
  for (const [k, g] of Object.entries(groupCfg.groups ?? {})) {
    if (!usableSpots.some((s) => s.ex === groupIds[k])) continue;   // 空の見出しは出さない
    expansions[groupIds[k]] = { id: groupIds[k], n: fill(g.n), order: g.order };
  }
  for (const r of exRows.en) {
    if (!r.Name) continue;
    const id = Number(r['#']);
    const byLang = {};
    for (const l of LANGS) byLang[l] = exRows[l].find((x) => x['#'] === r['#'])?.Name || r.Name;
    expansions[id] = { id, n: fill(byLang) };
  }

  const areaOrder = [];
  for (const s of usableSpots) {
    if (!areaOrder.some((a) => a.ja === s.area.ja && a.ex === s.ex)) {
      areaOrder.push({ ...s.area, ex: s.ex });
    }
  }
  // 拡張の若い順。オーシャンフィッシングは最後に回す
  const exRank = (e) => (e === OCEAN_EX ? 99 : expansions[e]?.order ?? e);
  areaOrder.sort((a, b) => exRank(a.ex) - exRank(b.ex));

  // ─── オーシャンフィッシング ──────────────────────────────
  // 時間帯コードは 1=夜 2=昼 3=夕（プラグイン側の寄港順と突き合わせて確認済み）
  const ikdSpotById = new Map(ikdSpot.map((r) => [r['#'], r]));
  const oceanRoutes = {};
  for (const r of ikdRouteEn) {
    if (!r.Name) continue;
    const nameByLang = {};
    for (const l of LANGS) nameByLang[l] = ikdRoute[l].find((x) => x['#'] === r['#'])?.Name || r.Name;
    const stops = [0, 1, 2].map((k) => {
      const sp = ikdSpotById.get(r[`Spot[${k}]`]);
      return {
        n: placeN(sp?.PlaceName) ?? fill({ en: '?' }),
        spotId: Number(sp?.SpotMain) || null,      // 通常
        subSpotId: Number(sp?.SpotSub) || null,    // 幻海流
        time: Number(r[`Time[${k}]`]) || 0,
      };
    });
    oceanRoutes[r['#']] = {
      id: Number(r['#']),
      n: fill(nameByLang),
      dest: stops[2].n,
      destTime: stops[2].time,
      stops,
    };
  }
  // ─── 伝説魚と時間限定魚 ─────────────────────────────────
  // 「昼のみ」「夕方のみ」といった制限はゲームデータに無いので、外から補う。
  const TIME_CODE = { night: 1, day: 2, sunset: 3 };
  const normEn = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fishByEn = new Map(Object.values(fish).map((f) => [normEn(f.n.en), f]));
  let matched = 0, unmatched = [];
  for (const key of ['ocean-indigo.json', 'ocean-ruby.json']) {
    const db = JSON.parse(raw[key]);
    for (const [group, items] of Object.entries(db.targets?.fish ?? {})) {
      for (const [name, v] of Object.entries(items)) {
        const f = fishByEn.get(normEn(name));
        if (!f) { unmatched.push(name); continue; }
        matched++;
        if (group === 'Blue Fish') f.oceanLegend = true;
        const times = new Set(f.oceanTimes ?? []);
        for (const loc of v.locations ?? []) {
          for (const t of String(loc.time ?? '').split(',')) {
            if (TIME_CODE[t]) times.add(TIME_CODE[t]);
          }
        }
        if (times.size) f.oceanTimes = [...times].sort();
      }
    }
  }
  if (unmatched.length) log(`ocean  名前が照合できなかった魚: ${unmatched.join(', ')}`);

  // 通常海域の稀少魚。ゲームデータでは伝説魚以外と区別が付かない（どちらも OceanStars 4/5・IsHidden）ので、
  // 「通常海域にいて漁師の直感が要る魚」で判定する。条件は data/fish-conditions.json 由来。
  let rares = 0;
  for (const sp of usableSpots) {
    if (!sp.ocean || sp.spectral) continue;
    for (const id of sp.fishes) {
      const f = fish[id];
      if (!f || f.oceanLegend || !f.predators?.length) continue;
      if (!f.oceanRare) { f.oceanRare = true; rares++; }
    }
  }
  log(`ocean  稀少魚 ${rares} 種`);

  // 幻海流のトリガーになる魚は、名前に「スペクトラル」「幻海」または Spectral が入る
  let triggers = 0;
  for (const sp of usableSpots) {
    if (!sp.ocean || sp.spectral) continue;      // 通常海域にいるものだけ
    for (const id of sp.fishes) {
      const f = fish[id];
      if (!f) continue;
      if (/スペクトラル|幻海/.test(f.n.ja) || /^Spectral /i.test(f.n.en)) {
        if (!f.spectralTrigger) { f.spectralTrigger = true; triggers++; }
      }
    }
  }
  log(`ocean  幻海流トリガー ${triggers} 種`);

  // ─── オーシャンのボーナス条件 ────────────────────────────
  // どの魚がどのミッション（サメ／タコ／クラゲ…）に数えられるかはゲームデータにある
  const bonusRows = { ja: parseCsv(raw['IKDContentBonus_ja.csv']), en: parseCsv(raw['IKDContentBonus_en.csv']) };
  const bonusName = new Map();
  // 称号ごとの達成条件と倍率。パーティ人数による補正版が複数あるので、素の条件を採る。
  const bonusInfo = {};
  for (const r of bonusRows.en) {
    if (!r.Objective) continue;
    const ja = bonusRows.ja.find((x) => x['#'] === r['#']);
    const n = fill({ ja: ja?.Objective || r.Objective, en: r.Objective });
    bonusName.set(r['#'], n);
    const req = ja?.Requirement ?? '';
    if (req.includes('補正発動中')) continue;
    bonusInfo[n.ja] ??= {
      n,
      multiplier: Number(r.BonusMultiplier) || 100,
      req: fill({ ja: req, en: r.Requirement ?? '' }),
    };
  }
  // 参考記事（転記はせず、リンクだけ持つ）
  let bonusGuides = { guides: {}, general: [] };
  try {
    bonusGuides = JSON.parse(await readFile(path.join(ROOT, 'data', 'ocean-guides.json'), 'utf8'));
    log(`ocean  参考記事 ${Object.values(bonusGuides.guides ?? {}).flat().length + (bonusGuides.general?.length ?? 0)} 件`);
  } catch { /* 無くてよい */ }
  for (const [k, list] of Object.entries(bonusGuides.guides ?? {})) {
    if (bonusInfo[k]) bonusInfo[k].guides = list;
  }
  const fishParamRowToItem = new Map(fishSheet.map((r) => [r['#'], Number(r.Item)]));
  for (const r of parseCsv(raw['IKDFishParam.csv'])) {
    const itemId = fishParamRowToItem.get(r.Fish);
    const f = itemId ? fish[itemId] : null;
    if (!f) continue;
    const list = [];
    for (const key of ['PartyBonus', 'IndividualBonus']) {
      const b = bonusName.get(r[key]);
      if (b) list.push({ n: b, party: key === 'PartyBonus' });
    }
    if (list.length) f.oceanBonus = list;
  }

  // 釣果点と多重フッキングの匹数は手書きのデータ（data/ocean-notes.json）から
  try {
    const notes = JSON.parse(await readFile(path.join(ROOT, 'data', 'ocean-notes.json'), 'utf8')).notes ?? {};
    let n = 0;
    for (const [id, v] of Object.entries(notes)) {
      const f = fish[id];
      if (!f) continue;
      if (v.points != null) f.oceanPoints = v.points;
      if (v.multi != null) f.oceanMulti = v.multi;
      n++;
    }
    if (n) log(`ocean  釣果点・匹数の手書きデータ ${n} 件`);
  } catch { /* 無くてよい */ }

  // 航路の高得点しやすさ（外部評価）
  let routeRanks = { ranks: {}, source: null };
  try { routeRanks = JSON.parse(await readFile(path.join(ROOT, 'data', 'ocean-routes.json'), 'utf8')); }
  catch { /* 無くてよい */ }
  for (const [id, rank] of Object.entries(routeRanks.ranks ?? {})) {
    if (oceanRoutes[id]) oceanRoutes[id].rank = rank;
  }

  const ocean = {
    phase: OCEAN_PHASE,
    table: ikdTable.map((r) => [Number(r.IndigoRoute), Number(r.RubyRoute)]),
    routes: oceanRoutes,
    bonuses: bonusInfo,
    guides: bonusGuides.general ?? [],
    rankSource: routeRanks.source ?? null,
  };

  // ─── 地図 ────────────────────────────────────────────────
  // 釣り場の位置を出すために、使っている地図の画像と縮尺だけ持っておく
  const maps = {};
  for (const sp of usableSpots) {
    const m = sp.mapId != null ? mapsAll[sp.mapId] : null;
    if (!m?.image) { sp.mapId = null; continue; }
    maps[sp.mapId] ??= { image: m.image, sizeFactor: m.size_factor ?? 100 };
  }

  // ─── 使い道 ──────────────────────────────────────────────
  // 「この魚は何に使えるか」をゲームデータから集める
  const CRAFT_JA = ['木工', '鍛冶', '甲冑', '彫金', '革細工', '裁縫', '錬金', '調理'];
  const CRAFT_EN = ['Carpenter', 'Blacksmith', 'Armorer', 'Goldsmith', 'Leatherworker', 'Weaver', 'Alchemist', 'Culinarian'];
  for (const r of parseCsv(raw['Recipe.csv'])) {
    const ct = Number(r.CraftType);
    for (let i = 0; i < 8; i++) {
      const id = Number(r[`Ingredient[${i}]`]);
      const f = id ? fish[id] : null;
      if (!f) continue;
      f.craft ??= [];
      if (!f.craft.includes(ct)) f.craft.push(ct);
    }
  }
  const collectables = JSON.parse(raw['collectables.json']);
  for (const id of Object.keys(collectables)) if (fish[id]) fish[id].collectable = true;

  // グランドカンパニー納品：SupplyData[n].Item[m] に対象アイテムが並ぶ
  let gcCount = 0;
  for (const r of parseCsv(raw['GCSupplyDuty.csv'])) {
    for (const [k, v] of Object.entries(r)) {
      if (!/^SupplyData\[\d+\]\.Item\[\d+\]$/.test(k)) continue;
      const f = fish[Number(v)];
      if (f && !f.gc) { f.gc = true; gcCount++; }
    }
  }
  // ギルドリーヴ（採集リーヴ）納品
  let leveCount = 0;
  for (const r of parseCsv(raw['GatheringLeve.csv'])) {
    for (let i = 0; i < 4; i++) {
      const f = fish[Number(r[`RequiredItem[${i}]`])];
      if (f && !f.leve) { f.leve = true; leveCount++; }
    }
  }

  const iconCount = Object.values(fish).filter((f) => f.icon).length;
  const out = {
    meta: {
      // 料理などの職種名。魚の「使い道」の表示に使う
      craftNames: CRAFT_JA.map((ja, i) => ({ ja, en: CRAFT_EN[i], de: CRAFT_EN[i], fr: CRAFT_EN[i] })),
      // ルアーのアクションアイコン（Action.csv より。1146=アンビシャス、1147=モデスト）
      hooksetIcons: {
        Precision: '/api/asset?path=ui/icon/001000/001116_hr1.tex&format=png',
        Powerful: '/api/asset?path=ui/icon/001000/001115_hr1.tex&format=png',
      },
      lureIcons: {
        Ambitious: '/api/asset?path=ui/icon/001000/001146_hr1.tex&format=png',
        Modest: '/api/asset?path=ui/icon/001000/001147_hr1.tex&format=png',
      },
      // アイコン。ICONS=off でテキストのみの表示になる。
      // 配信元を自前でミラーする場合は ICON_BASE を指定する。
      icons: process.env.ICONS !== 'off',
      iconBase: process.env.ICON_BASE ?? 'https://v2.xivapi.com',
      generatedAt: new Date().toISOString(),
      spotCount: usableSpots.length,
      fishCount: Object.keys(fish).length,
      conditionCount: Object.values(fish).filter((f) => f.hasConditions).length,
      assumedFreeCount: assumedFree,
      manualCondCount: manualApplied,
      manualCondSource: manualCond.source ?? null,
      biteTimeCount: Object.keys(biteTimes).length,
      biteSource: biteMeta?.source ?? null,
      biteImportedAt: biteMeta?.importedAt ?? null,
      biteSpots: biteMeta?.spotsWithData ?? 0,
      nushiCount: Object.values(fish).filter((f) => f.nushi).length,
      oonushiCount: Object.values(fish).filter((f) => f.oonushi).length,
      sources: [
        'FFXIV Teamcraft (MIT) — 釣り場と魚の対応、アイテム名',
        'FFX|V Fish Tracker App — 出現条件・エサ・引き・天候',
        'xivapi/ffxiv-datamining — 銛・説明文・オーシャンフィッシングの運行表',
        ...(biteMeta?.source ? ['Lodinn — ヒットタイムと釣果率の実測統計'] : []),
        'momokotomoko / StreamDeck Ocean Fishing — 伝説魚と時間限定魚',
        'PunishXIV / AutoHook (BSD 3-Clause) — 銛の魚影、エサ、ヒットタイム',
        "Ice's Cosmic Exploration (GPL-3.0) — コスモエクスプローラーの釣り方",
      ],
    },
    areaOrder,
    expansions,
    cosmoMissions,
    spots: usableSpots,
    fish,
    baits,
    weatherTypes,
    weatherRates,
    maps,
    ocean,
    bite: biteTimes,
  };

  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  const json = JSON.stringify(out);
  await writeFile(path.join(ROOT, 'data', 'fishing.json'), json);
  log(`書き出し data/fishing.json  ${(json.length / 1024 / 1024).toFixed(2)} MB`);

  // ─── 配信物 ──────────────────────────────────────────────
  // ヒットタイムは重いので本体と分ける。骨格が出てから後追いで届く。
  const tpl = await readFile(path.join(ROOT, 'app', 'index.html'), 'utf8');
  const MARK_DATA = '/*__DATA__*/null';
  const MARK_URLS = '/*__URLS__*/null';
  if (!tpl.includes(MARK_DATA)) throw new Error('app/index.html に差し込み位置がありません');

  const DIST = path.join(ROOT, 'dist');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(path.join(DIST, 'data'), { recursive: true });

  const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 10);
  const { bite, ...core } = out;
  const coreJson = JSON.stringify(core);
  const biteJson = JSON.stringify(bite);
  const coreName = `core.${hash(coreJson)}.json`;
  const biteName = `bite.${hash(biteJson)}.json`;
  await writeFile(path.join(DIST, 'data', coreName), coreJson);
  await writeFile(path.join(DIST, 'data', biteName), biteJson);

  const shell = tpl
    .replaceAll('__SITE_URL__', SITE_URL)
    .replace(MARK_URLS, JSON.stringify({ core: `data/${coreName}`, bite: `data/${biteName}` }));
  await writeFile(path.join(DIST, 'index.html'), shell);

  // 単体版：ファイルを直接開いても動くよう、全部埋め込む
  const standalone = tpl.replaceAll('__SITE_URL__', SITE_URL).replace(MARK_DATA, json);
  await writeFile(path.join(DIST, 'standalone.html'), standalone);

  // 付随ファイル
  await writeFile(path.join(DIST, '.nojekyll'), '');
  await writeFile(path.join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\n` + (SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ''));
  if (SITE_URL) {
    await writeFile(path.join(DIST, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url><loc>${SITE_URL}/</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>\n</urlset>\n`);
  } else {
    log('SITE_URL 未設定のため sitemap.xml と OGP の絶対URLは省略');
  }
  // Cloudflare Pages / Netlify 向け。ハッシュ付きなので恒久キャッシュでよい
  await writeFile(path.join(DIST, '_headers'),
    `/data/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: public, max-age=600\n`);

  const sz = (t) => `${(t.length / 1024).toFixed(0)} KB`;
  log(`書き出し dist/index.html            ${sz(shell)}`);
  log(`         dist/data/${coreName}  ${sz(coreJson)}`);
  log(`         dist/data/${biteName}  ${sz(biteJson)}`);
  log(`         dist/standalone.html         ${(standalone.length / 1024 / 1024).toFixed(2)} MB`);

  console.log(
    `\n釣り場 ${out.meta.spotCount} / 魚 ${out.meta.fishCount}` +
      `（条件判明 ${out.meta.conditionCount} / うち実測から制約なしとみなした ${assumedFree}）` +
      `\nヌシ ${out.meta.nushiCount}（うちオオヌシ ${out.meta.oonushiCount}）` +
      `\nヒットタイム ${out.meta.biteTimeCount} 件 / ${out.meta.biteSpots} 釣り場` +
      `\n引きを実測から補完 ${Object.values(fish).filter((f) => f.tugFromStats).length} 種` +
      `\n銛の釣り場 ${usableSpots.filter((s) => s.spear).length} / 説明文 ${Object.values(fish).filter((f) => f.desc).length} 種` +
      `\nアイコン ${iconCount} / ${Object.keys(fish).length} 種` +
      `\nオーシャンフィッシング 航路 ${Object.keys(oceanRoutes).length} / 運行表 ${ocean.table.length} 便` +
      `\nオーシャン 伝説魚 ${Object.values(fish).filter((f) => f.oceanLegend).length}` +
      ` / 時間限定 ${Object.values(fish).filter((f) => f.oceanTimes).length}` +
      ` / ボーナス対象 ${Object.values(fish).filter((f) => f.oceanBonus).length}` +
      ` / 称号の条件 ${Object.keys(bonusInfo).length}` +
      `\n地図 ${Object.keys(maps).length} 枚` +
      `\n用途: 素材 ${Object.values(fish).filter((f) => f.craft).length}` +
      ` / 収集品 ${Object.values(fish).filter((f) => f.collectable).length}` +
      ` / GC納品 ${gcCount} / リーヴ ${leveCount}` +
      `\n拡張別の釣り場: ${Object.values(expansions).map((e) =>
        `${e.n.ja} ${usableSpots.filter((s) => s.ex === e.id).length}`).join(' / ')}`,
  );
}

main().catch((e) => {
  console.error('ビルド失敗:', e.message);
  process.exit(1);
});
