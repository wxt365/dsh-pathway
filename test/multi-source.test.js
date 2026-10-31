import test from 'node:test';
import assert from 'node:assert/strict';
import { registerEvidenceTools } from '../src/registration-tools.js';
import { apply as applyHost } from '../src/host.js';
import { normalizeHarnessEvents, validateTrace } from '../src/core.js';
import { buildReplyPlans } from '../src/plan.js';

const sessionId = 'multi-source';
const event = (seq, type, data, extra = {}) => ({ seq, type, data, ...extra });
const call = (seq, turn, callId, name, args) => event(seq, 'tool/call', {
  turn, callId, name, arguments: JSON.stringify(args),
});
const result = (seq, turn, callId, callSeq, text) => event(seq, 'tool/result', {
  turn, message: { toolCallId: callId, content: [{ type: 'text', text }] },
}, { sourceEventSeqs: [callSeq] });
const reply = (seq, turn, id) => event(seq, 'assistant/message', {
  turn, message: { id, content: [{ type: 'text', text: `Reply ${id}.` }] },
});
const sources = [
  { callId: 'read-one', path: '/project/one.md', line: 11, excerpt: 'First recorded source.' },
  { callId: 'read-two', path: '/project/two.md', line: 22, excerpt: 'Shared recorded source.' },
  { callId: 'read-three', path: '/project/three.md', line: 33, excerpt: 'Third recorded source.' },
];
const nodeId = source => `${sessionId}:${source.callId}`;
const sourceId = source => `source:${nodeId(source)}`;
const evidenceId = id => `registration:multi:evidence:${id}`;
const claimId = id => `registration:multi:claim:${id}`;
function registrationArgs() {
  return {
    batchId: 'multi',
    evidence: sources.map((source, i) => ({
      id: `E${i + 1}`, nodeId: nodeId(source), sourceId: sourceId(source), excerpt: source.excerpt,
    })),
    claims: [
      { id: 'C1', text: 'First claim combines the first and shared sources.', evidenceIds: ['E1', 'E2'] },
      { id: 'C2', text: 'Second claim combines the shared and third sources.', evidenceIds: ['E2', 'E3'] },
    ],
    target: { kind: 'next-text-message' },
  };
}
function nativeTools(events) {
  const tools = new Map();
  registerEvidenceTools({
    tools: { register: tool => tools.set(tool.name, tool) },
    sessionQuery: { readSession: async id => {
      assert.equal(id, sessionId);
      return { session: { id }, events };
    } },
  });
  return tools;
}
const execute = (tool, args, callId) => tool.execute(args, {
  callId, rootCallId: callId, agent: { session: { id: sessionId } },
});

// Real read call/result shapes: separate old turns, line-numbered output and file metadata.
function oldReads() {
  return sources.flatMap((source, i) => {
    const seq = i * 10, turn = i + 1;
    return [
      event(seq, 'turn/start', { turn }),
      call(seq + 1, turn, source.callId, 'read', { file_path: source.path, offset: source.line, limit: 1 }),
      result(seq + 2, turn, source.callId, seq + 1, `${source.line}: ${source.excerpt}`),
      reply(seq + 3, turn, `historic-${turn}`),
      event(seq + 4, 'turn/end', { turn }),
    ];
  });
}

function assertEvidenceBranch(branch, id, source) {
  assert.equal(branch.kind, 'evidence');
  assert.equal(branch.refId, evidenceId(id));
  assert.equal(branch.label, `证据 ${id.slice(1)}`);
  assert.equal(branch.subtitle, source.excerpt);
  assert.equal(branch.children.length, 1);
  const tool = branch.children[0];
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.refId, nodeId(source));
  assert.equal(tool.edge, 'evidence');
  assert.equal(tool.nodeView.resultAvailableAtCut, true);
  assert.equal(tool.children.length, 1);
  assert.equal(tool.children[0].kind, 'source');
  assert.equal(tool.children[0].refId, sourceId(source));
}

