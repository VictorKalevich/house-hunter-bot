import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signInitData, verifyInitData } from '../../src/http/miniapp-auth.js';

const TOKEN = '123456:TEST-token';
const now = Date.parse('2026-11-22T12:00:00Z');
const authDate = String(Math.floor(now / 1000) - 60);
const user = { id: 42, first_name: 'Тест', username: 'test' };

test('верная подпись → пользователь', async () => {
  const initData = await signInitData({ auth_date: authDate, query_id: 'AAA', user }, TOKEN);
  assert.deepEqual(await verifyInitData(initData, TOKEN, now), { user });
});

test('подпись совпадает с эталоном Telegram (HMAC через node:crypto)', async () => {
  const fields = { auth_date: authDate, user: JSON.stringify(user), query_id: 'AAA' };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const initData = new URLSearchParams({ ...fields, hash }).toString();
  assert.deepEqual(await verifyInitData(initData, TOKEN, now), { user });
});

test('чужой токен, без hash, подделка поля → unauthorized', async () => {
  const initData = await signInitData({ auth_date: authDate, user }, TOKEN);
  assert.deepEqual(await verifyInitData(initData, '999:other', now), { error: 'unauthorized' });
  const noHash = new URLSearchParams(initData);
  noHash.delete('hash');
  assert.deepEqual(await verifyInitData(noHash.toString(), TOKEN, now), { error: 'unauthorized' });
  const forged = new URLSearchParams(initData);
  forged.set('user', JSON.stringify({ ...user, id: 1 }));
  assert.deepEqual(await verifyInitData(forged.toString(), TOKEN, now), { error: 'unauthorized' });
  assert.deepEqual(await verifyInitData('', TOKEN, now), { error: 'unauthorized' });
});

test('auth_date старше 24 ч → unauthorized', async () => {
  const old = await signInitData({ auth_date: String(Math.floor(now / 1000) - 24 * 3600 - 1), user }, TOKEN);
  assert.deepEqual(await verifyInitData(old, TOKEN, now), { error: 'unauthorized' });
  const fresh = await signInitData({ auth_date: String(Math.floor(now / 1000) - 24 * 3600 + 60), user }, TOKEN);
  assert.deepEqual(await verifyInitData(fresh, TOKEN, now), { user });
});
