import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../src/host.js';
import { buildReplyPlans } from '../src/plan.js';

test('real read events alone create sources without inventing evidence bindings', async () => {
  const { request } = setup({read:async()=>({session:{id:'s1'},events:[
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'tool/call',data:{callId:'r',name:'functions.read',arguments:{file_path:'/tmp/design.md'}}},
    {seq:2,type:'tool/result',data:{callId:'r',message:{content:[{type:'text',text:'1: Project design'}]}}},
    {seq:3,type:'assistant/message',data:{message:{id:'a',content:[{type:'text',text:'Read the design document.'}]}}}
  ]})});
  const trace=await (await request('/api/pathway/trace?sessionId=s1')).json();
  assert.equal(trace.sources.length,1);
  assert.equal(trace.capabilities.evidenceRegistration,'native-tool-result-v1');
  assert.equal(trace.evidence.length,0);
  assert.equal(trace.claims.length,0);
  assert.match(buildReplyPlans(trace,{mode:'evidence'})[0].root.children[0].label,/未记录/);
});

function setup({ list = () => [], read = async () => ({ session: { id: 's1' }, events: [] }) } = {}) {
  const routes = new Map();
  const ctx = {
    connection: { fetch: { register(route) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route);
    } } },
    sessionQuery: { readSession: read, listSessions: list },
    tools: { register() {} },
  };
  apply(ctx);
  const request = (path, options) => {
    const req = new Request(`http://127.0.0.1:63608${path}`, options);
    return routes.get(new URL(req.url).pathname).fetch(req);
  };
  return { routes, request };
}

test('host declares dependencies and registers only authenticated exact Fetch GET routes', () => {
  assert.deepEqual(inject, ['connection', 'sessionQuery', 'tools']);
  const { routes } = setup();
  assert.deepEqual([...routes.keys()], ['/api/pathway/sessions', '/api/pathway/trace']);
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['GET']);
    assert.equal(route.requestBody, 'buffered');
  }
});

test('sessions returns live and cold metadata through official query contract', async () => {
  const session = {
    header: { id: 's1', createdAt: 123, title: 'private title', cwd: '/private/path' }, live: false, persisted: true, formatStatus: 'current',
    snapshotEvents() { throw new Error('forbidden synchronous reader'); },
    eventAt() { throw new Error('forbidden synchronous reader'); },
  };
  const { request } = setup({ list: () => [session], read: () => { throw new Error('unexpected history read'); } });
  const response = await request('/api/pathway/sessions');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), {
    sessions: [{ id: 's1', createdAt: 123, live: false, persisted: true, formatStatus: 'current' }], scope: 'live+persisted', truncated: false,
  });
});

