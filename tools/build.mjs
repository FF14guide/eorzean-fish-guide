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

const SOURCES = {
  'fishing-spots.json': `${TC}/fishing-spots.json`,
  'items.json': `${TC}/items.json`,
  'places.json': `${TC}/places.json`,
  'fish-parameter.json': `${TC}/fish-parameter.json`,
  'item-icons.json': `${TC}/item-icons.json`,
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
const HOOKSET_JA = { Precision: 'プレシジョン', Powerful: 'パワフル' };

async function main() {
  const raw = {};
  await Promise.all(Object.entries(SOURCES).map(async ([n, u]) => { raw[n] = await fetchSource(n, u); }));

  const tcSpots = JSON.parse(raw['fishing-spots.json']);
  const items = JSON.parse(raw['items.json']);
  const places = JSON.parse(raw['places.json']);
  const fishParam = JSON.parse(raw['fish-parameter.json']);
  const itemIcons = JSON.parse(raw['item-icons.json']);
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
  const exOfSpot = (id, territoryId, placeId) => {
    if (oceanMain.has(id) || oceanSub.has(id)) return OCEAN_EX;
    if (territoryId != null && exOfTerritory.has(territoryId)) return exOfTerritory.get(territoryId);
    if (placeId != null && exOfPlace.has(Number(placeId))) return exOfPlace.get(Number(placeId));
    return 0;
  };
  const ikdTable = parseCsv(raw['IKDRouteTable.csv']);
  // 釣り場がどの拡張のものかは TerritoryType.ExVersion で分かる
  const territories = parseCsv(raw['TerritoryType.csv']);
  const exOfTerritory = new Map(territories.map((r) => [Number(r['#']), Number(r.ExVersion)]));
  // territory_id が分からない釣り場のために、地名からも拡張を引けるようにしておく
  const exOfPlace = new Map();
  for (const r of territories) {
    const pn = Number(r.PlaceName);
    if (!pn || exOfPlace.has(pn)) continue;
    exOfPlace.set(pn, Number(r.ExVersion));
  }
  const OCEAN_EX = -1;   // オーシャンフィッシングは拡張で括れないので独立させる
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
      area: placeN(s.placeId) ?? fill({ en: 'Unknown', ja: '不明' }),
      region: reg ? fill({ ja: reg.name_ja, en: reg.name_en, de: reg.name_de, fr: reg.name_fr }) : null,
      territoryId,
      level: s.level ?? null,
      x: s.coords?.x ?? null,
      y: s.coords?.y ?? null,
      spear: spearIds.has(s.id),
      ex: exOfSpot(s.id, territoryId, s.placeId),
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
      ex: exOfSpot(baseId, terr, note.PlaceName),
      fishes,
    });
    known.add(baseId);
  }

  // 魚が1匹も紐づかない釣り場は落とす
  const usableSpots = spots.filter((s) => s.fishes.length > 0);

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
      hookset: c?.hookset ? HOOKSET_JA[c.hookset] ?? c.hookset : null,
      snagging: !!c?.snagging,
      lure: c?.lure ?? null,
      fishEyes: !!c?.fishEyes,
      bigFish: !!c?.bigFish,
      folklore: c?.folklore && D.FOLKLORE[c.folklore]
        ? fill({
            ja: D.FOLKLORE[c.folklore].name_ja, en: D.FOLKLORE[c.folklore].name_en,
            de: D.FOLKLORE[c.folklore].name_de, fr: D.FOLKLORE[c.folklore].name_fr,
          })
        : null,
      collectable: !!c?.collectable,
      gig: c?.gig ?? null,
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
      if (!entry.hookset && st.hookset) { entry.hookset = st.hookset; entry.tugFromStats = true; }
      if (!entry.snagging && st.snagging) entry.snagging = true;
    }
    fish[id] = entry;
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
  const baits = {};
  for (const id of baitIds) {
    if (!id) continue;
    const n = nameOf(id);
    baits[id] = { id, n: n.n, icon: n.icon, isFish: !!fish[id] };
  }

  // ─── 天候 ────────────────────────────────────────────────────
  const weatherTypes = {};
  for (const [id, w] of Object.entries(D.WEATHER_TYPES)) {
    weatherTypes[id] = { n: fill({ ja: w.name_ja, en: w.name_en, de: w.name_de, fr: w.name_fr }), icon: w.icon };
  }
  const weatherRates = {};
  for (const [tid, wr] of Object.entries(D.WEATHER_RATES)) {
    weatherRates[tid] = { rates: wr.weather_rates, zoneId: wr.zone_id, regionId: wr.region_id };
  }

  // ─── 拡張 → エリア の並び（ゲーム内の順に近づける） ────────
  const expansions = {
    [OCEAN_EX]: {
      id: OCEAN_EX,
      n: { ja: 'オーシャンフィッシング', en: 'Ocean Fishing', de: 'Ozeanfischen', fr: 'Pêche en mer' },
    },
  };
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
  const exRank = (e) => (e === OCEAN_EX ? 99 : e);
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

  const ocean = {
    phase: OCEAN_PHASE,
    table: ikdTable.map((r) => [Number(r.IndigoRoute), Number(r.RubyRoute)]),
    routes: oceanRoutes,
  };

  const iconCount = Object.values(fish).filter((f) => f.icon).length;
  const out = {
    meta: {
      // アイコン。ICONS=off でテキストのみの表示になる。
      // 配信元を自前でミラーする場合は ICON_BASE を指定する。
      icons: process.env.ICONS !== 'off',
      iconBase: process.env.ICON_BASE ?? 'https://v2.xivapi.com',
      generatedAt: new Date().toISOString(),
      spotCount: usableSpots.length,
      fishCount: Object.keys(fish).length,
      conditionCount: Object.values(fish).filter((f) => f.hasConditions).length,
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
      ],
    },
    areaOrder,
    expansions,
    spots: usableSpots,
    fish,
    baits,
    weatherTypes,
    weatherRates,
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
      `（条件判明 ${out.meta.conditionCount}）` +
      `\nヌシ ${out.meta.nushiCount}（うちオオヌシ ${out.meta.oonushiCount}）` +
      `\nヒットタイム ${out.meta.biteTimeCount} 件 / ${out.meta.biteSpots} 釣り場` +
      `\n引きを実測から補完 ${Object.values(fish).filter((f) => f.tugFromStats).length} 種` +
      `\n銛の釣り場 ${usableSpots.filter((s) => s.spear).length} / 説明文 ${Object.values(fish).filter((f) => f.desc).length} 種` +
      `\nアイコン ${iconCount} / ${Object.keys(fish).length} 種` +
      `\nオーシャンフィッシング 航路 ${Object.keys(oceanRoutes).length} / 運行表 ${ocean.table.length} 便` +
      `\nオーシャン 伝説魚 ${Object.values(fish).filter((f) => f.oceanLegend).length}` +
      ` / 時間限定 ${Object.values(fish).filter((f) => f.oceanTimes).length}` +
      `\n拡張別の釣り場: ${Object.values(expansions).map((e) =>
        `${e.n.ja} ${usableSpots.filter((s) => s.ex === e.id).length}`).join(' / ')}`,
  );
}

main().catch((e) => {
  console.error('ビルド失敗:', e.message);
  process.exit(1);
});
