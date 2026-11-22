-- Тип объекта у объявления и выбор типов в поиске: specs/002-search-ux-improvements/data-model.md.
-- Колонки добавляются без перезаписи строк; у старых объявлений kind = NULL (тип неизвестен).

ALTER TABLE listings ADD COLUMN kind TEXT CHECK (kind IN ('house', 'cottage', 'dacha', 'part'));

ALTER TABLE searches ADD COLUMN kinds TEXT NOT NULL DEFAULT 'house,dacha,part' CHECK (kinds <> '');
