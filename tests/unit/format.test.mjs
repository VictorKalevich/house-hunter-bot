import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceLabel, markKeyboard, notificationMessage, priceAlertMessage } from '../../src/match/format.js';

const listing = (over = {}) => ({
  source: 'kufar', external_id: '1', url: 'https://re.kufar.by/vi/1',
  price_usd: 75000, price_byn: 245000, house_m2: 100, plot_sotki: 15,
  place_text: 'д. Боровляны, Минский р-н', photo_url: 'https://rms.kufar.by/v1/gallery/a.jpg',
  published_at: Date.parse('2026-11-22T09:41:00Z'), first_seen_at: Date.parse('2026-11-22T09:45:00Z'),
  ...over,
});

test('уведомление: цена $, площади, расстояние, место, сайт и поиск', () => {
  const m = notificationMessage(listing(), { searchTitles: ['Минск · до 30 км по прямой'], distanceLabel: 'Минск: 25 км по прямой' });
  assert.equal(m.text, [
    '<b>75 000 $</b> · дом 100 м² · участок 15 сот.',
    'Минск: 25 км по прямой',
    'д. Боровляны, Минский р-н',
    'kufar.by · Поиск: «Минск · до 30 км по прямой»',
  ].join('\n'));
  assert.equal(m.parse_mode, 'HTML');
});

test('цена BYN, «цена не указана», «не указано» у площадей', () => {
  assert.match(notificationMessage(listing({ price_usd: null }), { searchTitles: ['a'] }).text, /^<b>245 000 BYN<\/b>/);
  const m = notificationMessage(listing({ price_usd: null, price_byn: null, house_m2: null, plot_sotki: null }), { searchTitles: ['a'] });
  assert.match(m.text, /^цена не указана · дом: не указано · участок: не указано\n/);
});

test('тип объекта — первым словом; без типа — как раньше (фича 002)', () => {
  const first = (over) => notificationMessage(listing(over), { searchTitles: ['a'] }).text.split('\n')[0];
  assert.equal(first({ kind: 'dacha', price_usd: 45000, house_m2: 40, plot_sotki: 6 }), 'Дача · <b>45 000 $</b> · дом 40 м² · участок 6 сот.');
  assert.equal(first({ kind: 'house' }), 'Дом · <b>75 000 $</b> · дом 100 м² · участок 15 сот.');
  assert.match(first({ kind: 'cottage' }), /^Коттедж · <b>/);
  assert.match(first({ kind: 'part', price_usd: null, price_byn: null }), /^Часть дома · цена не указана · /);
  assert.equal(first({ kind: null }), '<b>75 000 $</b> · дом 100 м² · участок 15 сот.');
});

test('несколько поисков; без расстояния строки нет', () => {
  const m = notificationMessage(listing(), { searchTitles: ['А', 'Б'] });
  assert.equal(m.text.split('\n').length, 3);
  assert.match(m.text, /kufar\.by · Поиски: «А», «Б»$/);
});

test('экранирование текста с сайтов и названий поисков', () => {
  const m = notificationMessage(listing({ place_text: 'д. <b>X</b> & Co' }), { searchTitles: ['<script>'] });
  assert.ok(m.text.includes('д. &lt;b&gt;X&lt;/b&gt; &amp; Co'));
  assert.ok(m.text.includes('«&lt;script&gt;»'));
  assert.ok(!m.text.includes('<script>'));
});

test('кнопка «Открыть объявление» и превью с фото / без фото', () => {
  const m = notificationMessage(listing(), { searchTitles: ['a'] });
  assert.deepEqual(m.reply_markup, { inline_keyboard: [[{ text: 'Открыть объявление', url: 'https://re.kufar.by/vi/1' }]] });
  assert.deepEqual(m.link_preview_options, { url: 'https://rms.kufar.by/v1/gallery/a.jpg', prefer_large_media: true, show_above_text: true });
  assert.deepEqual(notificationMessage(listing({ photo_url: null }), { searchTitles: ['a'] }).link_preview_options, { is_disabled: true });
});

