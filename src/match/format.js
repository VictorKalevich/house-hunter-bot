// Тексты: уведомление (contracts/telegram-bot.md «Уведомление»), подпись расстояния, карточка ListingCard
// (contracts/miniapp-api.md «Объекты»).
import { KIND_TITLES, UNCHECKED_AFTER_MS } from '../config.js';
import { escapeHtml } from '../telegram/html.js';
import { SOURCE_TITLES } from '../sources/titles.js';

const MODE_TEXT = { straight: 'по прямой', road_center: 'по дороге от центра', road_exit: 'по дороге от выезда' };

export function formatInt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatDecimal(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? formatInt(r) : String(r).replace('.', ',');
}

export function formatKm(km) {
  return km < 10 ? formatDecimal(km) : formatInt(km);
}

/**
 * «Боровляны: ≈ 31 км по дороге от выезда», «Минск: 25 км по прямой (маршрут не построен)».
 * Название пункта — в начале строки, чтобы не склонять его.
 * @param {{km: number, mode: string, approx?: boolean, fallback?: boolean, settlementName?: string|null}} d
 */
export function distanceLabel({ km, mode, approx = false, fallback = false, settlementName = null }) {
  const how = fallback ? `${MODE_TEXT.straight} (маршрут не построен)` : MODE_TEXT[mode] ?? MODE_TEXT.straight;
  const value = `${approx ? '≈ ' : ''}${formatKm(km)} км ${how}`;
  return settlementName ? `${settlementName}: ${value}` : value;
}

export function priceLine(listing, { bold = true } = {}) {
  const b = (s) => (bold ? `<b>${s}</b>` : s);
  if (listing.price_usd !== null && listing.price_usd !== undefined) return b(`${formatInt(listing.price_usd)} $`);
  if (listing.price_byn !== null && listing.price_byn !== undefined) return b(`${formatInt(listing.price_byn)} BYN`);
  return 'цена не указана';
}

/** «Дом · 75 000 $ · дом 100 м² · участок 15 сот.» — первая строка уведомления (contracts/telegram-bot.md 002). */
function headLine(listing, { bold = true } = {}) {
  const house = listing.house_m2 ? `дом ${formatDecimal(listing.house_m2)} м²` : 'дом: не указано';
  const plot = listing.plot_sotki ? `участок ${formatDecimal(listing.plot_sotki)} сот.` : 'участок: не указано';
  const kind = KIND_TITLES[listing.kind];
  return `${kind ? `${kind} · ` : ''}${priceLine(listing, { bold })} · ${house} · ${plot}`;
}

function previewOptions(listing) {
  return listing.photo_url
    ? { url: listing.photo_url, prefer_large_media: true, show_above_text: true }
    : { is_disabled: true };
}

/**
 * Клавиатура сообщения об объявлении по отметке пользователя (contracts/telegram-bot.md 003).
 * @param {{id: number, url: string}} listing
 * @param {'like'|'hide'|null} mark
 */
export function markKeyboard(listing, mark) {
  const open = [{ text: 'Открыть объявление', url: listing.url }];
  const hide = { text: 'Не интересно', callback_data: `hd:${listing.id}` };
  if (mark === 'hide') return { inline_keyboard: [open, [{ text: 'Скрыто · вернуть', callback_data: `uh:${listing.id}` }]] };
  if (mark === 'like') return { inline_keyboard: [open, [{ text: '♥ В понравившихся', callback_data: `ul:${listing.id}` }, hide]] };
  return { inline_keyboard: [open, [{ text: '♡ Нравится', callback_data: `lk:${listing.id}` }, hide]] };
}

/**
 * Сообщение sendMessage о новом объявлении (без chat_id).
 * @param {object} listing строка listings
 * @param {{searchTitles: string[], distanceLabel?: string|null, listingId?: number, mark?: 'like'|null}} ctx
 */
