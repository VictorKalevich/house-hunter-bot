// Время для текстов: Минск, UTC+3 круглый год.
const MINSK_OFFSET_MS = 3 * 3600_000;

const parts = (ms) => {
  const d = new Date(ms + MINSK_OFFSET_MS);
  const p2 = (n) => String(n).padStart(2, '0');
  return {
    day: p2(d.getUTCDate()),
    month: p2(d.getUTCMonth() + 1),
    year: d.getUTCFullYear(),
    hh: p2(d.getUTCHours()),
    mm: p2(d.getUTCMinutes()),
  };
};

/** 22.11.2026 */
export function minskDate(ms) {
  const p = parts(ms);
  return `${p.day}.${p.month}.${p.year}`;
}

/** 14:05 */
export function minskTime(ms) {
  const p = parts(ms);
  return `${p.hh}:${p.mm}`;
}

/** 22.11 14:05 */
export function minskDayTime(ms) {
  const p = parts(ms);
  return `${p.day}.${p.month} ${p.hh}:${p.mm}`;
}

/** 2 ч 10 мин, 5 мин, 1 д 3 ч */
export function durationText(ms) {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const out = [];
  if (d) out.push(`${d} д`);
  if (h) out.push(`${h} ч`);
  if (m && !d) out.push(`${m} мин`);
  return out.join(' ') || '1 мин';
}

/** YYYY-MM-DD по UTC */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
