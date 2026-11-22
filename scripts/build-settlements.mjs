// Справочник населённых пунктов Беларуси из OpenStreetMap (research.md R4) → seeds/settlements.sql.
// Запуск: node scripts/build-settlements.mjs [--overpass-url URL] [--out seeds/settlements.sql]
//   [--cache-dir DIR] [--small-out tests/fixtures/settlements-small.sql]
// Загрузка в D1: wrangler d1 execute <база> --remote --file seeds/settlements.sql
// Три крупных запроса к Overpass; ответы кешируются в --cache-dir, повторный запуск в сеть не ходит.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { normalizeName } from '../src/geo/gazetteer.js';
import { encodePolyline } from '../src/geo/polyline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const USER_AGENT = 'house-hunter-bot/0.1.0 (build-settlements; +https://t.me/house_hunter_bot)';
const MAX_REQUESTS = 10;
const RETRY_PAUSE_MS = 60_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
// Лимит D1 на один оператор — 100 КБ.
const MAX_STATEMENT_BYTES = 90_000;
const SIMPLIFY_KM = 0.03;
const EARTH_KM = 6371.0088;
const KIND_ORDER = { city: 0, town: 1, village: 2, hamlet: 3, isolated_dwelling: 4 };
const CIRCLE_KM = { isolated_dwelling: 0.15, village: 0.4, hamlet: 0.4 };
const DEFAULT_CIRCLE_KM = 0.5;
const CIRCLE_SIDES = 16;
const AGROTOWN = new Set(['агрогородок', 'аграгарадок']);
const CYRILLIC = /[а-яёіў]/i;

const BY_AREA = 'area["ISO3166-1"="BY"][admin_level=2]->.by;';
const QUERIES = {
  places: `[out:json][timeout:300];
${BY_AREA}
node(area.by)[place~"^(city|town|village|hamlet|isolated_dwelling)$"];
out qt;`,
  // Районы соседних стран тоже попадут (общие линии границы) — отсеиваются локально.
  admin: `[out:json][timeout:600];
${BY_AREA}
(
  rel(area.by)[boundary=administrative][admin_level=4]["ISO3166-2"~"^BY-"];
  rel(area.by)[boundary=administrative][admin_level=6];
)->.r;
.r out body qt;
way(r.r);
out skel geom qt;`,
  // Границы с тегом place, в которые попадает узел города, посёлка или агрогородка.
  shapes: `[out:json][timeout:600];
${BY_AREA}
(
  node(area.by)[place~"^(city|town)$"];
  node(area.by)[place=village]["name:prefix:ru"~"^(агрогородок|аграгарадок)$"];
  node(area.by)[place=village]["name:prefix"~"^(агрогородок|аграгарадок)$"];
)->.pts;
.pts is_in->.a;
area.a[place~"^(city|town|village)$"]->.b;
rel(pivot.b)->.r;
way(pivot.b)->.w;
.r out body qt;
way(r.r);
out skel geom qt;
.w out geom qt;`,
};

// Маленький сид для тестов: все одноимённые — для проверки неоднозначности, остальные — главный пункт.
const SMALL_ALL_NAMESAKES = ['Минск', 'Боровляны', 'Колодищи', 'Заславль', 'Гомель', 'Поколюбичи', 'Ченки'];
const SMALL_BEST = ['Брест', 'Гродно', 'Витебск', 'Могилёв', 'Сеница'];
const SMALL_VILLAGES = 9;
const SMALL_DWELLINGS = 1;
const SMALL_RING_KM = [20, 50];
const SMALL_MAX = 60;

const log = (...args) => console.log(...args);

async function main() {
  const { values } = parseArgs({
    options: {
      'overpass-url': { type: 'string' },
      out: { type: 'string' },
      'cache-dir': { type: 'string' },
      'small-out': { type: 'string' },
    },
  });
  const ctx = {
    urls: values['overpass-url'] ? [values['overpass-url']] : OVERPASS_URLS,
    cacheDir: values['cache-dir'] ? resolve(values['cache-dir']) : join(tmpdir(), 'house-hunter-bot-overpass'),
    requests: [],
  };
  const out = values.out ? resolve(values.out) : join(ROOT, 'seeds', 'settlements.sql');
  await mkdir(ctx.cacheDir, { recursive: true });

  const places = await overpass('places', QUERIES.places, ctx);
  const admin = buildAdmin(await overpass('admin', QUERIES.admin, ctx));
  const shapes = buildShapeIndex(await overpass('shapes', QUERIES.shapes, ctx));
  log(`Районов: ${admin.districts.length}, областей: ${admin.regions.length}, границ пунктов: ${shapes.count}`);

  const { records, skipped } = buildRecords(places, admin, shapes);
  const date = new Date().toISOString().slice(0, 10);
  const osmBase = places.osm3s?.timestamp_osm_base ?? '?';
  const size = await writeSeed(out, records, date, osmBase);
  report(records, skipped, out, size);

  if (values['small-out']) {
    const small = pickSmall(records);
    const smallOut = resolve(values['small-out']);
    const smallSize = await writeSeed(smallOut, small, date, osmBase);
    log(`Маленький сид: ${small.length} пунктов → ${relative(ROOT, smallOut)} (${smallSize} байт)`);
  }
  const used = ctx.requests.map((r) => `${r.url} → ${r.result}`);
  log(`Запросов к Overpass: ${ctx.requests.length}${used.length ? `\n  ${used.join('\n  ')}` : ' (всё из кеша)'}`);
}

/** Запрос к Overpass с кешем на диске; при перегрузке — пауза и повтор, при нескольких адресах — по кругу. */
async function overpass(name, query, ctx) {
  const key = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const file = join(ctx.cacheDir, `${name}-${key}.json`);
  try {
    const text = await readFile(file, 'utf8');
    log(`${name}: из кеша ${file}`);
    return JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (let attempt = 0; ; attempt++) {
    if (ctx.requests.length >= MAX_REQUESTS) throw new Error(`Overpass: исчерпан лимит в ${MAX_REQUESTS} запросов`);
    if (attempt > 0) {
      log(`${name}: пауза ${RETRY_PAUSE_MS / 1000} с перед повтором`);
      await sleep(RETRY_PAUSE_MS);
    }
    const url = ctx.urls[attempt % ctx.urls.length];
    const entry = { url, result: '' };
    ctx.requests.push(entry);
    log(`${name}: запрос к ${url}`);
    const started = Date.now();
    let text;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(15 * 60_000),
      });
      text = await res.text();
      entry.result = `${name} HTTP ${res.status}`;
      if (!res.ok) {
        if (RETRY_STATUSES.has(res.status)) {
          log(`${name}: HTTP ${res.status}`);
          continue;
        }
        throw new Error(`Overpass ${url}: HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
    } catch (err) {
      if (err.message.startsWith('Overpass ')) throw err;
      entry.result = `${name} ${err.name}: ${err.message}`;
      log(`${name}: сбой сети — ${err.message}`);
      continue;
    }
    const data = JSON.parse(text);
    if (/error/i.test(data.remark ?? '')) {
      entry.result += ` (${data.remark})`;
      log(`${name}: ${data.remark}`);
      continue;
    }
    entry.result += `, ${data.elements.length} элементов, ${(text.length / 1e6).toFixed(1)} МБ, ${Math.round((Date.now() - started) / 1000)} с`;
    await writeFile(`${file}.part`, text);
    await rename(`${file}.part`, file);
    return data;
  }
}

// ---- Геометрия. Кольцо — замкнутый массив [lon, lat]; полигон — набор колец по правилу чёт-нечет.

function makeRing(coords) {
  const xy = new Float64Array(coords.length * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  coords.forEach(([x, y], i) => {
    xy[i * 2] = x;
    xy[i * 2 + 1] = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  return { coords, xy, minX, minY, maxX, maxY };
}

function makePolygon(rings) {
  const poly = { rings, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const r of rings) {
    poly.minX = Math.min(poly.minX, r.minX);
    poly.minY = Math.min(poly.minY, r.minY);
    poly.maxX = Math.max(poly.maxX, r.maxX);
    poly.maxY = Math.max(poly.maxY, r.maxY);
  }
  return poly;
}

function inBox(b, x, y) {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

function ringContains(ring, x, y) {
  if (!inBox(ring, x, y)) return false;
  const a = ring.xy;
  let inside = false;
  for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
    const yi = a[i + 1];
    const yj = a[j + 1];
    if (yi > y !== yj > y && x < ((a[j] - a[i]) * (y - yi)) / (yj - yi) + a[i]) inside = !inside;
  }
  return inside;
}

function polygonContains(poly, x, y) {
  if (!inBox(poly, x, y)) return false;
  let inside = false;
  for (const ring of poly.rings) if (ringContains(ring, x, y)) inside = !inside;
  return inside;
}

/** Точка заведомо внутри полигона: середина самого широкого отрезка горизонтали внутри него. */
function interiorPoint(poly) {
  for (const f of [0.5, 0.3, 0.7, 0.1, 0.9]) {
    const y = poly.minY + (poly.maxY - poly.minY) * f + 1e-9;
    const xs = [];
    for (const { xy: a } of poly.rings) {
      for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
        const yi = a[i + 1];
        const yj = a[j + 1];
        if (yi > y !== yj > y) xs.push(((a[j] - a[i]) * (y - yi)) / (yj - yi) + a[i]);
      }
    }
    xs.sort((p, q) => p - q);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (!best || xs[i + 1] - xs[i] > best.w) best = { w: xs[i + 1] - xs[i], x: (xs[i] + xs[i + 1]) / 2 };
    }
    if (best) return [best.x, y];
  }
  return null;
}

/** Склейка линий-членов отношения в замкнутые кольца по общим узлам. */
function assembleRings(parts) {
  const rings = [];
  const open = [];
  for (const p of parts) {
    if (p.nodes.length < 2) continue;
    if (p.nodes[0] === p.nodes.at(-1)) {
      if (p.nodes.length >= 4) rings.push(p.coords);
    } else open.push(p);
  }
  const byEnd = new Map();
  const link = (node, i) => {
    if (!byEnd.has(node)) byEnd.set(node, []);
    byEnd.get(node).push(i);
  };
  open.forEach((p, i) => {
    link(p.nodes[0], i);
    link(p.nodes.at(-1), i);
  });
  const used = new Array(open.length).fill(false);
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const first = open[i].nodes[0];
    let last = open[i].nodes.at(-1);
    const coords = open[i].coords.slice();
    while (last !== first) {
      const next = (byEnd.get(last) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = true;
      const p = open[next];
      const forward = p.nodes[0] === last;
      const seq = forward ? p.coords : p.coords.slice().reverse();
      for (let k = 1; k < seq.length; k++) coords.push(seq[k]);
      last = forward ? p.nodes.at(-1) : p.nodes[0];
    }
    if (last === first && coords.length >= 4) rings.push(coords);
  }
  return rings;
}

function wayIndex(elements) {
  const ways = new Map();
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || ways.has(el.id)) continue;
    if (el.geometry.some((g) => !g)) continue;
    ways.set(el.id, { nodes: el.nodes, coords: el.geometry.map((g) => [g.lon, g.lat]), tags: el.tags });
  }
  return ways;
}

/** Кольца отношения: outer — внешние, all — все (для проверки «точка внутри» с дырами). */
function relationRings(rel, ways) {
  const outerParts = [];
  const innerParts = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !ways.has(m.ref)) continue;
    if (m.role === 'outer' || m.role === '') outerParts.push(ways.get(m.ref));
    else if (m.role === 'inner') innerParts.push(ways.get(m.ref));
  }
  const outer = assembleRings(outerParts).map(makeRing);
  const inner = assembleRings(innerParts).map(makeRing);
  return { outer, all: [...outer, ...inner] };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Дуглас–Пекер на локальной равнопромежуточной проекции вокруг центра; допуск в километрах. */
function simplifyRing(coords, lat0, lon0, toleranceKm) {
  const k = (Math.PI / 180) * EARTH_KM;
  const cos0 = Math.cos(lat0 * (Math.PI / 180));
  const pts = coords.map(([lon, lat]) => [(lon - lon0) * k * cos0, (lat - lat0) * k]);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let maxD = -1;
    let index = -1;
    for (let i = from + 1; i < to; i++) {
      const d = segmentDistance(pts[i], pts[from], pts[to]);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (index !== -1 && maxD > toleranceKm) {
      keep[index] = 1;
      stack.push([from, index], [index, to]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

function segmentDistance([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Незамкнутый контур [lat, lon] в encoded polyline без повторов соседних точек после округления. */
function encodeRing(latLon) {
  const points = [];
  for (const [lat, lon] of latLon) {
    const p = [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
    const prev = points.at(-1);
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) points.push(p);
  }
  while (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  return { polygon: encodePolyline(points), vertices: points.length };
}

function circleShape(lat, lon, radiusKm) {
  const rad = Math.PI / 180;
  const d = radiusKm / EARTH_KM;
  const points = [];
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const b = ((360 / CIRCLE_SIDES) * i) * rad;
    const lat2 = Math.asin(Math.sin(lat * rad) * Math.cos(d) + Math.cos(lat * rad) * Math.sin(d) * Math.cos(b));
    const lon2 =
      lon * rad +
      Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat * rad), Math.cos(d) - Math.sin(lat * rad) * Math.sin(lat2));
    points.push([lat2 / rad, lon2 / rad]);
  }
  return { polygon: encodeRing(points).polygon, radiusKm, source: 'circle' };
}

function osmShape(ring, lat, lon) {
  let simplified;
  // Центр у самого края границы может выпасть из упрощённого контура — тогда допуск меньше.
  for (const tolerance of [SIMPLIFY_KM, SIMPLIFY_KM / 3, SIMPLIFY_KM / 10, 0]) {
    simplified = simplifyRing(ring.coords, lat, lon, tolerance);
    if (ringContains(makeRing(simplified), lon, lat)) break;
  }
  const { polygon, vertices } = encodeRing(simplified.map(([x, y]) => [y, x]));
  if (vertices < 3) return null;
  let radius = 0;
  for (const [x, y] of ring.coords) radius = Math.max(radius, haversineKm(lat, lon, y, x));
  return { polygon, radiusKm: Math.ceil(radius * 1000) / 1000, source: 'osm' };
}

// ---- Районы и области.

const textKey = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function buildAdmin(data) {
  const ways = wayIndex(data.elements);
  const regions = [];
  const level6 = [];
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const t = rel.tags ?? {};
    const name = t['name:ru'] || t.name;
    const poly = makePolygon(relationRings(rel, ways).all);
    if (!name || poly.rings.length === 0) continue;
    const item = { id: rel.id, name, tags: t, poly };
    if (t.admin_level === '4') regions.push(item);
    else level6.push(item);
  }
  const minsk = regions.find((r) => r.tags['ISO3166-2'] === 'BY-HM') ?? null;
  const districts = [];
  for (const d of level6) {
    const p = interiorPoint(d.poly);
    const region = p && regions.find((r) => polygonContains(r.poly, p[0], p[1]));
    if (!region) continue;
    districts.push({ name: d.name, isCity: Boolean(d.tags.place), region: region.name, poly: d.poly });
  }
  const districtNames = new Map();
  for (const d of districts) {
    if (d.isCity) continue;
    for (const n of [d.name, ...level6.filter((x) => x.name === d.name).map((x) => x.tags.name)]) {
      districtNames.set(textKey(n), d.name);
    }
  }
  const regionNames = new Map();
  for (const r of regions) for (const n of [r.name, r.tags.name]) regionNames.set(textKey(n), r.name);
  return { regions, minsk, districts, districtNames, regionNames };
}

/** Район и область точки: по границам, а при их отсутствии — по addr:district и addr:region узла. */
function locate(admin, x, y, tags) {
  if (admin.minsk && polygonContains(admin.minsk.poly, x, y)) return { district: null, region: admin.minsk.name };
  const hits = admin.districts.filter((d) => polygonContains(d.poly, x, y));
  if (hits.length) {
    const city = hits.find((d) => d.isCity);
    return city ? { district: null, region: city.region } : { district: hits[0].name, region: hits[0].region };
  }
  const region =
    admin.regions.find((r) => r !== admin.minsk && polygonContains(r.poly, x, y))?.name ??
    admin.regionNames.get(textKey(tags['addr:region']));
  if (!region) return null;
  return { district: admin.districtNames.get(textKey(tags['addr:district'])) ?? null, region, fallback: true };
}

// ---- Границы пунктов.

function buildShapeIndex(data) {
  const ways = wayIndex(data.elements);
  const byName = new Map();
  let count = 0;
  const add = (ref, tags, rings) => {
    if (!tags?.place || rings.outer.length === 0) return;
    const shape = { ref, place: tags.place, outer: rings.outer, poly: makePolygon(rings.all) };
    shape.area = (shape.poly.maxX - shape.poly.minX) * (shape.poly.maxY - shape.poly.minY);
    count++;
    for (const n of new Set([normalizeName(tags['name:ru']), normalizeName(tags.name)])) {
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(shape);
    }
  };
  const seen = new Set();
  for (const el of data.elements) {
    if (el.type === 'relation') add(`r${el.id}`, el.tags, relationRings(el, ways));
    else if (el.type === 'way' && el.tags && !seen.has(el.id)) {
      seen.add(el.id);
      const w = ways.get(el.id);
      const closed = w && w.nodes.length >= 4 && w.nodes[0] === w.nodes.at(-1);
      if (closed) {
        const ring = makeRing(w.coords);
        add(`w${el.id}`, el.tags, { outer: [ring], all: [ring] });
      }
    }
  }
  return { byName, count };
}

function isPolygonKind(kind, tags) {
  if (kind === 'city' || kind === 'town') return true;
  return kind === 'village' && (AGROTOWN.has(tags['name:prefix:ru']) || AGROTOWN.has(tags['name:prefix']));
}

/** Граница того же пункта: совпадает название и узел внутри; предпочтение — тот же place, затем меньшая. */
function findShape(index, tags, x, y) {
  const found = new Set();
  for (const n of [normalizeName(tags['name:ru']), normalizeName(tags.name)]) {
    for (const s of index.byName.get(n) ?? []) if (polygonContains(s.poly, x, y)) found.add(s);
  }
  const list = [...found].sort((a, b) => (a.place === tags.place ? 0 : 1) - (b.place === tags.place ? 0 : 1) || a.area - b.area);
  for (const s of list) {
    const ring = s.outer.find((r) => ringContains(r, x, y));
    if (ring) return ring;
  }
  return null;
}

// ---- Сборка записей.

function parsePopulation(value) {
  const n = Number.parseInt(String(value ?? '').replace(/[\s ,.]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildRecords(places, admin, shapes) {
  const records = [];
  const skipped = { noName: 0, outside: 0 };
  let fallbacks = 0;
  for (const el of places.elements) {
    if (el.type !== 'node') continue;
    const t = el.tags ?? {};
    const kind = t.place;
    if (!(kind in KIND_ORDER)) continue;
    const name = String(t['name:ru'] || t.name || '').replace(/\s+/g, ' ').trim();
    const nameNorm = normalizeName(name);
    if (!CYRILLIC.test(name) || !nameNorm) {
      skipped.noName++;
      continue;
    }
    const where = locate(admin, el.lon, el.lat, t);
    if (!where) {
      skipped.outside++;
      continue;
    }
    if (where.fallback) fallbacks++;
    const population = Math.min(parsePopulation(t.population), 9_999_999);
    let shape = null;
    if (isPolygonKind(kind, t)) {
      const ring = findShape(shapes, t, el.lon, el.lat);
      if (ring) shape = osmShape(ring, el.lat, el.lon);
    }
    shape ??= circleShape(el.lat, el.lon, CIRCLE_KM[kind] ?? DEFAULT_CIRCLE_KM);
    records.push({
      id: el.id * 4,
      osmRef: `n${el.id}`,
      name,
      nameNorm,
      kind,
      district: where.district,
      region: where.region,
      lat: el.lat,
      lon: el.lon,
      rank: KIND_ORDER[kind] * 10_000_000 + (9_999_999 - population),
      polygonWanted: isPolygonKind(kind, t),
      shape,
    });
  }
  records.sort((a, b) => a.id - b.id);
  skipped.addrFallback = fallbacks;
  return { records, skipped };
}

function pickSmall(records) {
  const chosen = new Map();
  const byNorm = (name) => records.filter((r) => r.nameNorm === normalizeName(name));
  for (const name of SMALL_ALL_NAMESAKES) for (const r of byNorm(name)) chosen.set(r.id, r);
  for (const name of SMALL_BEST) {
    const best = byNorm(name).sort((a, b) => a.rank - b.rank)[0];
    if (best) chosen.set(best.id, best);
  }
  const minsk = byNorm('Минск').find((r) => r.kind === 'city');
  const ring = records
    .filter((r) => r.shape.source === 'circle' && !chosen.has(r.id))
    .map((r) => ({ r, km: haversineKm(minsk.lat, minsk.lon, r.lat, r.lon) }))
    .filter(({ km }) => km >= SMALL_RING_KM[0] && km <= SMALL_RING_KM[1])
    .sort((a, b) => a.r.rank - b.r.rank || a.r.id - b.r.id);
  const take = (kinds, n) => {
    for (const { r } of ring.filter(({ r: x }) => kinds.includes(x.kind)).slice(0, n)) chosen.set(r.id, r);
  };
  take(['village', 'hamlet'], SMALL_VILLAGES);
  take(['isolated_dwelling'], SMALL_DWELLINGS);
  const list = [...chosen.values()].sort((a, b) => a.id - b.id);
  if (list.length > SMALL_MAX) throw new Error(`Маленький сид: ${list.length} пунктов, больше ${SMALL_MAX}`);
  return list;
}

// ---- SQL.

const sqlText = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function insertStatements(table, columns, conflict, rows) {
  const updates = columns.filter((c) => c !== conflict).map((c) => `${c} = excluded.${c}`);
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
  const tail = `\nON CONFLICT (${conflict}) DO UPDATE SET ${updates.join(', ')};\n`;
  const fixed = Buffer.byteLength(head) + Buffer.byteLength(tail);
  const statements = [];
  let batch = [];
  let size = fixed;
  const flush = () => {
    if (batch.length) statements.push(head + batch.join(',\n') + tail);
    batch = [];
    size = fixed;
  };
  for (const row of rows) {
    const bytes = Buffer.byteLength(row) + 2;
    if (fixed + bytes > MAX_STATEMENT_BYTES) throw new Error(`${table}: строка больше ${MAX_STATEMENT_BYTES} байт`);
    if (size + bytes > MAX_STATEMENT_BYTES) flush();
    batch.push(row);
    size += bytes;
  }
  flush();
  return statements;
}

async function writeSeed(file, records, date, osmBase) {
  const settlements = records.map(
    (r) =>
      `(${r.id}, ${sqlText(r.osmRef)}, ${sqlText(r.name)}, ${sqlText(r.nameNorm)}, ${sqlText(r.kind)}, ` +
      `${sqlText(r.district)}, ${sqlText(r.region)}, ${r.lat}, ${r.lon}, ${r.rank})`,
  );
  const shapes = records.map(
    (r) => `(${r.id}, ${sqlText(r.shape.polygon)}, ${r.shape.radiusKm}, ${sqlText(r.shape.source)})`,
  );
  const osmCount = records.filter((r) => r.shape.source === 'osm').length;
  const text = [
    `-- Данные © участники OpenStreetMap, ODbL 1.0; собрано scripts/build-settlements.mjs ${date}`,
    `-- Снимок OSM ${osmBase}; пунктов: ${records.length}, полигонов OSM: ${osmCount}. Контуры — encoded polyline`,
    '-- (точность 5), незамкнутые: последняя вершина соединяется с первой.',
    '',
    ...insertStatements(
      'settlements',
      ['id', 'osm_ref', 'name', 'name_norm', 'kind', 'district', 'region', 'lat', 'lon', 'rank'],
      'id',
      settlements,
    ),
    ...insertStatements('settlement_shapes', ['settlement_id', 'polygon', 'radius_km', 'source'], 'settlement_id', shapes),
  ].join('\n');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return (await stat(file)).size;
}

function report(records, skipped, out, size) {
  const byKind = {};
  for (const r of records) {
    byKind[r.kind] ??= { total: 0, osm: 0, wanted: 0 };
    byKind[r.kind].total++;
    if (r.polygonWanted) byKind[r.kind].wanted++;
    if (r.shape.source === 'osm') byKind[r.kind].osm++;
  }
  log(`Пунктов: ${records.length}; пропущено: без названия ${skipped.noName}, вне Беларуси ${skipped.outside}; ` +
    `район или область по addr:* — ${skipped.addrFallback}`);
  for (const [kind, s] of Object.entries(byKind)) {
    log(`  ${kind}: ${s.total}, полигонов OSM ${s.osm} из ${s.wanted} нужных`);
  }
  log(`Сид: ${relative(ROOT, out)} (${(size / 1e6).toFixed(2)} МБ)`);
}

await main();
