import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionTools, proposalIdFor, REJECTION_HINTS, SCOPE_TOOL_SCHEMA } from './tools.js';

const scope = { streamId: 'qq:100:private:200', memoryEpoch: 0 };
const fact = { key: '搬家日期', value: '下个月 5 号', quote: '我下个月 5 号搬家' };
/** The memory tool over a stand-in Authority: `review(body)` decides each submitted proposal, `late` receipt reads later. */
function tools({ review = () => ({ status: 'accepted', revision: 7 }), late = 0, submit } = {}) {
  const submitted = [], receipts = new Map(), waits = [];
  let reads = 0;
  const authority = {
    submit: async body => {
      if (submit) return submit(body);
      const known = receipts.get(body.proposalId);
      if (known && known.canonical !== JSON.stringify(body)) throw Object.assign(new Error('Authority request failed (409)'), { status: 409 });
      if (!known) { submitted.push(body); receipts.set(body.proposalId, { canonical: JSON.stringify(body), receipt: { proposalId: body.proposalId, policy: 'conversation.v1', ...review(body) } }); }
      return { proposalId: body.proposalId, status: 'pending', policy: 'conversation.v1' };
    },
    getReceipt: async id => {
      if (!receipts.has(id)) throw Object.assign(new Error('Authority request failed (404)'), { status: 404 });
      return ++reads <= late ? { proposalId: id, status: 'pending', policy: 'conversation.v1' } : receipts.get(id).receipt;
    },
  };
  const [memory] = createCompanionTools({ authority, scope, requestId: 'r1', evidence: [{ ref: 'obs-1', eventId: 'e1', role: 'user' }], guard: async () => {}, sleep: async ms => { waits.push(ms); } });
  const call = async args => JSON.parse((await memory.execute('call', args)).content[0].text);
  return { call, submitted, waits };
}

test('propose without an id is submitted under a key derived from its content, and reports the review decision', async () => {
  const t = tools();
  const result = await t.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact });
  assert.match(result.id, /^auto-[a-f0-9]{32}$/);
  assert.deepEqual(result, { proposalId: proposalIdFor(scope.streamId, result.id), policy: 'conversation.v1', status: 'accepted', revision: 7, id: result.id, remembered: true, hint: '已经记住。' });
  assert.deepEqual(t.submitted, [{ proposalId: result.proposalId, observationId: 'obs-1', type: 'fact.report', payload: fact }]);
  assert.deepEqual(t.waits, []);
  // The same proposal again is the same proposal; a changed one is a new one. The returned id finds the receipt.
  assert.equal((await t.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: { ...fact } })).id, result.id);
  assert.notEqual((await t.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: { ...fact, value: '5 号' } })).id, result.id);
  assert.equal(t.submitted.length, 2);
  assert.deepEqual(await t.call({ action: 'receipt', id: result.id }), result);
  assert.equal(await t.call({ action: 'receipt', id: 'never-proposed' }), null);
});

test('propose with an id keeps it; reusing it for other content is refused with what to do', async () => {
  const t = tools();
  assert.equal((await t.call({ action: 'propose', id: 'move', ref: 'obs-1', type: 'fact.report', payload: fact })).id, 'move');
  assert.equal(t.submitted[0].proposalId, proposalIdFor(scope.streamId, 'move'));
  await assert.rejects(t.call({ action: 'propose', id: 'move', ref: 'obs-1', type: 'fact.report', payload: { ...fact, value: '5 号' } }), /PROPOSAL_ID_REUSED: .*换一个 id，或者不填 id/);
  for (const id of ['', 'x'.repeat(97), 7]) await assert.rejects(t.call({ action: 'propose', id, ref: 'obs-1', type: 'fact.report', payload: fact }), /INVALID_REQUEST: id 可以不填；填的话必须是 1–96 个字符的字符串/);
});

test('a rejected proposal says it was not remembered and how to correct it, for each of Authority\'s reasons', async () => {
  for (const [reason, hint] of Object.entries(REJECTION_HINTS)) {
    const result = await tools({ review: () => ({ status: 'rejected', revision: 8, reason }) }).call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact });
    assert.equal(result.status, 'rejected'); assert.equal(result.reason, reason); assert.equal(result.remembered, false);
    assert.equal(result.hint, '没有记住。' + hint, reason);
  }
  assert.deepEqual(Object.keys(REJECTION_HINTS).sort(), ['authored_text_required', 'conversation_policy_kind_denied', 'conversation_role_required', 'observation_already_appraised', 'private_binding_required', 'real_user_required', 'sensitive_retention_denied', 'sensitive_source', 'unconfirmed_identity', 'world_paused']);
  assert.match(REJECTION_HINTS.real_user_required, /ref 要选 role 为 user 的那条/);
  // A reason without a hint is passed on as its code; a world paused at submit is rejected at once.
  assert.equal((await tools({ review: () => ({ status: 'rejected', reason: 'unknown_kind' }) }).call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact })).hint, '没有记住。被拒收（unknown_kind）。');
  const paused = await tools({ submit: async body => ({ proposalId: body.proposalId, status: 'rejected', policy: 'conversation.v1', revision: 3, reason: 'world_paused' }) }).call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact });
  assert.equal(paused.hint, '没有记住。世界已暂停，现在不能记。不要重试。');
  // The correction the hint asks for is then accepted in the same run.
  const t = tools({ review: body => body.type === 'fact.report' ? { status: 'accepted' } : { status: 'rejected', reason: 'conversation_policy_kind_denied' } });
  assert.equal((await t.call({ action: 'propose', ref: 'obs-1', type: 'learning.note', payload: { text: '搬家日期是 2026年12月5日', quote: fact.quote } })).remembered, false);
  assert.equal((await t.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: { ...fact, value: '2026年12月5日' } })).remembered, true);
});

