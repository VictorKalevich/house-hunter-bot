// node scripts/setup-telegram.mjs [--dry-run] — настройка бота по contracts/telegram-bot.md после выката:
// setWebhook (секрет, только message и callback_query), команда /start, кнопка меню «Поиски» → мини-приложение.
//
// Значения: переменные окружения, затем .dev.vars, затем vars из wrangler.jsonc (PUBLIC_URL).
// --dry-run печатает запросы без отправки; токен и секрет не печатаются.
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const DRY_RUN = process.argv.includes('--dry-run');
const ALLOWED_UPDATES = ['message', 'callback_query'];

function readDevVars() {
  const file = new URL('.dev.vars', ROOT);
  if (!existsSync(file)) return {};
  const vars = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

/** JSONC → JSON: убрать комментарии вне строк и висячие запятые. */
function parseJsonc(text) {
  let out = '';
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') out += text[++i];
      else if (ch === '"') quote = false;
    } else if (ch === '"') {
      quote = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readWranglerVars() {
  const file = new URL('wrangler.jsonc', ROOT);
  return existsSync(file) ? (parseJsonc(readFileSync(file, 'utf8')).vars ?? {}) : {};
}

const sources = [process.env, readDevVars(), readWranglerVars()];
const value = (name) => sources.map((s) => s[name]).find((v) => typeof v === 'string' && v.trim() !== '')?.trim() ?? null;

const BOT_TOKEN = value('BOT_TOKEN');
const WEBHOOK_SECRET = value('WEBHOOK_SECRET');
const PUBLIC_URL = value('PUBLIC_URL')?.replace(/\/+$/, '') ?? null;

const problems = [];
if (!PUBLIC_URL || !/^https:\/\/[^/]+/.test(PUBLIC_URL)) problems.push('PUBLIC_URL — адрес Worker\'а с https://');
else if (new URL(PUBLIC_URL).hostname.includes('example')) problems.push(`PUBLIC_URL — заглушка (${PUBLIC_URL}): укажите адрес Worker'а`);
if (!BOT_TOKEN) problems.push('BOT_TOKEN — токен от @BotFather');
if (!WEBHOOK_SECRET) problems.push('WEBHOOK_SECRET — секрет webhook');
else if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) problems.push('WEBHOOK_SECRET — 1–256 символов из A-Z, a-z, 0-9, _ и -');

if (problems.length && !DRY_RUN) {
  console.error(`Не заданы или неверны:\n  ${problems.join('\n  ')}\nЗначения берутся из окружения, .dev.vars и vars в wrangler.jsonc.`);
  process.exit(1);
}

const steps = [
  ['setWebhook', { url: `${PUBLIC_URL}/telegram/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ALLOWED_UPDATES }],
  ['setMyCommands', { commands: [{ command: 'start', description: 'Главное меню' }] }],
  ['setChatMenuButton', { menu_button: { type: 'web_app', text: 'Поиски', web_app: { url: `${PUBLIC_URL}/app` } } }],
];

async function call(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(`${method}: ${data?.description ?? `HTTP ${res.status}`}`);
  return data.result;
}

if (DRY_RUN) {
  if (problems.length) console.log(`Предупреждения (при настоящем запуске — ошибка):\n  ${problems.join('\n  ')}\n`);
  for (const [method, params] of steps) {
    const shown = method === 'setWebhook' ? { ...params, secret_token: WEBHOOK_SECRET ? '***' : null } : params;
    console.log(`POST https://api.telegram.org/bot<BOT_TOKEN>/${method}\n${JSON.stringify(shown, null, 2)}\n`);
  }
  console.log('--dry-run: запросы не отправлены.');
} else {
  try {
    for (const [method, params] of steps) {
      await call(method, params);
      console.log(`${method}: ok`);
    }
    const info = await call('getWebhookInfo', {});
    console.log(`getWebhookInfo: ${info.url}, ожидают обновлений: ${info.pending_update_count}` +
      (info.last_error_message ? `, последняя ошибка: ${info.last_error_message}` : ''));
    if (info.url !== `${PUBLIC_URL}/telegram/webhook`) throw new Error('getWebhookInfo: адрес webhook не совпадает');
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}
