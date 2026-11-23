-- Успешные запросы к сайту подряд: сбой, о котором сообщили владельцу, закрывается после трёх
-- (.specify/bugs/source-alert-flapping/). Колонка добавляется без перезаписи строк.

ALTER TABLE sources ADD COLUMN consecutive_ok INTEGER NOT NULL DEFAULT 0;
