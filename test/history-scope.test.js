import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEvidenceScope } from '../src/history-scope.js';
import { normalizeHarnessEvents } from '../src/core.js';
import { prepareRegistration, projectRegistrations, listResults } from '../src/registration.js';

const event = (seq, type, data, extra = {}) => ({ seq, type, data, ...extra });
const call = (seq, id, turn = 1, name = 'read', args = { file_path: '/safe' }) => event(seq, 'tool/call', { callId: id, turn, name, arguments: JSON.stringify(args) });
const result = (seq, id, turn = 1, text = 'saved quote', callSeq = seq - 1) => event(seq, 'tool/result', { turn, message: { toolCallId: id, content: [{ type: 'text', text }], isError: false } }, { sourceEventSeqs: [callSeq] });
const reply = (seq, id, turn = 1) => event(seq, 'assistant/message', { turn, message: { id, content: [{ type: 'text', text: 'The answer.' }] } });
const normalize = events => normalizeHarnessEvents(events, { sessionId: 's' });
const select = (events, options = {}) => selectEvidenceScope(events, { sessionId: 's', ...options });
const args = (nodeId = 's:old', target = { kind: 'next-text-message' }) => ({ batchId: 'b', evidence: [{ id: 'e', nodeId, excerpt: 'saved quote' }], claims: [{ id: 'c', text: 'Answer', evidenceIds: ['e'] }], target });
function registration(seq, prior, input = args(), turn = 2, id = 'register') {
  const start = call(seq, id, turn, 'pathway_register_claims', input);
  const envelope = prepareRegistration(normalize([...prior, start]), input, { callId: id, turn, callSeq: seq });
  return [start, result(seq + 1, id, turn, JSON.stringify(envelope), seq)];
}

test('huge unrelated prefix is not normalized or charged to selected closure', () => {
  const old = [event(0, 'turn/start', { turn: 1 }), call(1, 'old'), result(2, 'old'), event(3, 'turn/end', { turn: 1 })];
  const huge = 'x'.repeat(9 * 1024 * 1024);
  const prefix = [call(4, 'unrelated'), result(5, 'unrelated', 1, huge), ...Array.from({ length: 20_010 }, (_, i) => event(i + 6, 'irrelevant', {}))];
  const recentStart = event(30_000, 'turn/start', { turn: 2 });
  const reg = registration(30_001, old);
  const recent = reply(30_003, 'recent', 2);
  const all = [...old, ...prefix, recentStart, ...reg, recent];
  const scope = select(all, { baseEvents: [recent] });
  assert.equal(scope.events.some(e => e.seq === 5), false);
  assert.deepEqual(scope.events.map(e => e.seq), [0, 1, 2, 3, 30_000, 30_001, 30_002, 30_003]);
  assert.equal(scope.addedEventCount, 7);
  const projected = projectRegistrations(normalize(scope.events), scope.events);
  assert.equal(projected.registrations[0].status, 'bound');
  assert.equal(projected.registrations[0].replyId, 's:reply:recent');
  assert.equal(projected.claims.length, 1);
});

test('listLimit selects latest successful completed tool pairs, not unrelated huge outputs', () => {
  const all = [call(0, 'huge'), result(1, 'huge', 1, 'x'.repeat(3 * 1024 * 1024))];
  for (let i = 0; i < 110; i++) all.push(call(2 + 2 * i, `r${i}`), result(3 + 2 * i, `r${i}`));
  all.push(call(222, 'pending'), call(223, 'list', 1, 'pathway_list_results'));
  const scope = select(all, { baseEvents: [all.at(-1)], listLimit: 100 });
  assert.equal(scope.events.length, 201);
  const listed = listResults(normalize(scope.events));
  assert.equal(listed.results.length, 100);
  assert.equal(listed.results[0].nodeId, 's:r10');
  assert.equal(listed.results.at(-1).nodeId, 's:r109');
});

