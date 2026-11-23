// Изменилась ли цена объявления (specs/003-listing-likes/research.md R9).
import { PRICE_CHANGE_MIN } from '../config.js';

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
// Деление даёт ровно 0,01 при разнице в 1 %, поэтому граница не теряется на округлении.
const moved = (from, to) => Math.abs(to - from) / from >= PRICE_CHANGE_MIN;
const change = (currency, oldPrice, newPrice) => ({ currency, oldPrice, newPrice });

/**
 * Валюта продавца у обеих цен одна → сравнение сумм продавца. Иначе — по долларам и рублям: обе пары сдвинулись
 * в одну сторону, или единственная общая пара сдвинулась. Цена появилась или пропала — не изменение.
 * @param {{price_amount?: number|null, price_currency?: string|null, price_usd?: number|null, price_byn?: number|null}} old
 * @param {typeof old} next
 * @returns {{currency: 'USD'|'BYN'|'EUR', oldPrice: number, newPrice: number} | null}
 */
export function priceChange(old, next) {
  if (old.price_currency && old.price_currency === next.price_currency
    && positive(old.price_amount) && positive(next.price_amount)) {
    return moved(old.price_amount, next.price_amount) ? change(old.price_currency, old.price_amount, next.price_amount) : null;
  }
  const usd = positive(old.price_usd) && positive(next.price_usd);
  const byn = positive(old.price_byn) && positive(next.price_byn);
  if (usd && byn) {
    const same = Math.sign(next.price_usd - old.price_usd) === Math.sign(next.price_byn - old.price_byn);
    return same && moved(old.price_usd, next.price_usd) && moved(old.price_byn, next.price_byn)
      ? change('USD', old.price_usd, next.price_usd)
      : null;
  }
  if (usd) return moved(old.price_usd, next.price_usd) ? change('USD', old.price_usd, next.price_usd) : null;
  if (byn) return moved(old.price_byn, next.price_byn) ? change('BYN', old.price_byn, next.price_byn) : null;
  return null;
}