test('кнопки отметок: без отметки, лайк, скрыто (фича 003)', () => {
  const open = [{ text: 'Открыть объявление', url: 'https://re.kufar.by/vi/1' }];
  const l = { id: 48213, url: 'https://re.kufar.by/vi/1' };
  assert.deepEqual(markKeyboard(l, null).inline_keyboard, [open, [
    { text: '♡ Нравится', callback_data: 'lk:48213' }, { text: 'Не интересно', callback_data: 'hd:48213' },
  ]]);
  assert.deepEqual(markKeyboard(l, 'like').inline_keyboard, [open, [
    { text: '♥ В понравившихся', callback_data: 'ul:48213' }, { text: 'Не интересно', callback_data: 'hd:48213' },
  ]]);
  assert.deepEqual(markKeyboard(l, 'hide').inline_keyboard, [open, [{ text: 'Скрыто · вернуть', callback_data: 'uh:48213' }]]);
  const longest = markKeyboard({ id: 999_999_999_999_999, url: l.url }, 'like').inline_keyboard.flat().filter((b) => b.callback_data);
  for (const b of longest) assert.ok(new TextEncoder().encode(b.callback_data).length <= 64);
});

test('уведомление: кнопки отметок по текущей отметке (фича 003)', () => {
  const rows = (mark) => notificationMessage(listing(), { searchTitles: ['a'], listingId: 7, mark }).reply_markup.inline_keyboard;
  assert.equal(rows(null).length, 2);
  assert.equal(rows(null)[1][0].callback_data, 'lk:7');
  assert.equal(rows('like')[1][0].text, '♥ В понравившихся');
});

test('подписи расстояния: способы, «≈», запасной расчёт', () => {
  assert.equal(distanceLabel({ km: 25.4, mode: 'straight', settlementName: 'Минск' }), 'Минск: 25 км по прямой');
  assert.equal(distanceLabel({ km: 38, mode: 'road_center', settlementName: 'Минск' }), 'Минск: 38 км по дороге от центра');
  assert.equal(distanceLabel({ km: 31.2, mode: 'road_exit', approx: true, settlementName: 'Боровляны' }), 'Боровляны: ≈ 31 км по дороге от выезда');
  assert.equal(distanceLabel({ km: 4.25, mode: 'road_exit', settlementName: 'Х' }), 'Х: 4,3 км по дороге от выезда');
  assert.equal(distanceLabel({ km: 0, mode: 'road_exit', settlementName: 'Х' }), 'Х: 0 км по дороге от выезда');
  assert.equal(distanceLabel({ km: 26, mode: 'road_center', fallback: true, settlementName: 'Минск' }), 'Минск: 26 км по прямой (маршрут не построен)');
});

test('сообщение об изменении цены: цены, разница, строка дома без <b>, сайт, кнопки «лайк» (фича 003)', () => {
  const row = {
    listing_id: 48213, source: 'realt', url: 'https://realt.by/sale-cottages/object/1/', kind: 'house',
    price_usd: 48000, price_byn: 144000, house_m2: 90, plot_sotki: 12, place_text: 'д. Боровляны, Минский р-н',
    photo_url: null,
  };
  const m = priceAlertMessage(row, { currency: 'USD', oldPrice: 52000, newPrice: 48000 });
  assert.equal(m.text, [
    'Цена изменилась: было <b>52 000 $</b>, стало <b>48 000 $</b> (−4 000 $)',
    'Дом · 48 000 $ · дом 90 м² · участок 12 сот.',
    'д. Боровляны, Минский р-н',
    'realt.by · в понравившихся',
  ].join('\n'));
  assert.equal(m.parse_mode, 'HTML');
  assert.deepEqual(m.reply_markup, markKeyboard({ id: 48213, url: row.url }, 'like'));
  assert.deepEqual(m.link_preview_options, { is_disabled: true });

  const up = priceAlertMessage({ ...row, price_usd: null, price_byn: 7500, source: 'moyareklama', place_text: '' },
    { currency: 'BYN', oldPrice: 7000, newPrice: 7500 });
  assert.match(up.text, /^Цена изменилась: было <b>7 000 BYN<\/b>, стало <b>7 500 BYN<\/b> \(\+500 BYN\)\nДом · 7 500 BYN · /);
  assert.match(up.text, /\nmoyareklama\.by · в понравившихся$/);
  assert.equal(up.text.split('\n').length, 3, 'без места — без строки места');
  assert.match(priceAlertMessage(row, { currency: 'EUR', oldPrice: 60000, newPrice: 57000 }).text, /^Цена изменилась: было <b>60 000 €<\/b>, стало <b>57 000 €<\/b> \(−3 000 €\)/);
  assert.equal(priceAlertMessage({ ...row, place_text: '<b>&' }, { currency: 'USD', oldPrice: 1, newPrice: 2 }).text.split('\n')[2], '&lt;b&gt;&amp;');
});
