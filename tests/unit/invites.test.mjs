import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { INVITE_PREFIX, createInvite, inviteLink, newInviteToken, useInvite } from '../../src/db/invites.js';

test('токен — 16 случайных байт в base64url, 22 символа', () => {
  for (let i = 0; i < 200; i++) {
    const token = newInviteToken();
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 16);
  }
});

test('токены не повторяются', () => {
  const tokens = new Set(Array.from({ length: 2000 }, newInviteToken));
  assert.equal(tokens.size, 2000);
});

test('параметр /start inv_<token> — не длиннее 64 символов из A-Za-z0-9_- (ограничение Telegram)', () => {
  const token = newInviteToken();
  const link = inviteLink('house_hunter_bot', token);
  assert.equal(link, `https://t.me/house_hunter_bot?start=inv_${token}`);
  const param = new URL(link).searchParams.get('start');
  assert.equal(param, `${INVITE_PREFIX}${token}`);
  assert.ok(param.length <= 64);
  assert.match(param, /^[A-Za-z0-9_-]+$/);
});

// Одноразовость — на настоящей D1 (Miniflare) со схемой migrations/0001_init.sql.
const OWNER = 1000;
const now = Date.parse('2026-11-22T12:00:00Z');
let mf;
let db;

function splitSql(text) {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

before(async () => {
  mf = new Miniflare({ modules: true, script: 'export default {}', d1Databases: ['DB'] });
  db = await mf.getD1Database('DB');
  const migration = readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8');
  for (const sql of splitSql(migration)) await db.prepare(sql).run();
  await db
    .prepare("INSERT INTO users (telegram_id, first_name, role, access, created_at) VALUES (?, 'Владелец', 'owner', 'active', ?)")
    .bind(OWNER, now)
    .run();
});

after(async () => {
  await mf?.dispose();
});

const userRow = (id) => db.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(id).first();
const inviteRow = (token) => db.prepare('SELECT * FROM invites WHERE token = ?').bind(token).first();

test('по приглашению создаётся участник; повторно та же ссылка не работает', async () => {
  const token = await createInvite(db, OWNER, now);
  assert.equal((await inviteRow(token)).created_by, OWNER);

  assert.equal(await useInvite(db, token, { id: 2001, first_name: 'Аня', username: 'anya' }, now + 1000), true);
  const user = await userRow(2001);
  assert.equal(user.role, 'member');
  assert.equal(user.access, 'active');
  assert.equal(user.invited_by, OWNER);
  assert.equal(user.first_name, 'Аня');
  assert.equal(user.username, 'anya');
  const invite = await inviteRow(token);
  assert.equal(invite.used_by, 2001);
  assert.equal(invite.used_at, now + 1000);

  assert.equal(await useInvite(db, token, { id: 2002, first_name: 'Борис' }, now + 2000), false);
  assert.equal(await userRow(2002), null);
  assert.equal((await inviteRow(token)).used_by, 2001);
});

test('неизвестный токен — отказ, пользователь не создаётся', async () => {
  assert.equal(await useInvite(db, newInviteToken(), { id: 2003, first_name: 'Вера' }, now), false);
  assert.equal(await userRow(2003), null);
});

test('пустое имя — «Без имени»', async () => {
  const token = await createInvite(db, OWNER, now);
  assert.equal(await useInvite(db, token, { id: 2004, first_name: '   ' }, now), true);
  assert.equal((await userRow(2004)).first_name, 'Без имени');
});

test('закрытый доступ новым приглашением не открывается, приглашение не тратится', async () => {
  await db
    .prepare("INSERT INTO users (telegram_id, first_name, role, access, created_at, revoked_at) VALUES (2005, 'Гена', 'member', 'revoked', ?, ?)")
    .bind(now, now)
    .run();
  const token = await createInvite(db, OWNER, now);
  assert.equal(await useInvite(db, token, { id: 2005, first_name: 'Гена' }, now + 1000), false);
  assert.equal((await userRow(2005)).access, 'revoked');
  assert.equal((await inviteRow(token)).used_by, null);
});

test('два входа по одной ссылке одновременно — успех только у одного', async () => {
  const token = await createInvite(db, OWNER, now);
  const results = await Promise.all([
    useInvite(db, token, { id: 2010, first_name: 'Дима' }, now),
    useInvite(db, token, { id: 2011, first_name: 'Ева' }, now),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? 2010 : 2011;
  const loser = results[0] ? 2011 : 2010;
  assert.equal((await inviteRow(token)).used_by, winner);
  assert.notEqual(await userRow(winner), null);
  assert.equal(await userRow(loser), null);
});