export function notificationMessage(listing, { searchTitles, distanceLabel: distance = null, listingId = listing.id, mark = null }) {
  const titles = searchTitles.map((t) => `«${escapeHtml(t)}»`).join(', ');
  const lines = [
    headLine(listing),
    distance ? escapeHtml(distance) : null,
    listing.place_text ? escapeHtml(listing.place_text) : null,
    `${escapeHtml(SOURCE_TITLES[listing.source] ?? listing.source)} · ${searchTitles.length > 1 ? 'Поиски' : 'Поиск'}: ${titles}`,
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: listingId == null
      ? { inline_keyboard: [[{ text: 'Открыть объявление', url: listing.url }]] }
      : markKeyboard({ id: listingId, url: listing.url }, mark),
    link_preview_options: previewOptions(listing),
  };
}

const CURRENCY_SIGNS = { USD: '$', BYN: 'BYN', EUR: '€' };

/**
 * Сообщение об изменении цены понравившегося (contracts/telegram-bot.md 003): цены сравнения, строка уведомления по
 * текущим данным без <b>, место, сайт; кнопки — как при отметке «лайк».
 * @param {object} row строка price_alerts с полями объявления (listing_id, source, url, цены, площади, место, фото)
 * @param {{currency: string, oldPrice: number, newPrice: number}} change
 */
export function priceAlertMessage(row, { currency, oldPrice, newPrice }) {
  const sign = CURRENCY_SIGNS[currency] ?? currency;
  const money = (n) => `${formatInt(n)} ${sign}`;
  const diff = `${newPrice > oldPrice ? '+' : '−'}${money(Math.abs(newPrice - oldPrice))}`;
  const lines = [
    `Цена изменилась: было <b>${money(oldPrice)}</b>, стало <b>${money(newPrice)}</b> (${diff})`,
    headLine(row, { bold: false }),
    row.place_text ? escapeHtml(row.place_text) : null,
    `${escapeHtml(SOURCE_TITLES[row.source] ?? row.source)} · в понравившихся`,
  ].filter(Boolean);
  return {
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: markKeyboard({ id: row.listing_id, url: row.url }, 'like'),
    link_preview_options: previewOptions(row),
  };
}

/**
 * Пометка «снято» или «не удалось проверить» (data-model.md 003 listings, «Пометка на карточке»).
 * @param {object} row
 * @param {'like'|'hide'|null} mark
 * @param {number|null} now
 */
export function siteStatus(row, mark, now) {
  if (row.gone_at != null) return { kind: 'gone', at: new Date(row.gone_at).toISOString() };
  if (mark !== 'like' || now == null || row.last_seen_at == null) return null;
  const seen = Math.max(row.last_seen_at, row.check_ok_at ?? 0);
  return seen < now - UNCHECKED_AFTER_MS ? { kind: 'unchecked', lastSeenAt: new Date(row.last_seen_at).toISOString() } : null;
}

/**
 * Строка listings → ListingCard.
 * @param {object} row
 * @param {{km: number|null, mode: string, approx: boolean, fallback: boolean, pending: boolean, from?: string}|null} distance
 * @param {{mark?: 'like'|'hide'|null, now?: number|null}} [opts]
 */
export function listingCard(row, distance, { mark = null, now = null } = {}) {
  return {
    id: row.id ?? null,
    mark,
    siteStatus: siteStatus(row, mark, now),
    source: row.source,
    url: row.url,
    photoUrl: row.photo_url ?? null,
    kind: row.kind ?? null,
    priceUsd: row.price_usd ?? null,
    priceByn: row.price_byn ?? null,
    houseM2: row.house_m2 ?? null,
    plotSotki: row.plot_sotki ?? null,
    distance: distance
      ? {
          km: distance.km === null ? null : Math.round(distance.km * 10) / 10,
          mode: distance.mode,
          approx: Boolean(distance.approx),
          fallback: Boolean(distance.fallback),
          pending: Boolean(distance.pending),
          ...(distance.from ? { from: distance.from } : {}),
        }
      : null,
    place: row.place_text ?? '',
    publishedAt: new Date(row.published_at ?? row.first_seen_at).toISOString(),
    isNew: row.is_new === 1,
    createdAt: row.site_created_at == null ? null : new Date(row.site_created_at).toISOString(),
  };
}
