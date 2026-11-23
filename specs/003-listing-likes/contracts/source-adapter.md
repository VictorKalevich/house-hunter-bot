# Контракт: изменения адаптера источника (фича 003)

Базовый контракт — [source-adapter.md 001](../../001-house-listing-alerts/contracts/source-adapter.md). Здесь — только
то, что добавляется. Решения — [research.md](../research.md) R6, R7, R9.

## RawListing: валюта продавца

| Поле | Тип | Правила |
|---|---|---|
| `priceCurrency` | `'USD'` \| `'BYN'` \| `'EUR'` \| null | Валюта, в которой цену указал продавец; `null` — сайт её не сообщает |

Если `priceCurrency` задана, `price` — сумма именно в этой валюте (`price.currency === priceCurrency`). Сумма в
валюте продавца неизвестна — `priceCurrency: null`, даже если валюта известна.

| Сайт | `priceCurrency` | `price` |
|---|---|---|
| realt.by | по `priceCurrency` 840/933/978 | `{ amount: price, currency }` |
| kufar.by | `currency: 'BYR'` → `'BYN'`, `'USD'` → `'USD'`; `'EUR'` → `null` (суммы в евро в выдаче нет) | сумма в рублях или долларах соответственно |
| moyareklama.by | `'BYN'` | `{ amount, currency: 'BYN' }` |
| domovita.by | `null` | как в 001 |

Нормализация пишет `price_currency` и `price_amount` (data-model.md 003).

## Страница объявления — необязательно

```js
export default {
  // …поля 001…

  /**
   * Запрос страницы объявления для суточной проверки понравившихся. Адрес открыт в robots.txt; тот же хост, что у
   * лент (robots.txt источника один). listing — строка listings (id, external_id, url).
   */
  cardRequest(listing) { return { url: '…', accept: 'text/html' }; },

  /** Образец адреса страницы для сверки с robots.txt (как detailRequest('1') в 001). */
  cardSample: 'https://realt.by/sale-cottages/object/1/',

  /**
   * Разбор ответа 200. Чистая функция; null — страница не распознана («не удалось»).
   * gone: true — на странице сказано, что объявление снято (а не 404).
   */
  parseCard(body) {
    return { gone: false, price: { amount, currency } | null, priceCurrency, priceUsd, priceByn, houseArea, plotArea };
  },
};
```

Поля ответа — в формате `RawListing`, как у выдачи этого сайта. Контакты, текст объявления и фото не читаются.

| Сайт | `cardRequest` | `parseCard` | `cost` |
|---|---|---|---|
| realt.by | `listing.url` | `__NEXT_DATA__` → `pageProps.object`: те же функции цены и площадей, что у выдачи; `archive` истинно → `gone` | 2 |
| moyareklama.by | `/single/ad/<external_id>` (как `detailRequest`) | `<div class="price">` → BYN; площади — из `<title>` разбором заголовка выдачи | 1 |
| kufar.by, domovita.by | — | — | — |

kufar.by и domovita.by — без проверки страниц (research.md R6).

## Ошибки проверки страницы

`poll-feeds`, вид работы `card`:

| Что произошло | Объявление | Источник |
|---|---|---|
| 200, `parseCard` → `gone: false` | на месте: `check_ok_at`, `gone_at = NULL`, цена и площади | не меняется |
| 200, `parseCard` → `gone: true`; 404; 410 | снято: `gone_at` | не меняется |
| 403, 423, 429, страница защиты | только `checked_at` | `blocked`, как у ленты (`onFailure`) |
| 200, `parseCard` → `null`; 5xx; тайм-аут; сеть | только `checked_at` | не меняется |

Правила (принцип I в редакции 1.3.0):

- Страница — та же работа сайта, что страница ленты: один запрос к сайту за тик, пауза ≥ 1 мин (`claimSite`).
  Не чаще одной страницы в 3 минуты на сайт (`sources.cards_next_at`).
- Объявление проверяется не чаще раза в сутки, только если у кого-то оно в понравившихся и за сутки его не было в
  выдаче.
- Источник `blocked` или `disallowed` страниц не проверяет.
- `cardSample` сверяется с robots.txt вместе с адресами лент. Закрыт — источник `disallowed`.
- Заголовки — те же, что у лент.

## Тесты (принцип V)

- Разбор: `tests/sources/<id>.test.mjs` на сохранённых страницах, обезличенных (`tests/unit/security.test.mjs`):
  - `tests/fixtures/realt/card.html` — живое объявление: цена, валюта, площади;
  - `tests/fixtures/realt/card-archived.html` — та же страница с `archive: 1`;
  - `tests/fixtures/moyareklama/card.html` — уже есть: цена и площади;
  - неразобранная страница → `null`.
- `priceCurrency` у каждого объявления сохранённых страниц выдачи — по таблице выше.
- `npm run bench` — `parseCard` укладывается в `cost`.
