import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceLabel, notificationMessage } from '../../src/match/format.js';

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

test('подписи расстояния: способы, «≈», запасной расчёт', () => {
  assert.equal(distanceLabel({ km: 25.4, mode: 'straight', settlementName: 'Минск' }), 'Минск: 25 км по прямой');
  assert.equal(distanceLabel({ km: 38, mode: 'road_center', settlementName: 'Минск' }), 'Минск: 38 км по дороге от центра');
  assert.equal(distanceLabel({ km: 31.2, mode: 'road_exit', approx: true, settlementName: 'Боровляны' }), 'Боровляны: ≈ 31 км по дороге от выезда');
  assert.equal(distanceLabel({ km: 4.25, mode: 'road_exit', settlementName: 'Х' }), 'Х: 4,3 км по дороге от выезда');
  assert.equal(distanceLabel({ km: 0, mode: 'road_exit', settlementName: 'Х' }), 'Х: 0 км по дороге от выезда');
  assert.equal(distanceLabel({ km: 26, mode: 'road_center', fallback: true, settlementName: 'Минск' }), 'Минск: 26 км по прямой (маршрут не построен)');
});