test('a review that does not resolve in time is reported as pending, not as remembered', async () => {
  const slow = tools({ late: 2 });
  assert.equal((await slow.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact })).status, 'accepted');
  assert.deepEqual(slow.waits, [150, 150]);
  const never = tools({ late: Infinity }), result = await never.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact });
  assert.deepEqual([result.status, result.remembered], ['pending', false]);
  assert.match(result.hint, /尚未记住.*action=receipt.*得到 accepted 之前不要说已经记下/);
  assert.deepEqual(never.waits, [150, 150, 150, 150]);
});

test('an invalid call names the field and the expected shape', async () => {
  const t = tools(), propose = extra => t.call({ action: 'propose', ref: 'obs-1', type: 'fact.report', payload: fact, ...extra });
  await assert.rejects(t.call({ action: 'propose', type: 'fact.report' }), /INVALID_REQUEST: propose 缺少字段 ref、payload；需要 action、ref、type、payload/);
  await assert.rejects(propose({ note: 'x' }), /INVALID_REQUEST: propose 有多余字段 note；只接受 action、id、ref、type、payload/);
  await assert.rejects(propose({ ref: 'obs-9' }), /UNOBSERVED_EVIDENCE: ref 必须是本轮附注“本轮可引用的聊天证据”里的 ref/);
  await assert.rejects(propose({ type: 'fact' }), /INVALID_REQUEST: type 必须是 fact\.report、experience\.remember、appraisal\.record、learning\.note、self\.note 之一/);
  await assert.rejects(propose({ payload: { key: 'k', value: 'v' } }), /INVALID_REQUEST: payload（fact\.report） 缺少字段 quote；需要 key、value、quote/);
  await assert.rejects(propose({ payload: { ...fact, summary: 's' } }), /INVALID_REQUEST: payload（fact\.report） 有多余字段 summary；只接受 key、value、quote/);
  await assert.rejects(propose({ payload: 'text' }), /INVALID_REQUEST: payload（fact\.report） 必须是对象，字段：key、value、quote/);
  await assert.rejects(propose({ payload: { ...fact, value: '' } }), /INVALID_REQUEST: payload\.value 必须是 1–1200 个字符的非空字符串/);
  await assert.rejects(propose({ payload: { ...fact, quote: 'x'.repeat(1201) } }), /INVALID_REQUEST: payload\.quote 必须是/);
  await assert.rejects(propose({ type: 'appraisal.record', payload: { kind: 'outer', quote: 'q' } }), /INVALID_REQUEST: appraisal\.record 的 payload\.kind 必须是 gratitude、support、repair、boundary 之一/);
  await assert.rejects(propose({ type: 'self.note', payload: { text: 't', quote: 'q', kind: 'support' } }), /INVALID_REQUEST: self\.note 的 payload\.kind 必须是 outer 或 inner/);
  await assert.rejects(t.call({ action: 'receipt' }), /INVALID_REQUEST: receipt 缺少字段 id/);
  await assert.rejects(t.call({ action: 'remember' }), /INVALID_REQUEST: action 必须是/);
  await assert.rejects(t.call({ action: 'recall', from: '2026-11-11', to: '2026-11-12' }), /INVALID_REQUEST: from、to 必须是带秒和时区的 ISO 时间/);
  await assert.rejects(t.call({ action: 'search', query: ' ' }), /INVALID_REQUEST: query 必须是/);
  for (const error of await Promise.allSettled([propose({ type: 'fact' }), t.call({ action: 'receipt' })])) assert.equal(error.reason.code, 'INVALID_REQUEST');
  assert.equal(t.submitted.length, 0);
});

test('the tool definition says what is remembered, that id is optional and that value is her normalised reading', () => {
  assert.match(SCOPE_TOOL_SCHEMA.description, /Only a proposal whose status is accepted is remembered; pending or rejected is not\./);
  assert.match(SCOPE_TOOL_SCHEMA.parameters.properties.id.description, /^propose: optional key \(1–96 chars\); omit it and one is generated and returned/);
  assert.match(SCOPE_TOOL_SCHEMA.parameters.properties.payload.description, /fact\.report value is the fact as you understand it, normalised \(a relative date as the concrete date\)\.$/);
  assert.match(SCOPE_TOOL_SCHEMA.parameters.properties.payload.properties.quote.description, /^The source: copy the words of the evidence message as closely as you can/);
  assert.deepEqual(SCOPE_TOOL_SCHEMA.parameters.required, ['action']);
});
