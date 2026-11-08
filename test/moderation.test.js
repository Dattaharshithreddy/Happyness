'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { createModerator } = require('../server/moderation');

const post = (text) => ({ name: 'Mia', place: 'Leeds', text });
const HAPPY = 'My little brother saved his pocket money to buy mum flowers and she smiled all day. So sweet!';

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => { calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } } },
  };
}
const answer = (obj, extra = {}) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], ...extra });

test('without an API key it uses the keyword filter only', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const m = createModerator({ log: () => {} });
  assert.strictEqual((await m(post(HAPPY))).decision, 'approve');
  assert.strictEqual((await m(post('Feeling hopeless and depressed'))).decision, 'reject');
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});

test('sends a structured, fallback-enabled request and follows Claude', async () => {
  const c = fakeClient(answer({ decision: 'approve', category: 'uplifting', reason: 'kind family moment' }));
  const m = createModerator({ client: c, log: () => {} });
  const v = await m(post(HAPPY));
  assert.strictEqual(v.decision, 'approve');
  assert.match(v.by, /^ai:/);
  const req = c.calls[0];
  assert.strictEqual(req.model, 'claude-opus-5-5');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(req.fallbacks, 'default');
  assert.strictEqual(req.output_config.format.type, 'json_schema');
  assert.strictEqual(req.output_config.effort, 'low');
  assert.ok(req.messages[0].content.includes('<post>'));
});

test('hard-blocked words never reach the AI', async () => {
  const c = fakeClient(answer({ decision: 'approve', category: 'uplifting', reason: 'x' }));
  const m = createModerator({ client: c, log: () => {} });
  assert.strictEqual((await m(post('Such a happy day, nude beach photos!'))).decision, 'reject');
  assert.strictEqual(c.calls.length, 0);
});

test('Claude can reject subtle negativity the keywords miss', async () => {
  const c = fakeClient(answer({ decision: 'reject', category: 'unkind_or_hateful', reason: 'mocks a coworker' }));
  const m = createModerator({ client: c, log: () => {} });
  const v = await m(post('So happy my lazy coworker finally embarrassed himself, everyone laughed at him lol'));
  assert.strictEqual(v.decision, 'reject');
  assert.strictEqual(v.reason, 'blocked');
});

test('review decisions, refusals and bad output are held for a human', async () => {
  for (const reply of [
    answer({ decision: 'review', category: 'other', reason: 'unsure' }),
    { stop_reason: 'refusal', stop_details: { category: 'other' }, content: [] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
  ]) {
    const m = createModerator({ client: fakeClient(reply), log: () => {} });
    assert.strictEqual((await m(post(HAPPY))).decision, 'review');
  }
});

test('API outages fall back safely', async () => {
  const boom = () => { throw new Anthropic.APIConnectionError({ message: 'offline' }); };
  const kw = createModerator({ client: fakeClient(boom), log: () => {} });
  const v = await kw(post(HAPPY));
  assert.strictEqual(v.decision, 'approve');
  assert.match(v.detail, /connection/);
  const strict = createModerator({ client: fakeClient(boom), fallback: 'review', log: () => {} });
  assert.strictEqual((await strict(post(HAPPY))).decision, 'review');
});