test('canonical PTC evidence refs include recursive parent pairs and turn boundaries only', () => {
  const all = [event(0, 'turn/start', { turn: 4 }), call(1, 'root', 4, 'bash'),
    event(2, 'tool/ptc-dispatch-start', { subCallId: 'middle', parentCallId: 'root', name: 'python' }),
    event(3, 'tool/ptc-dispatch-start', { subCallId: 'leaf', parentCallId: 'middle', name: 'read', arguments: '{}' }),
    event(4, 'tool/ptc-dispatch', { subCallId: 'leaf', parentCallId: 'middle', content: 'saved quote' }),
    event(5, 'tool/ptc-dispatch', { subCallId: 'middle', parentCallId: 'root', content: 'done' }),
    result(6, 'root', 4), reply(7, 'unrelated', 4), event(8, 'turn/end', { turn: 4 })];
  const scope = select(all, { evidence: [{ nodeId: 's:leaf' }] });
  assert.deepEqual(scope.events.map(e => e.seq), [0, 1, 2, 3, 4, 5, 6, 8]);
  const trace = normalize(scope.events);
  assert.equal(trace.nodes.find(n => n.id === 's:leaf').turn, 4);
  assert.equal(select(all, { evidence: [{ nodeId: 'other:leaf' }] }).events.length, 0);
});

test('all base-turn registrations and earliest text sentinels prevent false later binding', () => {
  const old = [call(0, 'old'), result(1, 'old')];
  const reg = registration(2, old);
  const first = reply(7, 'first', 2), late = reply(8, 'late', 2);
  const all = [...old, event(1_000, 'irrelevant', {}), ...reg,
    event(4, 'assistant/message', { turn: 2, message: { content: [{ type: 'tool-call' }] } }),
    event(5, 'assistant/attempt', { turn: 2, message: { content: [{ type: 'text', text: 'attempt' }] } }),
    event(6, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: ' ' }] } }), first, late];
  const scope = select(all, { baseEvents: [late] });
  assert.ok(scope.events.includes(first));
  assert.equal(scope.events.some(e => [4, 5, 6].includes(e.seq)), false);
  const projected = projectRegistrations(normalize(scope.events), scope.events);
  assert.equal(projected.registrations[0].replyId, 's:reply:first');
  assert.deepEqual(projected.replies.find(r => r.id === 's:reply:late').claimIds, []);
  assert.deepEqual(scope.events, all.filter(e => scope.events.includes(e)));
});

test('explicit reply targets recursively include original reply and evidence', () => {
  const old = [call(0, 'old'), result(1, 'old'), reply(2, 'earlier')];
  const input = args('s:old', { kind: 'reply', replyId: 's:reply:earlier' });
  const reg = registration(4, old, input);
  const all = [...old, ...reg, reply(6, 'recent', 2)];
  const scope = select(all, { baseEvents: [all.at(-1)] });
  const projected = projectRegistrations(normalize(scope.events), scope.events);
  assert.equal(projected.registrations[0].replyId, 's:reply:earlier');
  const direct = select(all, { evidence: input.evidence, target: input.target });
  assert.ok(direct.events.includes(old[2]));
});

test('same batch selection reaches old-turn registrations for conflict checking', () => {
  const old = [call(0, 'old'), result(1, 'old')];
  const reg = registration(2, old);
  const current = call(10, 'retry', 3, 'pathway_register_claims', args());
  const scope = select([...old, ...reg, reply(4, 'bound', 2), current], { baseEvents: [current], batchId: 'b', evidence: args().evidence });
  const projected = projectRegistrations(normalize(scope.events), scope.events);
  assert.equal(projected.registrations.length, 1);
  const changed = args(); changed.claims[0].text = 'changed';
  assert.throws(() => prepareRegistration(projected, changed, { callId: 'retry', turn: 3, callSeq: 10 }), { code: 'BATCH_CONFLICT' });
});