test('trace awaits cold historical read without requiring a live session', async () => {
  let requested;
  const { request } = setup({
    list() { throw new Error('cold read must not depend on live list'); },
    async read(id) {
      requested = id;
      await Promise.resolve();
      return {
        session: { id }, inheritedEventCount: 0,
        events: [
          { seq: 0, time: 10, type: 'tool/call', data: { turn: 0, step: 0, callId: 'c1', name: 'fetch', arguments: { authorization: 'Bearer never-publish-this' } } },
          { seq: 1, time: 20, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [0], data: { turn: 0, step: 0, message: { id: 'm1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] } } },
        ],
      };
    },
  });
  const response = await request('/api/pathway/trace?sessionId=cold-session');
  assert.equal(requested, 'cold-session');
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('never-publish-this'), false);
  const trace = JSON.parse(text);
  assert.equal(trace.origin, 'harness');
  assert.ok(Array.isArray(trace.nodes));
});

test('trace rejects absent, repeated, blank and excessively long session ids before reading', async () => {
  const { request } = setup({ read: () => { throw new Error('must not read'); } });
  for (const query of ['', '?sessionId=', '?sessionId=%20', '?sessionId=a&sessionId=b', `?sessionId=${'x'.repeat(513)}`]) {
    const response = await request(`/api/pathway/trace${query}`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_SESSION_ID' });
  }
});

test('handlers remain read-only even when invoked directly with an unsupported method', async () => {
  const { request } = setup();
  for (const path of ['/api/pathway/sessions', '/api/pathway/trace?sessionId=s1']) {
    const response = await request(path, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  }
});

test('read failures use safe bounded codes, never backend messages or stacks', async () => {
  for (const [error, status, code] of [
    [Object.assign(new Error('credential=private'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }), 404, 'SESSION_NOT_FOUND'],
    [Object.assign(new Error('/private/forbidden body'), { code: 'SESSION_QUERY_FORBIDDEN' }), 403, 'SESSION_FORBIDDEN'],
    [new Error('credential=private'), 500, 'SESSION_READ_FAILED'],
  ]) {
    const { request } = setup({ read: async () => { throw error; } });
    const response = await request('/api/pathway/trace?sessionId=s1');
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
});

test('over-limit histories are refused rather than silently truncated', async () => {
  for (const events of [Array(20_001).fill(null), [{ payload: 'x'.repeat(8 * 1024 * 1024) }]]) {
    const { request } = setup({ read: async () => ({ session: { id: 's1' }, events }) });
    const response = await request('/api/pathway/trace?sessionId=s1');
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error, 'HISTORY_TOO_LARGE');
    assert.ok(['event-count', 'history-bytes'].includes(body.reason));
    assert.equal(body.limits.historyBytes, 8 * 1024 * 1024);
  }
});

test('recent window is explicit, bounded, partial and never skips an oversized tail event', async () => {
  const events = Array.from({length:21_000}, (_,seq)=>({seq,type:'step/start',data:{turn:1,step:seq}}));
  events.push({seq:21_000,type:'turn/start',data:{turn:2}});
  events.push({seq:21_001,type:'assistant/message',data:{turn:2,message:{id:'recent',content:[{type:'text',text:'recent reply'}]}}});
  const {request}=setup({read:async()=>({session:{id:'s1'},events})});
  assert.equal((await request('/api/pathway/trace?sessionId=s1')).status,413);
  for(const content of ['preview','metadata']) {
    const response=await request(`/api/pathway/trace?sessionId=s1&window=recent&content=${content}`);
    assert.equal(response.status,200);const trace=await response.json();
    assert.equal(trace.snapshot.window,'recent');assert.equal(trace.snapshot.eventCount,2);
    assert.equal(trace.snapshot.omittedEventCount,21_000);assert.equal(trace.snapshot.totalEventCount,21_002);
    assert.equal(trace.snapshot.truncation.history,true);assert.equal(trace.snapshot.coverage,'partial');
    assert.equal(trace.replies.length,1);if(content==='preview') assert.match(trace.warnings.join(' '),/历史窗口不完整/);
  }
  for(const query of ['window=bad','window=recent&window=full']) assert.equal((await request(`/api/pathway/trace?sessionId=s1&${query}`)).status,400);
  const huge=setup({read:async()=>({session:{id:'s1'},events:[{seq:0,type:'tool/result',data:{text:'x'.repeat(600_000)}}]})});
  const refused=await huge.request('/api/pathway/trace?sessionId=s1&window=recent');
  assert.equal(refused.status,413);assert.equal((await refused.json()).error,'RECENT_EVENT_TOO_LARGE');
});

test('content modes validate before reading and preview is the default', async () => {
  let reads = 0;
  const { request } = setup({ read: async () => { reads++; return { session: { id: 's1' }, inheritedEventCount: 2, events: [
    { seq: 1, type: 'assistant/message', time: 10, data: { turn: 0, message: { id: 'r', content: [{ type: 'text', text: 'PRIVATE body Bearer secret-credential' }] } } },
  ] }; } });
  for (const mode of ['full', '', 'metadata&content=preview']) {
    const response = await request(`/api/pathway/trace?sessionId=s1&content=${mode}`);
    assert.equal(response.status, 400);
  }
  assert.equal(reads, 0);
  const preview = await (await request('/api/pathway/trace?sessionId=s1')).json();
  assert.equal(preview.replies[0].text.includes('PRIVATE body'), true);
  assert.equal(JSON.stringify(preview).includes('secret-credential'), false);
  assert.equal(preview.snapshot.historyMode, 'raw-committed');
  assert.equal(preview.snapshot.coverage, 'read-complete');
  assert.equal(preview.snapshot.consistency, 'unknown');
  assert.equal(preview.snapshot.inheritedEventCount, 2);
  assert.equal(preview.capabilities.persistenceCheckpoint, false);
  const metadata = await (await request('/api/pathway/trace?sessionId=s1&content=metadata')).json();
  assert.equal(JSON.stringify(metadata).includes('PRIVATE'), false);
  assert.equal(metadata.snapshot.bodyPolicy, 'metadata-only');
});

test('session listing passes cancellation and strips hostile header metadata', async () => {
  let observed;
  const { request } = setup({ list: async signal => { observed = signal; return [{
    header: { id: 's1', createdAt: 1, title: 'PRIVATE title', cwd: '/PRIVATE/path', custom: 'PRIVATE value' },
    live: true, persisted: true, formatStatus: 'PRIVATE diagnostic',
  }]; } });
  const response = await request('/api/pathway/sessions');
  assert.ok(observed instanceof AbortSignal);
  assert.equal((await response.text()).includes('PRIVATE'), false);
});

test('field truncation is partial coverage, not complete content', async () => {
  const { request } = setup({ read: async () => ({ session: { id: 's1' }, events: [
    { type: 'tool/call', seq: 0, data: { callId: 'c', name: 'read', arguments: { text: 'x'.repeat(100001) } } },
  ] }) });
  const trace = await (await request('/api/pathway/trace?sessionId=s1')).json();
  assert.equal(trace.snapshot.coverage, 'partial');
  assert.equal(trace.snapshot.truncation.field, true);
});

test('already-aborted requests do not start historical reads', async () => {
  const { request } = setup({ read: () => { throw new Error('must not read'); } });
  const controller = new AbortController();
  controller.abort();
  const response = await request('/api/pathway/trace?sessionId=s1', { signal: controller.signal });
  assert.equal(response.status, 408);
});
