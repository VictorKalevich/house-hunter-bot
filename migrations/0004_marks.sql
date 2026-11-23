-- Отметки пользователя, сообщения об изменении цены, цена продавца и проверка страниц объявлений:
-- specs/003-listing-likes/data-model.md. Колонки добавляются без перезаписи строк.

CREATE TABLE marks (
  user_id    INTEGER NOT NULL REFERENCES users (telegram_id),
  listing_id INTEGER NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('like', 'hide')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, listing_id)
) WITHOUT ROWID;
CREATE INDEX marks_user ON marks (user_id, kind, created_at);
CREATE INDEX marks_kind ON marks (kind, listing_id);

CREATE TABLE price_alerts (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users (telegram_id),
  listing_id      INTEGER NOT NULL REFERENCES listings (id) ON DELETE CASCADE,
  currency        TEXT NOT NULL CHECK (currency IN ('USD', 'BYN', 'EUR')),
  old_price       REAL NOT NULL CHECK (old_price > 0),
  new_price       REAL NOT NULL CHECK (new_price > 0 AND new_price <> old_price),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'undeliverable', 'uncertain', 'cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX price_alerts_queue ON price_alerts (status, next_attempt_at);
CREATE INDEX price_alerts_created ON price_alerts (created_at);

ALTER TABLE listings ADD COLUMN price_amount REAL CHECK (price_amount > 0);
ALTER TABLE listings ADD COLUMN price_currency TEXT CHECK (price_currency IN ('USD', 'BYN', 'EUR'));
ALTER TABLE listings ADD COLUMN checked_at INTEGER;
ALTER TABLE listings ADD COLUMN check_ok_at INTEGER;
ALTER TABLE listings ADD COLUMN gone_at INTEGER;

ALTER TABLE sources ADD COLUMN cards_next_at INTEGER;