test('whole selected raw JSON byte and event budgets are enforced before normalization', () => {
  const all = [call(0, 'a'), result(1, 'a', 1, '界'.repeat(30))];
  const exact = new TextEncoder().encode(JSON.stringify(all)).length;
  assert.equal(select(all, { evidence: [{ nodeId: 's:a' }], maxBytes: exact }).events.length, 2);
  assert.throws(() => select(all, { evidence: [{ nodeId: 's:a' }], maxBytes: exact - 1 }), { code: 'EVIDENCE_SCOPE_TOO_LARGE' });
  assert.throws(() => select(all, { evidence: [{ nodeId: 's:a' }], maxEvents: 1 }), { code: 'EVIDENCE_SCOPE_TOO_LARGE' });
  assert.throws(() => select(all, { baseEvents: all, maxEvents: 1 }), { code: 'EVIDENCE_SCOPE_TOO_LARGE' });
});

test('rejects unreliable/duplicate/conflicting seq and never fabricates missing refs', () => {
  const a = call(0, 'a');
  assert.throws(() => select([{ ...a, seq: undefined }]), { code: 'RELIABLE_SEQ_REQUIRED' });
  assert.throws(() => select([a, structuredClone(a)]), { code: 'DUPLICATE_EVENT_SEQ' });
  assert.throws(() => select([a, { ...a, type: 'other' }]), { code: 'CONFLICTING_EVENT_SEQ' });
  const input = args('s:missing');
  const scope = select([a], { evidence: input.evidence });
  assert.deepEqual(scope.events, []);
  assert.throws(() => prepareRegistration(normalize(scope.events), input, { callId: 'r', turn: 1, callSeq: 2 }), { code: 'RESULT_UNAVAILABLE' });
});

test('host scope without explicit batchId retains first global acceptance and original binding', () => {
  const old = [call(0, 'old'), result(1, 'old')];
  const first = registration(2, old), firstReply = reply(4, 'first', 2);
  const prior = [...old, ...first, firstReply];
  const retry = registration(8, prior, args(), 3, 'retry'), recent = reply(10, 'recent', 3);
  const scope = select([...prior, ...retry, recent], { baseEvents: [recent] });
  assert.ok(scope.events.includes(first[0]));
  assert.ok(scope.events.includes(firstReply));
  const projected = projectRegistrations(normalize(scope.events), scope.events);
  assert.equal(projected.registrations.length, 1);
  assert.equal(projected.registrations[0].replyId, 's:reply:first');
  assert.deepEqual(projected.replies.find(r => r.id === 's:reply:recent').claimIds, []);
});

test('referenced same-text replacements remain selected and invalidate projected source', () => {
  const old = [call(0, 'old'), result(1, 'old')];
  const reg = registration(2, old), recent = reply(4, 'recent', 2);
  const replacement = result(5, 'old', 1, 'saved quote', 1);
  replacement.surfaceOp = 'replace'; replacement.sourceEventSeqs = [1];
  const scope = select([...old, ...reg, recent, replacement], { baseEvents: [recent] });
  assert.ok(scope.events.includes(replacement));
  const projected = projectRegistrations(normalize(scope.events), scope.events);
  assert.equal(projected.registrations[0].status, 'source-unavailable');
  assert.equal(projected.claims.length, 0);
  assert.equal(projected.evidence.length, 0);
});

test('list closure does not pull registrations merely sharing old tool turns', () => {
  const all = [event(0, 'turn/start', { turn: 1 }), call(1, 'old'), result(2, 'old'),
    call(3, 'irrelevant-register', 1, 'pathway_register_claims', args('s:huge')),
    call(4, 'huge'), result(5, 'huge', 1, 'x'.repeat(3 * 1024 * 1024)),
    call(6, 'recent-read'), result(7, 'recent-read'), event(8, 'turn/end', { turn: 1 }),
    event(9, 'turn/start', { turn: 2 }), call(10, 'list', 2, 'pathway_list_results')];
  const scope = select(all, { baseEvents: [all.at(-1)], listLimit: 1 });
  assert.deepEqual(scope.events.map(e => e.seq), [0, 6, 7, 8, 9, 10]);
});

