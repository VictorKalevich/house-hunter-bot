// Проверка Конституции, принцип VII «Только дизайн-система».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const tokens = read('design-system/tokens.css');
const components = read('design-system/components.css');
const preview = read('design-system/preview.html');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const RAW_PX = /\d(\.\d+)?px\b/;

const definedTokens = new Set([...tokens.matchAll(/(--ds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const definedClasses = new Set([...stripComments(components).matchAll(/\.(ds-[a-z0-9_-]+)/g)].map((m) => m[1]));
const usedClasses = (text) => [...text.matchAll(/class(?:Name)?\s*[:=]\s*['"`]([^'"`]+)['"`]/g)]
  .flatMap((m) => m[1].split(/\s+/)).filter(Boolean);

// Файлы мини-приложения: всё, что лежит в src/app/ (появится по плану фичи).
const APP_DIR = join(root, 'src', 'app');
const appFiles = existsSync(APP_DIR)
  ? readdirSync(APP_DIR, { recursive: true }).map(String).filter((f) => /\.(html|m?js|txt)$/.test(f))
  : [];
const app = appFiles.map((f) => [f, readFileSync(join(APP_DIR, f), 'utf8')]);
const noApp = appFiles.length === 0 && 'мини-приложения ещё нет (src/app/)';

test('компоненты используют только токены: нет сырых цветов и px', () => {
  stripComments(components).split('\n').forEach((line, i) => {
    assert.ok(!RAW_COLOR.test(line), `components.css:${i + 1} — сырой цвет: ${line.trim()}`);
    assert.ok(!RAW_PX.test(line), `components.css:${i + 1} — сырые px: ${line.trim()}`);
  });
});

test('базовые стили элементов не перебивают компоненты (только через :where)', () => {
  const css = stripComments(components);
  const bad = css.match(/(^|[,}])\s*\.ds-root\s+(button|input|textarea|select|a|label|span|div|p|h[1-6]|img)\b[^{]*\{/gm);
  assert.equal(bad, null, `базовый селектор без :where(): ${bad && bad[0].trim()}`);
  assert.match(css, /:where\(\.ds-root\)\s*:where\(button, input, textarea, select\)/);
});

test('все var(--ds-*) в компонентах и витрине определены в токенах', () => {
  for (const [name, text] of [['components.css', components], ['preview.html', preview]]) {
    for (const m of text.matchAll(/var\((--ds-[a-z0-9-]+)/g)) {
      assert.ok(definedTokens.has(m[1]), `${name}: токен ${m[1]} не определён в tokens.css`);
    }
  }
});

test('витрина: классы ds-* описаны в компонентах, и каждый компонент показан', () => {
  for (const cls of usedClasses(preview).filter((c) => c.startsWith('ds-'))) {
    assert.ok(definedClasses.has(cls), `preview.html: класс .${cls} не описан в components.css`);
  }
  const blocks = new Set([...definedClasses].map((c) => c.split('__')[0].split('--')[0]));
  blocks.delete('ds-root');
  for (const b of blocks) assert.ok(preview.includes(b), `превью не показывает компонент .${b}`);
});

test('системные элементы в схеме темы Telegram', () => {
  assert.match(tokens, /--ds-color-scheme:\s*var\(--tg-color-scheme,\s*light dark\)/);
  const css = stripComments(components);
  assert.match(css, /:where\(:root, \.ds-theme\)\s*\{\s*color-scheme:\s*var\(--ds-color-scheme\)/);
  assert.match(css, /:where\(\.ds-root\)\s*:where\(option, optgroup\)\s*\{[^}]*background-color:\s*var\(--ds-color-surface\)[^}]*color:\s*var\(--ds-color-text\)/);
});

// Цвета, которые не зависят от темы Telegram: текст на них должен читаться (WCAG AA, ≥ 4.5 : 1).
const hexToken = (name) => {
  const m = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  assert.ok(m, `${name} должен быть задан цветом #rrggbb`);
  return m[1];
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('фиксированные цвета: контраст текста ≥ 4.5 : 1', () => {
  const pairs = [
    ['--ds-color-on-brand', '--ds-color-brand-light'],
    ['--ds-color-on-brand', '--ds-color-brand'],
    ['--ds-color-on-brand', '--ds-color-brand-strong'],
    ['--ds-color-on-status', '--ds-color-success'],
    ['--ds-color-on-status', '--ds-color-warning'],
    ['--ds-color-toast-text', '--ds-color-toast-bg'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(hexToken(fg), hexToken(bg));
    assert.ok(ratio >= 4.5, `${fg} на ${bg}: контраст ${ratio.toFixed(2)} < 4.5`);
  }
});

test('от противного: проверка контраста ловит слабую пару', () => {
  assert.ok(contrast('#ffffff', '#7fbf7f') < 4.5);
  assert.ok(contrast('#ffffff', '#000000') > 20);
});

test('мини-приложение не содержит своих стилей: только встраиваемая дизайн-система', { skip: noApp }, () => {
  for (const [f, text] of app) {
    const styles = [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1].trim());
    assert.ok(styles.every((s) => s === '/*@design-system*/'), `${f}: допускается только <style>/*@design-system*/</style>`);
    assert.ok(!/\sstyle=/.test(text), `${f}: атрибуты style= запрещены`);
    assert.ok(!/[{,]\s*['"]?style['"]?\s*:/.test(text), `${f}: style в атрибутах из кода запрещён`);
    assert.ok(!RAW_COLOR.test(text.replace(/<script src=[^>]+><\/script>/g, '')), `${f}: сырые цвета запрещены`);
    assert.ok(!RAW_PX.test(text), `${f}: сырые px запрещены`);
  }
});

test('мини-приложение: только классы ds-*, и каждый описан в компонентах', { skip: noApp }, () => {
  for (const [f, text] of app) {
    for (const cls of usedClasses(text)) {
      if (cls.includes('$') || cls.includes('+')) continue;
      assert.ok(cls.startsWith('ds-'), `${f}: класс «${cls}» не из дизайн-системы`);
      assert.ok(definedClasses.has(cls), `${f}: класс .${cls} не описан в components.css`);
    }
  }
});
