// Справочник населённых пунктов: подсказки (FR-007) и место объявления без координат (research.md R5).

const PREFIXES = [
  'городской поселок', 'рабочий поселок', 'курортный поселок', 'агрогородок', 'деревня', 'поселок', 'хутор', 'город',
  'село', 'г.п.', 'гп', 'р.п.', 'аг.', 'аг', 'д.', 'п.', 'пос.', 'х.', 'г.', 'с.',
];

function baseNorm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"„“”'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Название пункта как `settlements.name_norm`: нижний регистр, ё → е, без кавычек, приставок типа и лишних пробелов. */
export function normalizeName(text) {
  let s = baseNorm(text);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of PREFIXES) {
      const withSpace = p.endsWith('.') ? s.startsWith(p) : s.startsWith(`${p} `);
      if (withSpace) {
        s = s.slice(p.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

const DISTRICT_WORDS = new Set(['р-н', 'р-н.', 'р-он', 'р.', 'района', 'район']);
const REGION_WORDS = new Set(['обл', 'обл.', 'области', 'область']);

/** «Минский р-н», «Минский район» → «минский район»; NULL/пусто → ''. */
export function normalizeDistrict(text) {
  return baseNorm(text)
    .split(' ')
    .map((w) => (DISTRICT_WORDS.has(w) ? 'район' : w))
    .join(' ');
}

/** «Гомельская обл.», «Гомельская область» → «гомельская область»; «г. Минск» → «минск». */
export function normalizeRegion(text) {
  return baseNorm(text)
    .replace(/^г\.\s*/, '')
    .split(' ')
    .map((w) => (REGION_WORDS.has(w) ? 'область' : w))
    .join(' ');
}

export const SUGGEST_LIMIT = 10;

/** Подсказки по началу названия, крупные выше (settlements.rank). */
export async function suggestSettlements(db, query) {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  const { results } = await db
    .prepare(
      `SELECT id, name, kind, district, region, lat, lon FROM settlements
       WHERE name_norm >= ? AND name_norm < ? ORDER BY rank, name LIMIT ?`,
    )
    .bind(q, `${q}￿`, SUGGEST_LIMIT)
    .all();
  return results;
}

export async function getSettlement(db, id) {
  return db.prepare('SELECT id, name, kind, district, region, lat, lon FROM settlements WHERE id = ?').bind(id).first();
}

/**
 * Выбор пункта среди одноимённых по району и области. Неоднозначно или не найдено → null.
 * @param {Array<{district: string|null, region: string}>} candidates
 * @param {{district?: string|null, region?: string|null}} place
 */
export function pickSettlement(candidates, place) {
  let list = candidates;
  const district = normalizeDistrict(place.district);
  const region = normalizeRegion(place.region);
  if (district) {
    const byDistrict = list.filter((c) => normalizeDistrict(c.district) === district);
    // Город областного подчинения: у пункта района нет, а сайт пишет одноимённый район.
    list = byDistrict.length ? byDistrict : list.filter((c) => !c.district);
  }
  if (region) list = list.filter((c) => normalizeRegion(c.region) === region);
  if (list.length === 1) return list[0];
  // Без района и области — только если город один такой и он крупный (не деревня-тёзка).
  if (!district && !region) {
    const cities = list.filter((c) => c.kind === 'city' || c.kind === 'town');
    if (cities.length === 1) return cities[0];
  }
  return null;
}

/**
 * Места объявлений без координат → пункты справочника. Запрос отдаётся вызывающему, чтобы выполнить его в общем
 * batch; `resolve(rows)` раскладывает результат по местам в том же порядке.
 * @param {Array<{settlement?: string|null, district?: string|null, region?: string|null}>} places
 */
export function matchPlacesQuery(db, places) {
  const names = [...new Set(places.map((p) => normalizeName(p?.settlement)).filter(Boolean))].slice(0, 90);
  if (names.length === 0) return null;
  const statement = db
    .prepare(
      `SELECT id, name, name_norm, kind, district, region, lat, lon FROM settlements
       WHERE name_norm IN (${names.map(() => '?').join(',')})`,
    )
    .bind(...names);
  const resolve = (rows) => {
    const byName = new Map();
    for (const row of rows) {
      if (!byName.has(row.name_norm)) byName.set(row.name_norm, []);
      byName.get(row.name_norm).push(row);
    }
    return places.map((p) => {
      const candidates = byName.get(normalizeName(p?.settlement));
      return candidates ? pickSettlement(candidates, p) : null;
    });
  };
  return { statement, resolve };
}