test('bounded malformed registration args cannot pull unrelated outputs into scope', () => {
  const recent = reply(3, 'recent');
  for (const value of ['{broken', 'x'.repeat(65_000), { ignored: 'x'.repeat(65_000) }]) {
    const bad = call(2, 'register', 1, 'pathway_register_claims'); bad.data.arguments = value;
    const all = [call(0, 'huge'), result(1, 'huge', 1, 'x'.repeat(3 * 1024 * 1024)), bad, recent];
    const before = all.map(e => e.seq);
    const scope = select(all, { baseEvents: [recent] });
    assert.deepEqual(scope.events.map(e => e.seq), [2, 3]);
    assert.deepEqual(all.map(e => e.seq), before);
  }
});


test('listLimit fits newest 22KB results instead of failing the entire 100-result list', () => {
  const all = [];
  for (let i = 0; i < 100; i++) all.push(call(2 * i, `r${i}`), result(2 * i + 1, `r${i}`, 1, 'x'.repeat(22 * 1024)));
  const base = call(200, 'list', 2, 'pathway_list_results'); all.push(base);
  const scope = select(all, { baseEvents: [base], listLimit: 100 });
  assert.equal(scope.listTruncated, true);
  assert.ok(scope.listSelectedCount > 0 && scope.listSelectedCount < 100);
  assert.equal(scope.listTotalCount, 100);
  assert.equal(scope.listOmittedCount, 100 - scope.listSelectedCount);
  assert.ok(new TextEncoder().encode(JSON.stringify(scope.events)).length <= 2 * 1024 * 1024);
  const pairs = scope.events.filter(e => e.type === 'tool/result');
  assert.equal(pairs.length, scope.listSelectedCount);
  assert.equal(pairs[0].data.message.toolCallId, `r${scope.listOmittedCount}`);
  assert.equal(pairs.at(-1).data.message.toolCallId, 'r99');
});

test('optional list candidates roll back their entire closure and try older fits', () => {
  const all = [call(0, 'small'), result(1, 'small'), call(2, 'huge'), result(3, 'huge', 1, 'x'.repeat(5000)),
    event(4, 'tool/ptc-dispatch-start', { subCallId: 'leaf', parentCallId: 'huge', name: 'read' }),
    event(5, 'tool/ptc-dispatch', { subCallId: 'leaf', parentCallId: 'huge', content: 'small' })];
  const scope = select(all, { listLimit: 1, maxBytes: 1000 });
  assert.deepEqual(scope.events, all.slice(0, 2));
  assert.equal(scope.listSelectedCount, 1);
  assert.equal(scope.listOmittedCount, 2);
  assert.equal(scope.listTruncated, true);
  const countScope = select(all, { listLimit: 3, maxEvents: 2 });
  assert.deepEqual(countScope.events, all.slice(2, 4));
  assert.equal(countScope.listSelectedCount, 1);
});

test('list byte fitting never discards an oversized mandatory base or reference closure', () => {
  const all = [call(0, 'huge'), result(1, 'huge', 1, 'x'.repeat(5000)), call(2, 'small'), result(3, 'small')];
  for (const required of [{ baseEvents: [all[0]] }, { evidence: [{ nodeId: 's:huge' }] }]) {
    assert.throws(() => select(all, { ...required, listLimit: 100, maxBytes: 1000 }), { code: 'EVIDENCE_SCOPE_TOO_LARGE' });
  }
  const scope = select(all.slice(2), { listLimit: 1 });
  assert.equal(scope.listTruncated, false);
  assert.equal(scope.listOmittedCount, 0);
});
