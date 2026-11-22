// Конституция, «Безопасность и данные»: сохранённые страницы обезличены, интерфейс не вставляет HTML из данных,
// тексты объявлений и контакты не попадают в логи.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir, filter = () => true) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, filter));
    else if (filter(path)) out.push(path);
  }
  return out;
}

const rel = (path) => relative(ROOT, path).replace(/\\/g, '/');

/** Текст с раскрытыми \uXXXX (JSON) и числовыми HTML-сущностями — так телефон не спрячется за экранированием. */
function decoded(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

const fixtures = walk(join(ROOT, 'tests/fixtures')).map((path) => ({ path, text: decoded(readFileSync(path, 'utf8')) }));

const STUB_PHONE_DIGITS = '375000000000'; // заглушка «+375 00 000-00-00»
const PHONE_375 = /(?:\+|\b)375[\s\-().]*\d{2}[\s\-().]*\d{3}[\s\-.]*\d{2}[\s\-.]*\d{2}\b/g;
const PHONE_8 = /\b8[\s\-(]*0(?:15|16|17|21|22|23|25|29|33|44)[\s\-)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const EMAIL_OK = /@example\.(?:com|org|net)$|@\d+x\.(?:png|jpe?g|webp|svg|gif)$/i; // заглушка или имя картинки «logo@2x.png»
const TEL = /tel:[^"'<>\s]*/gi;

test('в фикстурах нет телефонов, кроме заглушки +375 00 000-00-00', () => {
  const found = [];
  for (const { path, text } of fixtures) {
    for (const m of text.matchAll(PHONE_375)) if (m[0].replace(/\D/g, '') !== STUB_PHONE_DIGITS) found.push(`${rel(path)}: ${m[0]}`);
    for (const m of text.matchAll(PHONE_8)) found.push(`${rel(path)}: ${m[0]}`);
    for (const m of text.matchAll(TEL)) if (m[0].replace(/\D/g, '') !== STUB_PHONE_DIGITS) found.push(`${rel(path)}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
});

test('в фикстурах нет e-mail, кроме заглушек @example.com', () => {
  const found = [];
  for (const { path, text } of fixtures) for (const m of text.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) found.push(`${rel(path)}: ${m[0]}`);
  assert.deepEqual(found, []);
});

const NAME_KEYS = /^(?:contactName|contact_name|contact_person|contactPerson|sellerName|seller_name|agentName|agent_name|fio)$/;
const STUB_NAMES = new Set(['', 'Продавец']);

/** JSON фикстуры: сам файл .json или __NEXT_DATA__ страницы. */
function jsonOf({ path, text }) {
  if (path.endsWith('.json')) return JSON.parse(text);
  const m = text.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

test('имена продавцов в полях контактов заменены заглушкой «Продавец»', () => {
  const found = [];
  const visit = (node, path) => {
    if (Array.isArray(node)) return node.forEach((v) => visit(v, path));
    if (!node || typeof node !== 'object') return;
    // kufar: account_parameters [{p: 'name' | 'contact_person', v: '…'}]
    if ((node.p === 'name' || node.p === 'contact_person') && typeof node.v === 'string' && !STUB_NAMES.has(node.v)) {
      found.push(`${path}: ${node.p}=${node.v}`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (NAME_KEYS.test(key) && typeof value === 'string' && !STUB_NAMES.has(value)) found.push(`${path}: ${key}=${value}`);
      visit(value, path);
    }
  };
  let checked = 0;
  for (const f of fixtures) {
    const json = jsonOf(f);
    if (json === null) continue;
    checked += 1;
    visit(json, rel(f.path));
  }
  assert.ok(checked >= 10, `проверено JSON-фикстур: ${checked}`);
  assert.deepEqual(found, []);
});

test('мини-приложение не вставляет HTML из данных', () => {
  const app = readFileSync(join(ROOT, 'src/app/app.js.txt'), 'utf8');
  for (const api of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) {
    assert.equal(app.includes(api), false, api);
  }
  assert.ok(app.includes('textContent'), 'текст выводится через textContent');
});

/** Аргументы вызова или литерал объекта, начиная с открывающей скобки в позиции start. */
function balanced(source, start) {
  const open = source[start];
  const close = { '(': ')', '{': '}' }[open];
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`нет закрывающей скобки с позиции ${start}`);
}

// Поля с текстом объявления, содержимым страницы и контактами. Описание ошибки Bot API (`res.description`
// в deliver.js) — текст Telegram о запросе, а не объявления: оно разрешено.
const FORBIDDEN = /(?<![\w.])(?:place_text|text|description|body|html|title|phones?|contacts?|contact_\w+|email|first_name|username|address)\b|\.(?:text|place_text|description|body|html|title|phones?|email|first_name|username)\b/;
const ALLOWED = [/\bdescription:\s*res\.description\b/g];
const strip = (snippet) => ALLOWED.reduce((s, re) => s.replace(re, ''), snippet.replace(/'[^']*'|"[^"]*"/g, "''"));

test('в логи не уходят тексты объявлений, страниц и контакты', () => {
  const found = [];
  let calls = 0;
  for (const path of walk(join(ROOT, 'src'), (p) => p.endsWith('.js'))) {
    const source = readFileSync(path, 'utf8');
    for (const m of source.matchAll(/console\.(?:log|error|warn|info|debug)\(/g)) {
      calls += 1;
      const args = balanced(source, m.index + m[0].length - 1);
      if (FORBIDDEN.test(strip(args))) found.push(`${rel(path)}: ${args}`);
    }
  }
  assert.ok(calls > 0);
  assert.deepEqual(found, []);
});

test('отчёты шагов тика и суточной задачи (они попадают в лог) — без текстов и контактов', () => {
  const found = [];
  let literals = 0;
  for (const path of walk(join(ROOT, 'src/jobs'), (p) => p.endsWith('.js'))) {
    const source = readFileSync(path, 'utf8');
    for (const m of source.matchAll(/\b(?:report|stats|line)(?:\.push\(|\s*[:=]\s*(?:\{\s*\.\.\.report,)?)\s*(?=\{)/g)) {
      const literal = balanced(source, m.index + m[0].length);
      literals += 1;
      if (FORBIDDEN.test(strip(literal))) found.push(`${rel(path)}: ${literal}`);
    }
  }
  assert.ok(literals >= 5, `найдено литералов отчётов: ${literals}`);
  assert.deepEqual(found, []);
});
