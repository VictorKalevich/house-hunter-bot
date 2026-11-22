// Проверка Criteria (contracts/miniapp-api.md «Правила проверки», data-model.md searches).
import { KIND_GROUP_IDS, MAX_KM, SOURCE_IDS } from '../config.js';
import { formatInt } from './format.js';

export const DISTANCE_MODES = ['straight', 'road_center', 'road_exit'];
const MODE_TITLE = { straight: 'по прямой', road_center: 'по дороге', road_exit: 'по дороге от выезда' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function checkRange(range, label, fields, key) {
  if (range === null || range === undefined) return { min: null, max: null };
  if (typeof range !== 'object') {
    fields[key] = 'Неверный диапазон';
    return { min: null, max: null };
  }
  const min = range.min ?? null;
  const max = range.max ?? null;
  for (const v of [min, max]) {
    if (v !== null && (!isNum(v) || v < 0)) {
      fields[key] = `${label}: введите число не меньше 0`;
      return { min: null, max: null };
    }
  }
  if (min !== null && max !== null && min > max) fields[key] = '«От» больше, чем «до» — поправьте диапазон';
  return { min, max };
}

/**
 * @param {any} body тело запроса
 * @param {{allowedModes?: string[]}} opts
 * @returns {{criteria: object|null, fields: Record<string, string>}} criteria — если ошибок нет
 *   (settlementId существует ли — проверяет вызывающий)
 */
export function validateCriteria(body, { allowedModes = DISTANCE_MODES } = {}) {
  const fields = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { criteria: null, fields: { body: 'Ожидается объект условий' } };

  const maxKm = body.maxKm ?? null;
  if (maxKm !== null && (!isNum(maxKm) || maxKm < 1 || maxKm > MAX_KM)) fields.maxKm = `Расстояние — от 1 до ${MAX_KM} км`;

  const settlementId = body.settlementId ?? null;
  if (settlementId !== null && !Number.isSafeInteger(settlementId)) fields.settlementId = 'Выберите населённый пункт из списка';
  if (maxKm !== null && settlementId === null) fields.settlementId = 'Выберите населённый пункт, от которого считать расстояние';

  const distanceMode = body.distanceMode ?? 'straight';
  if (!allowedModes.includes(distanceMode)) fields.distanceMode = 'Такой способ подсчёта расстояния недоступен';

  const priceUsd = checkRange(body.priceUsd, 'Цена', fields, 'priceUsd');
  const houseM2 = checkRange(body.houseM2, 'Площадь дома', fields, 'houseM2');
  const plotSotki = checkRange(body.plotSotki, 'Площадь участка', fields, 'plotSotki');

  let sources = body.sources ?? SOURCE_IDS;
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => !SOURCE_IDS.includes(s))) {
    fields.sources = 'Выберите хотя бы один сайт';
    sources = SOURCE_IDS;
  }
  sources = SOURCE_IDS.filter((s) => sources.includes(s));

  let kinds = body.kinds ?? KIND_GROUP_IDS;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !KIND_GROUP_IDS.includes(k))) {
    fields.kinds = 'Выберите хотя бы один тип';
    kinds = KIND_GROUP_IDS;
  }
  kinds = KIND_GROUP_IDS.filter((k) => kinds.includes(k));

  if (Object.keys(fields).length) return { criteria: null, fields };
  return { criteria: { settlementId, distanceMode, maxKm, priceUsd, houseM2, plotSotki, kinds, sources }, fields };
}

/** «Боровляны · до 30 км по дороге от выезда», без пункта — «Любое место · до 80 000 $». */
export function buildTitle(criteria, settlement) {
  const parts = [settlement ? settlement.name : 'Любое место'];
  if (criteria.maxKm !== null) parts.push(`до ${formatInt(criteria.maxKm)} км ${MODE_TITLE[criteria.distanceMode]}`);
  else if (criteria.priceUsd.max !== null) parts.push(`до ${formatInt(criteria.priceUsd.max)} $`);
  else if (criteria.houseM2.min !== null) parts.push(`дом от ${formatInt(criteria.houseM2.min)} м²`);
  else if (criteria.plotSotki.min !== null) parts.push(`участок от ${formatInt(criteria.plotSotki.min)} сот.`);
  return parts.join(' · ');
}
