import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHarnessEvents, validateTrace } from '../src/core.js';
import { prepareRegistration, listResults, projectRegistrations } from '../src/registration.js';

const event = (seq, type, data, extra = {}) => ({ seq, type, time: 1700000000000 + seq, data, ...extra });
function fixture() {
  return [event(0, 'turn/start', { turn: 1 }), event(1, 'tool/call', { turn: 1, step: 1, callId: 'read', name: 'read', arguments: JSON.stringify({ file_path: '/safe.txt' }) }),
    event(2, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'read', content: [{ type: 'text', text: 'The recorded answer is forty two.' }], isError: false } }, { surfaceOp: 'append', sourceEventSeqs: [1] })];
}
const normalize = events => normalizeHarnessEvents(events, { sessionId: 's' });
const args = () => ({ batchId: 'b', evidence: [{ id: 'e', nodeId: 's:read', excerpt: 'forty two' }], claims: [{ id: 'c', text: 'Answer', evidenceIds: ['e'] }], target: { kind: 'next-text-message' } });
function registration(events, input = args(), callId = 'register') {
  const callSeq = events.length;
  events.push(event(callSeq, 'tool/call', { turn: 1, step: 2, callId, name: 'pathway_register_claims', arguments: JSON.stringify(input) }));
  const envelope = prepareRegistration(normalize(events), input, { callId, turn: 1, callSeq });
  events.push(event(callSeq + 1, 'tool/result', { turn: 1, step: 2, message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(envelope) }] } }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] }));
  return envelope;
}
function reply(events, turn = 1, name = 'reply') { events.push(event(events.length, 'assistant/message', { turn, step: 3, message: { id: name, content: [{ type: 'text', text: 'Answer is forty two.' }] } })); }

test('lists bounded summaries of committed successful results', () => {
  const trace = normalize(fixture()), list = listResults(trace);
  assert.equal(list.sessionId, 's'); assert.equal(list.results[0].nodeId, 's:read');
  assert.equal(list.results[0].resultSeq, 2); assert.match(list.results[0].summary, /forty two/);
});

test('acceptance validates exact saved quotes and mandatory claim evidence atomically', () => {
  const trace = normalize(fixture());
  const input = args(); input.evidence[0].sourceId = 'source:s:read';
  const accepted = prepareRegistration(trace, input, { callId: 'r', turn: 1, callSeq: 3 });
  assert.equal(accepted.validation.semanticSupport, 'unverified'); assert.equal(accepted.evidence[0].locator, 'exact-substring');
  for (const [mutate, code] of [
    [a => a.evidence[0].excerpt = 'not present', 'EXCERPT_NOT_FOUND'],
    [a => a.evidence[0].sourceId = 'missing', 'SOURCE_UNAVAILABLE'],
    [a => a.evidence[0].locator = 'line 99', 'INVALID_LOCATOR'],
    [a => a.claims[0].evidenceIds = [], 'INVALID_COUNT'],
    [a => a.claims[0].evidenceIds = ['missing'], 'EVIDENCE_UNAVAILABLE'],
    [a => a.evidence.push({ ...a.evidence[0] }), 'DUPLICATE_ID'],
    [a => a.batchId = 'x'.repeat(513), 'INVALID_TEXT'],
  ]) { const a = args(); mutate(a); assert.throws(() => prepareRegistration(trace, a, { callId: 'r', turn: 1, callSeq: 3 }), e => e.code === code); }
  assert.throws(() => prepareRegistration(trace, args(), { callId: 'r', turn: 1, callSeq: 2 }), e => e.code === 'RESULT_UNAVAILABLE');
});

test('native result envelope binds the first text reply, not tool-only or attempts', () => {
  const events = fixture(); registration(events);
  events.push(event(events.length, 'assistant/attempt', { turn: 1, message: { content: [{ type: 'text', text: 'not committed' }] } }));
  events.push(event(events.length, 'assistant/message', { turn: 1, message: { id: 'tools', content: [{ type: 'tool-call', id: 'x', name: 'noop', arguments: '{}' }] } }));
  reply(events); reply(events, 1, 'second');
  const trace = normalize(events), before = JSON.stringify(trace), projected = projectRegistrations(trace, events);
  assert.equal(JSON.stringify(trace), before);
  assert.equal(projected.registrations[0].status, 'bound');
  assert.equal(projected.replies.find(r => r.id === 's:reply:reply').claimIds.length, 1);
  assert.equal(projected.replies.find(r => r.id === 's:reply:second').claimIds.length, 0);
  assert.equal(projected.evidence[0].verification, 'unverified'); validateTrace(projected);
});

test('pending registration becomes unbound at turn end and never binds next turn', () => {
  const events = fixture(); registration(events);
  assert.equal(projectRegistrations(normalize(events), events).registrations[0].status, 'pending');
  events.push(event(events.length, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } }));
  events.push(event(events.length, 'turn/start', { turn: 2 })); reply(events, 2);
  const projected = projectRegistrations(normalize(events), events);
  assert.equal(projected.registrations[0].status, 'unbound'); assert.equal(projected.claims.length, 0);
});

