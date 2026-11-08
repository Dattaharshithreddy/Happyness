'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../server/db');
const { createApp } = require('../server/server');

const ADMIN = 'test-admin-token-1234567890';
const fakeFeeds = { getItems: async () => ({ at: Date.now(), items: [], stats: {} }) };

async function start(opts = {}) {
  const db = open(':memory:');
  const server = createApp({ db, feeds: fakeFeeds, adminToken: ADMIN, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body, admin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (admin) headers['X-Admin-Token'] = admin;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const signup = async (name) => (await call('POST', '/api/account', { body: { name } })).data;
  return { db, call, signup, close: () => new Promise((r) => server.close(r)) };
}

const HAPPY = 'My neighbour baked cookies for the whole street today and everyone was smiling. So wholesome and kind!';

test('accounts: create, read, rename, delete', async (t) => {
  const s = await start();
  t.after(s.close);
  const { token, user } = await s.signup('Asha');
  assert.ok(token && user.id);
  assert.strictEqual(user.name, 'Asha');
  assert.strictEqual((await s.call('GET', '/api/account', { token })).data.user.name, 'Asha');
  assert.strictEqual((await s.call('PATCH', '/api/account', { token, body: { name: 'Asha R' } })).data.user.name, 'Asha R');
  assert.strictEqual((await s.call('GET', '/api/account', { token: 'nope' })).status, 401);
  assert.strictEqual((await s.call('DELETE', '/api/account', { token })).data.deleted, true);
  assert.strictEqual((await s.call('GET', '/api/account', { token })).status, 401);
});

test('posting requires an account and agreeing to the guidelines', async (t) => {
  const s = await start();
  t.after(s.close);
  assert.strictEqual((await s.call('POST', '/api/posts', { body: { text: HAPPY, agree: true } })).status, 401);
  const { token } = await s.signup('Ben');
  assert.strictEqual((await s.call('POST', '/api/posts', { token, body: { text: HAPPY } })).status, 400);
  const ok = await s.call('POST', '/api/posts', { token, body: { text: HAPPY, agree: true, mood: 'kindness' } });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.data.post.name, 'Ben');
  assert.strictEqual(ok.data.post.own, true);
  const sad = await s.call('POST', '/api/posts', { token, body: { text: 'I feel hopeless and depressed today', agree: true } });
  assert.strictEqual(sad.status, 422);
  const link = await s.call('POST', '/api/posts', { token, body: { text: 'So happy, look at www.example.com it is wonderful', agree: true } });
  assert.strictEqual(link.status, 400);
});

test('everyone sees posts from strangers in the feed', async (t) => {
  const s = await start();
  t.after(s.close);
  const a = await s.signup('Chen');
  const b = await s.signup('Dee');
  await s.call('POST', '/api/posts', { token: a.token, body: { text: HAPPY, agree: true } });
  const feed = await s.call('GET', '/api/feed?tab=community', { token: b.token });
  assert.ok(feed.data.items.some((p) => p.name === 'Chen' && !p.own));
  const anon = await s.call('GET', '/api/feed?tab=community');
  assert.ok(anon.data.items.length > 10, 'starter stories + new post');
});

test('reactions are one per person and toggle', async (t) => {
  const s = await start();
  t.after(s.close);
  const a = await s.signup('Eve');
  const b = await s.signup('Finn');
  const { post } = (await s.call('POST', '/api/posts', { token: a.token, body: { text: HAPPY, agree: true } })).data;
  const path = `/api/posts/${post.id}/react`;
  await s.call('POST', path, { token: b.token, body: { reaction: 'heart', on: true } });
  const twice = await s.call('POST', path, { token: b.token, body: { reaction: 'heart', on: true } });
  assert.strictEqual(twice.data.post.reactions.heart, 1);
  assert.strictEqual(twice.data.post.mine.heart, true);
  const off = await s.call('POST', path, { token: b.token, body: { reaction: 'heart', on: false } });
  assert.strictEqual(off.data.post.reactions.heart, 0);
});

test('blocking hides that person; enough reports hide a post for review', async (t) => {
  const s = await start();
  t.after(s.close);
  const author = await s.signup('Gus');
  const viewer = await s.signup('Hana');
  const { post } = (await s.call('POST', '/api/posts', { token: author.token, body: { text: HAPPY, agree: true } })).data;

  await s.call('POST', `/api/users/${author.user.id}/block`, { token: viewer.token });
  let feed = await s.call('GET', '/api/feed?tab=community', { token: viewer.token });
  assert.ok(!feed.data.items.some((p) => p.id === post.id), 'blocked author hidden');
  await s.call('DELETE', `/api/users/${author.user.id}/block`, { token: viewer.token });
  feed = await s.call('GET', '/api/feed?tab=community', { token: viewer.token });
  assert.ok(feed.data.items.some((p) => p.id === post.id), 'visible after unblock');

  for (const n of ['R1', 'R2', 'R3']) {
    const r = await s.signup(n);
    await s.call('POST', `/api/posts/${post.id}/report`, { token: r.token, body: { reason: 'not kind' } });
  }
  feed = await s.call('GET', '/api/feed?tab=community');
  assert.ok(!feed.data.items.some((p) => p.id === post.id), 'hidden after 3 reports');
  const mine = await s.call('GET', '/api/account', { token: author.token });
  assert.strictEqual(mine.data.posts[0].status, 'hidden', 'author can see it is in review');
});

test('admin: protected, can approve, remove and ban', async (t) => {
  const s = await start();
  t.after(s.close);
  assert.strictEqual((await s.call('GET', '/api/admin/queue')).status, 401);
  assert.strictEqual((await s.call('GET', '/api/admin/queue', { admin: 'wrong-token-wrong-token-xx' })).status, 401);

  const a = await s.signup('Ivy');
  const { post } = (await s.call('POST', '/api/posts', { token: a.token, body: { text: HAPPY, agree: true } })).data;
  const r = await s.signup('Jo');
  await s.call('POST', `/api/posts/${post.id}/report`, { token: r.token, body: { reason: 'spam' } });

  const q = await s.call('GET', '/api/admin/queue', { admin: ADMIN });
  assert.strictEqual(q.status, 200);
  assert.ok(q.data.queue.some((p) => p.id === post.id && p.openReports === 1));

  await s.call('POST', `/api/admin/posts/${post.id}`, { admin: ADMIN, body: { action: 'approve' } });
  assert.ok(!(await s.call('GET', '/api/admin/queue', { admin: ADMIN })).data.queue.some((p) => p.id === post.id), 'resolved');

  await s.call('POST', `/api/admin/users/${a.user.id}/ban`, { admin: ADMIN });
  const feed = await s.call('GET', '/api/feed?tab=community');
  assert.ok(!feed.data.items.some((p) => p.id === post.id), 'banned user posts removed');
  assert.strictEqual((await s.call('POST', '/api/posts', { token: a.token, body: { text: HAPPY, agree: true } })).status, 403);
});

test('moderator can hold a post for review', async (t) => {
  const s = await start({ moderate: async () => ({ decision: 'review', reason: 'unsure', by: 'ai' }) });
  t.after(s.close);
  const a = await s.signup('Kai');
  const res = await s.call('POST', '/api/posts', { token: a.token, body: { text: HAPPY, agree: true } });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.post.status, 'pending');
  assert.ok(res.data.notice);
  const feed = await s.call('GET', '/api/feed?tab=community');
  assert.ok(!feed.data.items.some((p) => p.id === res.data.post.id));
});

test('deleting an account removes its posts', async (t) => {
  const s = await start();
  t.after(s.close);
  const a = await s.signup('Lee');
  const { post } = (await s.call('POST', '/api/posts', { token: a.token, body: { text: HAPPY, agree: true } })).data;
  await s.call('DELETE', '/api/account', { token: a.token });
  assert.strictEqual(s.db.getPost(post.id), null);
});
