import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataTrace, selectedTrace } from '../src/transfer.js';
import { validateTrace, importTrace, exportTrace, normalizeHarnessEvents, getReplyNodeView } from '../src/core.js';
import { buildReplyPlans } from '../src/plan.js';

test('exports retain only allowlisted partial-window scope facts', () => {
  const trace=fixture();trace.snapshot={window:'recent',omittedEventCount:42,eventCount:5,totalEventCount:47,private:'PRIVATE snapshot'};
  for(const result of [metadataTrace(trace),selectedTrace(trace,{replyId:trace.replies[0].id})]) {
    assert.equal(result.snapshot.truncation.history,true);
    assert.equal(result.snapshot.omittedEventCount,42);
    assert.equal(result.snapshot.private,undefined);
    assert.match(result.warnings.join(' '),/近期历史窗口/);
  }
});

function fixture() {
  return { schemaVersion: 1, id: 'session', origin: 'import', imported: true, title: 'PRIVATE title',
    custom: 'PRIVATE custom', snapshot: { payload: 'PRIVATE snapshot' }, warnings: ['PRIVATE error'], observability: ['PRIVATE note'],
    nodes: ['a', 'b'].map(id => ({ id, kind: 'tool', status: 'success', label: 'PRIVATE label',
      input: { path: '/PRIVATE/absolute', authorization: 'Bearer PRIVATEsecret' }, output: `PRIVATE output ${id}`,
      error: { message: 'PRIVATE error' }, sourceIds: [`s${id}`], future: 'PRIVATE future' })),
    sources: ['a', 'b'].map(id => ({ id: `s${id}`, nodeId: id, kind: 'file', uri: '/PRIVATE/absolute', snapshot: `PRIVATE snapshot ${id}`, custom: 'PRIVATE custom' })),
    evidence: [{ id: 'e', nodeId: 'a', sourceId: 'sa', attribution: 'imported', excerpt: 'PRIVATE excerpt' }],
    claims: [{ id: 'c', text: 'PRIVATE claim', evidenceIds: ['e', 'missing'], limitations: ['PRIVATE limitation'] }],
    replies: [{ id: 'r', kind: 'assistant', status: 'recorded', text: 'PRIVATE reply a', nodeIds: ['a'], claimIds: ['c'],
      nodeViews: [{ id: 'a', kind: 'tool', status: 'success', label: 'PRIVATE view', sourceIds: ['sa'], output: 'PRIVATE view output', custom: 'PRIVATE view custom' }] },
      { id: 'r2', kind: 'assistant', status: 'recorded', text: 'PRIVATE unrelated reply', nodeIds: ['b'], claimIds: [] }] };
}

test('metadata is an importable field allowlist, including hostile future fields and resource ids', () => {
  const trace = fixture();
  trace.nodes[0].parentId = '/PRIVATE/parent';
  trace.nodes[0].custom = { text: 'PRIVATE' };
  const out = metadataTrace(trace), text = JSON.stringify(out);
  assert.equal(text.includes('PRIVATE'), false);
  assert.equal(text.includes('/PRIVATE'), false);
  assert.equal(out.origin, 'import');
  assert.equal(out.imported, true);
  assert.equal(out.replies[0].nodeViews, undefined);
  assert.equal(out.sources[0].uri, 'file');
  assert.equal(importTrace(exportTrace(out)).origin, 'import');
  assert.equal(out.exportScope.type, 'metadata');
});

test('reply export is a deduplicated closure and never contains unrelated content', () => {
  const out = selectedTrace(fixture(), { replyId: 'r' });
  assert.deepEqual(out.nodes.map(n => n.id), ['a']);
  assert.deepEqual(out.sources.map(s => s.id), ['sa']);
  assert.deepEqual(out.replies.map(r => r.id), ['r']);
  assert.equal(JSON.stringify(out).includes('PRIVATE output b'), false);
  assert.equal(JSON.stringify(out).includes('PRIVATE unrelated reply'), false);
  assert.equal(JSON.stringify(out).includes('PRIVATEsecret'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(out.exportScope.missing)), [{ kind: 'evidence', id: 'missing' }]);
  assert.equal(out.exportScope.omitted.nodes, 1);
  validateTrace(out);
});