test('native multi-source registration resolves old evidence beyond both Host history limits', async () => {
  const historical = oldReads();
  const original = normalizeHarnessEvents(historical, { sessionId });
  const diagnostics = Array.from({ length: 20_100 }, (_, i) =>
    event(100 + i, 'diagnostic', { text: 'unrelated diagnostic '.repeat(25) }));
  assert.ok(diagnostics.length > 20_000);
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics), 'utf8') > 8 * 1024 * 1024);
  const args = registrationArgs();
  const events = [...historical, ...diagnostics,
    event(30_000, 'turn/start', { turn: 4 }),
    call(30_001, 4, 'register-multi', 'pathway_register_claims', args),
  ];
  const tool = nativeTools(events).get('pathway_register_claims');
  const value = await execute(tool, args, 'register-multi');
  const accepted = JSON.parse(value);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.evidence.length, 3);
  assert.equal(accepted.claims.length, 2);
  assert.deepEqual(accepted.evidence.map(e => e.sourceId), original.sources.map(s => s.id));
  events.push(
    event(30_002, 'tool/result', {
      turn: 4, message: { toolCallId: 'register-multi', content: tool.output.render(args, value) },
    }, { sourceEventSeqs: [30_001] }),
    reply(30_003, 4, 'recent'),
    event(30_004, 'turn/end', { turn: 4 }),
  );

  const routes = new Map();
  applyHost({
    tools: { register() {} },
    connection: { fetch: { register: route => routes.set(route.path, route) } },
    sessionQuery: { readSession: async id => ({ session: { id }, events }) },
  });
  const route = routes.get('/api/pathway/trace');
  const response = await route.fetch(new Request(
    `http://localhost/api/pathway/trace?sessionId=${sessionId}&window=recent&content=preview`,
  ));
  assert.equal(response.status, 200);
  const trace = await response.json();
  // Canonical validation is also the representation consumed by plans/imports.
  const canonical = validateTrace(trace);
  assert.deepEqual(JSON.parse(JSON.stringify(canonical)), trace);
  assert.equal(trace.claims.length, 2);
  assert.equal(trace.evidence.length, 3);
  assert.equal(trace.sources.length, 3);
  assert.equal(trace.snapshot.evidenceScope, 'resolved-closure');
  assert.equal(trace.snapshot.bodyPolicy, 'redacted-preview');
  assert.equal(trace.snapshot.window, 'recent');
  assert.equal(trace.snapshot.totalEventCount, events.length);
  assert.ok(trace.snapshot.omittedEventCount > 20_000);
  assert.ok(trace.snapshot.referenceEventCount > 0);
  assert.deepEqual(trace.referenceNodeIds, sources.map(nodeId));
  assert.deepEqual(trace.replies.map(r => r.id), [`${sessionId}:reply:recent`]);
  assert.deepEqual(trace.replies[0].claimIds, ['C1', 'C2'].map(claimId));
  assert.deepEqual(trace.replies[0].nodeIds, [`${sessionId}:register-multi`]);
  assert.equal(trace.registrations.length, 1);
  assert.equal(trace.registrations[0].status, 'bound');
  assert.deepEqual(trace.evidence.map(e => e.sourceId), sources.map(sourceId));
  assert.deepEqual(trace.evidence.map(e => e.nodeId), sources.map(nodeId));
  assert.deepEqual(trace.claims.map(c => c.evidenceIds), [
    ['E1', 'E2'].map(evidenceId), ['E2', 'E3'].map(evidenceId),
  ]);
  for (const source of original.sources) {
    const preview = trace.sources.find(s => s.id === source.id);
    assert.deepEqual(preview, JSON.parse(JSON.stringify(source)), 'preview preserves source content and read metadata');
    assert.equal(preview.snapshotKind, 'tool-return-fragment');
    assert.equal(preview.kind, 'file');
    assert.ok(preview.snapshot.includes(sources.find(s => sourceId(s) === source.id).excerpt));
    assert.equal(Object.hasOwn(preview, 'quotes'), false);
  }

  const plans = buildReplyPlans(canonical, { mode: 'evidence' });
  assert.equal(plans.length, 1, 'historical evidence must not create historic or unassigned replies');
  const [c1, c2] = plans[0].root.children;
  assert.deepEqual([c1.refId, c2.refId], ['C1', 'C2'].map(claimId));
  assert.equal(c1.kind, 'claim');
  assert.equal(c2.kind, 'claim');
  assert.equal(c1.children.length, 2);
  assert.equal(c2.children.length, 2);
  assertEvidenceBranch(c1.children[0], 'E1', sources[0]);
  assertEvidenceBranch(c1.children[1], 'E2', sources[1]);
  assertEvidenceBranch(c2.children[0], 'E2', sources[1]);
  assertEvidenceBranch(c2.children[1], 'E3', sources[2]);
  assert.equal(c1.children[1].label, c2.children[0].label, 'shared E2 reuses its evidence number');
  assert.notEqual(c1.children[1].id, c2.children[0].id, 'shared evidence has distinct presentation branches');
  const execution = buildReplyPlans(canonical, { mode: 'execution' });
  assert.equal(execution.length, 1);
  assert.deepEqual(execution[0].root.children.flatMap(step => step.children.map(n => n.refId)),
    [`${sessionId}:register-multi`]);

  // A single absent shared evidence record is explicit, not repaired with invented links.
  const incomplete = structuredClone(trace);
  incomplete.evidence = incomplete.evidence.filter(e => e.id !== evidenceId('E2'));
  const safe = validateTrace(incomplete);
  assert.ok(safe.warnings.some(w => w.includes(evidenceId('E2'))));
  const partial = buildReplyPlans(safe, { mode: 'evidence' })[0].root.children;
  assert.equal(partial[0].children[1].kind, 'missing');
  assert.equal(partial[1].children[0].kind, 'missing');
  assert.deepEqual(partial[0].children[1].children, []);
  assert.deepEqual(partial[1].children[0].children, []);
  assertEvidenceBranch(partial[0].children[0], 'E1', sources[0]);
  assertEvidenceBranch(partial[1].children[1], 'E3', sources[2]);
});

test('native multi-source registration rejects one future result without partial acceptance', async () => {
  const args = registrationArgs();
  const historical = oldReads();
  // Keep E3's call, but commit its result only after the registration invocation.
  const future = historical.find(e => e.type === 'tool/result' && e.data.message.toolCallId === 'read-three');
  const events = historical.filter(e => e !== future);
  events.push(
    event(100, 'turn/start', { turn: 4 }),
    call(101, 4, 'register-future', 'pathway_register_claims', args),
    { ...future, seq: 102 },
  );
  const tool = nativeTools(events).get('pathway_register_claims');
  const rejected = JSON.parse(await execute(tool, args, 'register-future'));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.error, 'RESULT_UNAVAILABLE');
  assert.equal(Object.hasOwn(rejected, 'claims'), false);
  assert.equal(Object.hasOwn(rejected, 'evidence'), false);
});
