// Проверка initData мини-приложения: core.telegram.org/bots/webapps, research.md R7.
import { INIT_DATA_MAX_AGE_S } from '../config.js';

const enc = new TextEncoder();

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function dataCheckString(params) {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

async function signature(params, botToken) {
  const secret = await hmacSha256(enc.encode('WebAppData'), botToken);
  return toHex(await hmacSha256(secret, dataCheckString(params)));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {string} initData строка Telegram.WebApp.initData
 * @returns {Promise<{user: {id: number, first_name?: string, username?: string}} | {error: 'unauthorized'}>}
 */
export async function verifyInitData(initData, botToken, nowMs = Date.now(), maxAgeS = INIT_DATA_MAX_AGE_S) {
  const fail = { error: 'unauthorized' };
  if (!initData || !botToken) return fail;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return fail;
  if (!sameString(await signature(params, botToken), hash.toLowerCase())) return fail;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > maxAgeS) return fail;

  let user = null;
  try {
    user = JSON.parse(params.get('user') ?? 'null');
  } catch {
    return fail;
  }
  if (!user || !Number.isSafeInteger(user.id)) return fail;
  return { user };
}

/** Подписанная строка initData — для тестов и сквозного стенда. */
export async function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  params.set('hash', await signature(params, botToken));
  return params.toString();
}