test('claim selection does not pull other replies or execution siblings into the package', () => {
  const out = selectedTrace(fixture(), { claimId: 'c' });
  assert.equal(out.replies.length, 0);
  assert.deepEqual(out.nodes.map(n => n.id), ['a']);
  assert.throws(() => selectedTrace(fixture()), /REQUIRED/);
  assert.throws(() => selectedTrace(fixture(), { replyId: 'unknown' }), /NOT_FOUND/);
  assert.throws(() => selectedTrace(fixture(), { replyId: 'r2', claimId: 'c' }), /MISMATCH/);
});

test('real normalized reply exports remain importable without future output or sources', () => {
  const trace = normalizeHarnessEvents([
    { type: 'tool/call', seq: 0, data: { turn: 0, callId: 'a', name: 'read', arguments: { file_path: '/PRIVATE/file' } } },
    { type: 'assistant/message', seq: 1, data: { turn: 0, message: { id: 'r', content: [{ type: 'text', text: 'reply' }] } } },
    { type: 'tool/result', seq: 2, data: { turn: 0, message: { toolCallId: 'a', content: [{ type: 'text', text: 'PRIVATE future output' }] } } },
  ], { sessionId: 's' });
  const out = selectedTrace(trace, { replyId: 's:reply:r' });
  assert.equal(out.nodes[0].output, null);
  assert.equal(out.sources.length, 0);
  assert.equal(JSON.stringify(out).includes('PRIVATE future'), false);
  assert.equal(out.replies[0].nodeViews, undefined);
  assert.equal(importTrace(exportTrace(out)).origin, 'import');
  assert.equal(importTrace(exportTrace(metadataTrace(trace))).origin, 'import');
});

test('metadata preserves canonical reply cuts without copying private node views', () => {
  const trace = normalizeHarnessEvents([
    { type: 'tool/call', seq: 0, data: { turn: 0, callId: 'a', name: 'read', arguments: { file_path: '/PRIVATE/file' } } },
    { type: 'assistant/message', seq: 1, data: { turn: 0, message: { id: 'early', content: [{ type: 'text', text: 'PRIVATE early' }] } } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'a', content: [{ type: 'text', text: 'PRIVATE future output' }] } } },
    { type: 'assistant/message', seq: 3, data: { turn: 0, message: { id: 'late', content: [{ type: 'text', text: 'PRIVATE late' }] } } },
    { type: 'tool/call', seq: 4, data: { turn: 0, callId: 'open', name: 'read', arguments: { file_path: '/PRIVATE/open' } } },
  ], { sessionId: 's' });
  if (trace.replies[0].nodeViews) trace.replies[0].nodeViews[0].custom = 'PRIVATE hostile nested field';
  const out = importTrace(exportTrace(metadataTrace(trace)));
  assert.equal(JSON.stringify(out).includes('PRIVATE'), false);
  assert.equal(out.orderBasis, 'seq');
  assert.equal(out.nodes.find(n => n.id === 's:open').resultSeq, null);
  const walk = root => [root, ...root.children.flatMap(walk)];
  const plans = buildReplyPlans(out);
  for (const [index, available] of [[0, false], [1, true]]) {
    const reply = out.replies[index], view = getReplyNodeView(out, reply, 's:a');
    assert.equal(reply.cutSeq, index === 0 ? 1 : 3);
    assert.deepEqual(JSON.parse(JSON.stringify(view)), JSON.parse(JSON.stringify(getReplyNodeView(out, reply, 's:a'))));
    assert.equal(view.resultAvailableAtCut, available);
    assert.equal(view.status, available ? 'success' : 'unknown');
    assert.equal(walk(plans[index].root).filter(n => n.kind === 'source').length, available ? 1 : 0);
  }
  validateTrace(out);
});