test('existing reply target rejects future evidence and supports older available results', () => {
  const events = fixture(); reply(events);
  const input = args(); input.target = { kind: 'reply', replyId: 's:reply:reply' };
  registration(events, input);
  assert.equal(projectRegistrations(normalize(events), events).registrations[0].replyId, 's:reply:reply');
  const trace = normalize(events); trace.nodes.find(n => n.id === 's:read').resultSeq = 4;
  assert.throws(() => prepareRegistration(trace, input, { callId: 'r2', turn: 1, callSeq: 8 }), e => e.code === 'RESULT_AFTER_REPLY');
});

test('batch retry is idempotent and different-content batch is a warning', () => {
  const events = fixture(); registration(events); registration(events, args(), 'retry');
  const changed = args(); changed.claims[0].text = 'different'; registration(events, changed, 'conflict'); reply(events);
  const projected = projectRegistrations(normalize(events), events);
  assert.equal(projected.registrations.length, 1); assert.equal(projected.claims.length, 1);
  assert.ok(projected.warnings.some(w => w.includes('BATCH_CONFLICT')));
});

test('preparation rejects conflicting batch before successful output', () => {
  const events = fixture(); registration(events);
  const projected = projectRegistrations(normalize(events), events);
  assert.equal(prepareRegistration(projected, args(), { callId: 'retry', turn: 1, callSeq: 5 }).batchId, 'b');
  const changed = args(); changed.claims[0].text = 'changed';
  assert.throws(() => prepareRegistration(projected, changed, { callId: 'retry', turn: 1, callSeq: 5 }), e => e.code === 'BATCH_CONFLICT');
});

test('later result replacements retain acceptance but never expose falsely resolved edges', () => {
  for (const snapshot of ['The recorded answer is forty two.', 'redacted replacement']) {
    const events = fixture(); registration(events); reply(events);
    events.push(event(events.length, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'read', content: [{ type: 'text', text: snapshot }], isError: false } }, { surfaceOp: 'replace', sourceEventSeqs: [2] }));
    const projected = projectRegistrations(normalize(events), events);
    assert.equal(projected.registrations.length, 1);
    assert.equal(projected.registrations[0].status, 'source-unavailable');
    assert.equal(projected.registrations[0].validation.locators, 'unavailable');
    assert.equal(projected.claims.length, 0);
    assert.equal(projected.evidence.length, 0);
    assert.equal(projected.replies.find(r => r.id === 's:reply:reply').claimIds.length, 0);
    assert.ok(projected.warnings.some(w => w.includes('SOURCE_SNAPSHOT_CHANGED')));
    validateTrace(projected);
  }
});

test('registration enforces UTF-8 input and complete-envelope 64k budgets', () => {
  const input = args();
  input.claims = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, text: '界'.repeat(5000), evidenceIds: ['e'] }));
  assert.throws(() => prepareRegistration(normalize(fixture()), input, { callId: 'r', turn: 1, callSeq: 3 }), e => e.code === 'REGISTRATION_TOO_LARGE');
  const nearLimit = args();
  nearLimit.claims = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, text: 'x'.repeat(15700), evidenceIds: ['e'] }));
  const trace = normalize(fixture());
  const context = { callId: 'r', turn: 1, callSeq: 3 };
  const accepted = prepareRegistration(trace, nearLimit, context);
  assert.ok(new TextEncoder().encode(JSON.stringify(accepted)).length < 64000);
  const inputBytes = new TextEncoder().encode(JSON.stringify(nearLimit)).length;
  let padding = 63950 - inputBytes;
  for (const claim of nearLimit.claims) {
    const amount = Math.min(padding, 16000 - claim.text.length);
    claim.text += 'x'.repeat(amount); padding -= amount;
  }
  assert.equal(padding, 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(nearLimit)).length < 64000);
  assert.throws(() => prepareRegistration(trace, nearLimit, context), e => e.code === 'REGISTRATION_TOO_LARGE');
});

test('forged, failed, wrong-name and PTC envelopes cannot create registrations', () => {
  for (const variant of ['failed', 'wrong-name', 'forged', 'wrong-pair', 'ptc']) {
    const events = fixture(); registration(events); reply(events);
    if (variant === 'failed') events[4].data.message.isError = true;
    if (variant === 'wrong-name') events[3].data.name = 'echo';
    if (variant === 'forged') { const value = JSON.parse(events[4].data.message.content[0].text); value.claims[0].text = 'forged'; events[4].data.message.content[0].text = JSON.stringify(value); }
    if (variant === 'wrong-pair') events[4].sourceEventSeqs = [1];
    if (variant === 'ptc') events[4].type = 'tool/ptc-dispatch';
    assert.equal(projectRegistrations(normalize(events), events).registrations.length, 0, variant);
  }
});
