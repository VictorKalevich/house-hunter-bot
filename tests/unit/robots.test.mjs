import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAllowed, parseRobots } from '../../src/sources/robots.js';

const UA = 'house-hunter-bot/0.1.0 (+https://t.me/house_hunter_bot)';
const fixture = (name) => parseRobots(readFileSync(new URL(`../fixtures/robots/${name}.txt`, import.meta.url), 'utf8'));

test('Allow/Disallow, * и $, самое длинное правило', () => {
  const r = parseRobots([
    'User-agent: *',
    'Disallow: /private/',
    'Allow: /private/open/',
    'Disallow: /*.php$',
    'Disallow: *sort=*',
    'Allow: *page=2',
    'Disallow: *=',
  ].join('\n'));
  assert.equal(isAllowed(r, 'https://x.by/', UA), true);
  assert.equal(isAllowed(r, 'https://x.by/private/a', UA), false);
  assert.equal(isAllowed(r, 'https://x.by/private/open/a', UA), true);
  assert.equal(isAllowed(r, 'https://x.by/index.php', UA), false);
  assert.equal(isAllowed(r, 'https://x.by/index.php?x=1', UA), false, '*= закрывает любой параметр');
  assert.equal(isAllowed(r, 'https://x.by/index.phpx', UA), true);
  assert.equal(isAllowed(r, 'https://x.by/list/?page=2', UA), true);
  assert.equal(isAllowed(r, 'https://x.by/list/?sort=date', UA), false);
});

test('при равной длине побеждает Allow; пустой Disallow ничего не закрывает', () => {
  const r = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\nDisallow:\n');
  assert.equal(isAllowed(r, 'https://x.by/a', UA), true);
  assert.equal(isAllowed(r, 'https://x.by/b', UA), true);
});

test('группы User-agent: своя группа важнее *, несколько агентов в одной группе', () => {
  const r = parseRobots([
    'User-agent: Googlebot',
    'User-agent: house-hunter-bot',
    'Disallow: /only-us/',
    '',
    'User-agent: *',
    'Disallow: /',
  ].join('\n'));
  assert.equal(isAllowed(r, 'https://x.by/page', UA), true);
  assert.equal(isAllowed(r, 'https://x.by/only-us/1', UA), false);
  assert.equal(isAllowed(r, 'https://x.by/page', 'OtherBot/1.0'), false);
});

test('кириллица в правилах и адресах сравнивается в раскодированном виде', () => {
  const r = parseRobots('User-agent: *\nDisallow: /*/%D0%B2%D1%81%D0%B5/\n');
  assert.equal(isAllowed(r, 'https://moyareklama.by/Гомель/все/', UA), false);
  assert.equal(isAllowed(r, encodeURI('https://moyareklama.by/Гомель/дома_продажа/'), UA), true);
});

test('нет robots.txt (null) — всё разрешено', () => {
  assert.equal(isAllowed(null, 'https://api.kufar.by/search-api/v2/search/rendered-paginated?cat=1020', UA), true);
});

test('realt.by: ленты и ?page=2 открыты, сортировка, GraphQL и _next закрыты', () => {
  const r = fixture('realt');
  for (const region of ['brest', 'vitebsk', 'gomel', 'grodno', 'mogilev']) {
    for (const kind of ['cottages', 'dachi']) {
      assert.equal(isAllowed(r, `https://realt.by/${region}-region/sale/${kind}/`, UA), true);
      assert.equal(isAllowed(r, `https://realt.by/${region}-region/sale/${kind}/?page=2`, UA), true);
    }
  }
  assert.equal(isAllowed(r, 'https://realt.by/sale/cottages/', UA), true);
  assert.equal(isAllowed(r, 'https://realt.by/sale/cottages/?page=2', UA), true);
  assert.equal(isAllowed(r, 'https://realt.by/sale/cottages/?sortType=createdAt', UA), false);
  assert.equal(isAllowed(r, 'https://realt.by/bff/graphql', UA), false);
  assert.equal(isAllowed(r, 'https://realt.by/_next/data/abc/sale/cottages.json', UA), false);
});

test('domovita.by: _next/data и ?page открыты, другие параметры закрыты', () => {
  const r = fixture('domovita');
  assert.equal(isAllowed(r, 'https://domovita.by/gomelskaya-oblast/houses/sale', UA), true);
  assert.equal(isAllowed(r, 'https://domovita.by/_next/data/abc123/gomelskaya-oblast/houses/sale.json', UA), true);
  assert.equal(isAllowed(r, 'https://domovita.by/_next/data/abc123/gomelskaya-oblast/houses/sale.json?page=2', UA), true);
  assert.equal(isAllowed(r, 'https://domovita.by/gomelskaya-oblast/houses/sale?order=-date', UA), false);
});

test('moyareklama.by: разделы и карточки открыты, /search/ и /все/ закрыты', () => {
  const r = fixture('moyareklama');
  for (const path of ['/Гомель/дома_продажа/', '/Гомельский_район/дома_продажа/', '/single/ad/12345']) {
    assert.equal(isAllowed(r, encodeURI(`https://moyareklama.by${path}`), UA), true, path);
  }
  assert.equal(isAllowed(r, 'https://moyareklama.by/search/js/a.js', UA), false);
  assert.equal(isAllowed(r, encodeURI('https://moyareklama.by/Гомель/все/дома_продажа/'), UA), false);
});

test('kufar.by: HTML-выдача с параметрами закрыта (поэтому бот читает api.kufar.by без robots.txt)', () => {
  const r = fixture('kufar');
  assert.equal(isAllowed(r, 'https://re.kufar.by/l/belarus/kupit/dom?sort=lst.d', UA), false);
  assert.equal(isAllowed(r, 'https://re.kufar.by/l/belarus/kupit/dom', UA), true);
});