test('a claim pointing to an entirely future tool cannot export its excerpt', () => {
  const trace = normalizeHarnessEvents([
    {type:'assistant/message',seq:0,data:{turn:1,message:{id:'r',content:[{type:'text',text:'early'}]}}},
    {type:'tool/call',seq:1,data:{turn:1,callId:'future',name:'calculator',arguments:{}}},
    {type:'tool/result',seq:2,data:{message:{toolCallId:'future',content:[{type:'text',text:'FUTURE_VALUE'}]}}}
  ],{sessionId:'s'});
  trace.evidence=[{id:'e',nodeId:'s:future',excerpt:'FUTURE_EXCERPT',attribution:'explicit'}];
  trace.claims=[{id:'c',text:'claim',evidenceIds:['e'],limitations:[]}];
  trace.replies[0].claimIds=['c'];
  const out=selectedTrace(trace,{replyId:'s:reply:r',claimId:'c'});
  assert.equal(JSON.stringify(out).includes('FUTURE_EXCERPT'),false);
  assert.equal(out.nodes.length,0);
  assert.ok(out.exportScope.missing.some(m=>m.kind==='evidence-content'));
});


test('export identifiers are injective across unsafe hash collisions and safe opaque literals', () => {
  // These suffixes collide under the previous 32-bit FNV mapping (same prefix).
  const unsafe = ['/PRIVATE/tGP*N*@s]D$4', '/PRIVATE/PfaU5e=U\\4j?'];
  const trace = { schemaVersion: 1, id: '/PRIVATE/session', origin: 'import',
    nodes: [...unsafe, 'opaque:1', 'opaque:2', 'opaque:e0b60575'].map((id, i) => ({ id, kind: 'tool', label: 'tool', status: 'success',
      sourceIds: [`/PRIVATE/source/${i}`], ...(i === 0 ? { parentId: unsafe[1] } : {}) })),
    sources: [], evidence: [], claims: [], replies: [] };
  trace.sources = trace.nodes.map((n, i) => ({ id: n.sourceIds[0], nodeId: n.id, kind: 'file', uri: '/PRIVATE/file', snapshot: 'quote' }));
  trace.evidence = trace.nodes.map((n, i) => ({ id: `/PRIVATE/evidence/${i}`, nodeId: n.id, sourceId: n.sourceIds[0], attribution: 'imported', excerpt: 'quote' }));
  trace.claims = [{ id: '/PRIVATE/claim', text: 'claim', evidenceIds: [...trace.evidence.map(e => e.id), '/PRIVATE/missing'], limitations: [] }];
  trace.replies = [{ id: '/PRIVATE/reply', kind: 'assistant', status: 'recorded', text: 'reply', nodeIds: trace.nodes.map(n => n.id), claimIds: [trace.claims[0].id] }];
  for (const out of [metadataTrace(trace), selectedTrace(trace, { replyId: trace.replies[0].id, claimId: trace.claims[0].id })]) {
    assert.equal(new Set(out.nodes.map(n => n.id)).size, 5);
    assert.equal(out.nodes[2].id, 'opaque:1');
    assert.equal(out.nodes[3].id, 'opaque:2');
    assert.equal(out.nodes[4].id, 'opaque:e0b60575');
    assert.equal(out.nodes[0].parentId, out.nodes[1].id);
    assert.deepEqual(out.replies[0].nodeIds, out.nodes.map(n => n.id));
    assert.deepEqual(out.replies[0].claimIds, [out.claims[0].id]);
    for (let i = 0; i < out.nodes.length; i++) {
      assert.equal(out.nodes[i].sourceIds[0], out.sources[i].id);
      assert.equal(out.sources[i].nodeId, out.nodes[i].id);
      assert.equal(out.evidence[i].nodeId, out.nodes[i].id);
      assert.equal(out.evidence[i].sourceId, out.sources[i].id);
      assert.equal(out.claims[0].evidenceIds[i], out.evidence[i].id);
    }
    assert.equal(JSON.stringify(out).includes('/PRIVATE/'), out.exportScope.type === 'selected');
    if (out.exportScope.type === 'selected') {
      assert.equal(out.exportScope.replyId, out.replies[0].id);
      assert.equal(out.exportScope.claimId, out.claims[0].id);
      assert.equal(out.exportScope.missing[0].id, out.claims[0].evidenceIds.at(-1));
    }
    importTrace(exportTrace(out));
  }
});
