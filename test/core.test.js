import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHarnessEvents, validateTrace, importTrace, exportTrace, getReplyNodeView } from '../src/core.js';
import { redact, redactText } from '../src/security.js';
const call = (id, name='read', args={file_path:'/workspace/data.txt',offset:12,limit:5}, seq=0, t=10) => ({seq,time:t,type:'tool/call',data:{turn:0,step:1,callId:id,name,arguments:args}});
const result = (id,text='12: hello\n13: world',seq=1,t=20,error=false) => ({seq,time:t,type:'tool/result',data:{message:{toolCallId:id,content:[{type:'text',text}],isError:error}}});
const normalize = events => normalizeHarnessEvents(events,{sessionId:'s'});

test('read tracks requested and recorded ranges, not imaginary full file versions',()=>{
 const trace=normalize([call('c'),result('c')]);
 assert.equal(trace.nodes[0].status,'success');
 assert.equal(trace.sources[0].uri,'/workspace/data.txt');
 assert.match(trace.sources[0].locator,/12/);
 assert.match(trace.sources[0].returnedLocator,/12–13/);
 assert.equal(trace.sources[0].snapshotKind,'tool-return-fragment');
 assert.equal(trace.claims.length,0);
});
test('discontinuous file lines do not claim unread gaps',()=>{
 const source=normalize([call('c'),result('c','12: a\n20: b')]).sources[0];
 assert.match(source.returnedLocator,/12、20/);assert.equal(source.returnedLocator.includes('12–20'),false);
});
test('serialized secret-bearing arguments remain valid after redaction',()=>{
 const trace=normalize([call('c','http_request',JSON.stringify({url:'https://example.com',headers:{Authorization:'Bearer hidden'}})),result('c','ok')]);
 assert.equal(trace.nodes[0].input.headers.Authorization,'[REDACTED]');assert.equal(trace.sources.length,1);
});
test('web source returns real recorded text, no invented HTTP metadata or SDK calls',()=>{
 const trace=normalize([call('c','web_fetch',{url:'https://api.example.com/?token=private'}),result('c','{"value":7}')]);
 assert.equal(trace.sources[0].kind,'http');
 assert.equal(trace.sources[0].snapshot,'{"value":7}');
 assert.equal(trace.sources[0].uri.includes('private'),false);
 assert.equal(trace.sources[0].statusCode,undefined);
 assert.equal(normalize([call('b','bash',{command:'curl https://example.com'})]).sources.length,0);
});
test('PTC child tools pair with explicit execution parent, not fabricated evidence',()=>{
 const trace=normalize([call('root','run_code',{}),{seq:1,time:11,type:'tool/ptc-dispatch-start',data:{subCallId:'child',parentCallId:'root',name:'read',arguments:{file_path:'x'}}},{seq:2,time:15,type:'tool/ptc-dispatch',data:{subCallId:'child',parentCallId:'root',name:'read',content:[{type:'text',text:'1: x'}],isError:false}},result('root','done',3,20)]);
 assert.equal(trace.nodes.length,2);
 assert.equal(trace.nodes[1].parentId,'s:root');
 assert.equal(trace.nodes[1].status,'success');
 assert.equal(trace.sources.length,1);
});
test('unordered and duplicate events pair deterministically, overlapping times retained',()=>{
 const a=call('a'),b=call('b','other',{},1,11),r1=result('a','A',2,30),r2=result('b','B',3,20);
 const trace=normalize([r2,r1,b,a,a]);
 assert.equal(trace.nodes.length,2);
 assert.equal(trace.nodes[0].end,'1970-01-01T00:00:00.030Z');
 assert.equal(trace.nodes[1].start,'1970-01-01T00:00:00.011Z');
});
test('failed, open, orphan and invalid-argument calls are explicit',()=>{
 assert.equal(normalize([call('c'),result('c','failed',1,20,true)]).nodes[0].status,'error');
 assert.equal(normalize([call('c')]).nodes[0].status,'unknown');
 const orphan=normalize([result('c')]);assert.equal(orphan.nodes[0].start,null);assert.match(orphan.warnings.join(' '),/缺失调用开始/);
 assert.match(normalize([call('c','other','{invalid')]).warnings.join(' '),/JSON/);
});
test('reply cut preserves begun identity while masking a future error and source metadata',()=>{
 const message={seq:1,type:'assistant/message',data:{turn:0,message:{id:'r',content:[{type:'text',text:'progress'}]}}};
 const r=result('c','FUTURE',2,20,true);r.data.error='FUTURE ERROR';r.data.meta={path:'/future-path'};
 const trace=normalize([call('c'),message,r]), view=trace.replies[0].nodeViews[0];
 assert.equal(view.callSeq,0);assert.equal(view.resultSeq,2);assert.equal(view.cutSeq,1);
 assert.equal(view.resultAvailableAtCut,false);assert.equal(view.output,null);assert.equal(view.end,null);
 assert.equal(view.error,undefined);assert.deepEqual(view.sourceIds,[]);assert.equal(view.resultState,'missing-result');
 assert.equal(view.activityState,'unknown');assert.equal(trace.nodes[0].resultState,'error');
 assert.equal(trace.sources[0].uri,'/future-path');assert.equal(trace.nodes[0].output,'FUTURE');
 for(const mutate of [v=>v.output='FUTURE',v=>v.end=trace.nodes[0].end,v=>v.sourceIds=trace.nodes[0].sourceIds,v=>v.status='success',v=>v.extra='FUTURE',v=>v.resultAvailableAtCut=true]) {
  const bad=structuredClone(trace);mutate(bad.replies[0].nodeViews[0]);assert.throws(()=>validateTrace(bad),/nodeViews/);
 }
 const bad=structuredClone(trace);delete bad.replies[0].nodeViews;assert.throws(()=>validateTrace(bad),/截面/);
 const badState=structuredClone(trace);badState.nodes[0].activityState='running';assert.throws(()=>validateTrace(badState),/runtime/);
 const stripped=structuredClone(trace);delete stripped.orderBasis;delete stripped.replies[0].cutSeq;delete stripped.replies[0].nodeViews;delete stripped.replies[0].orderBasis;assert.throws(()=>validateTrace(stripped),/cutSeq/);
 const incomplete=structuredClone(trace);delete incomplete.nodes[0].resultState;assert.throws(()=>validateTrace(incomplete),/不完整/);
});
test('seq conflicts are diagnosed, duplicates idempotent, no seq uses input order',()=>{
 const a=call('a');assert.equal(normalize([a,a]).warnings.some(w=>w.includes('冲突')),false);
 const conflicting=normalize([a,call('b')]);assert.match(conflicting.warnings.join(' '),/seq 0 内容冲突/);assert.equal(conflicting.nodes.length,1);
 const c=call('c');delete c.seq;
 const reply={type:'assistant/message',data:{turn:0,message:{content:[{type:'text',text:'hello'}]}}};
 const trace=normalize([c,reply,result('c','later',20)]);
 assert.equal(trace.orderBasis,'input-order');assert.equal(trace.replies[0].orderBasis,'input-order');
 assert.equal(trace.replies[0].cutSeq,1);assert.equal(trace.replies[0].nodeViews[0].output,null);
 assert.match(trace.warnings.join(' '),/input-order/);
 assert.equal(normalize([result('orphan')]).nodes[0].resultState,'missing-start');
 assert.equal(normalize([c]).nodes[0].resultState,'missing-result');
});
test('read metadata uses returned canonical path and actual recorded lines',()=>{
 const r=result('c','snippet'); r.data.meta={path:'/resolved/a',lines:[{number:22,text:'x'},{number:23,text:'y'}]};
 const source=normalize([call('c'),r]).sources[0];assert.equal(source.uri,'/resolved/a');assert.match(source.returnedLocator,/22–23/);
});
test('explicit conclusions show dangling evidence; imported verification is never trusted',()=>{
 const trace=normalize([call('c'),result('c')]);
 trace.claims=[{id:'C1',text:'claim',evidenceIds:['missing'],limitations:[],verification:'verified'}];
 const checked=validateTrace(trace);assert.match(checked.warnings.join(' '),/缺失证据/);assert.equal(checked.claims[0].verification,'unverified');
 assert.equal(importTrace(exportTrace(checked)).origin,'import');
});
test('validation rejects duplicate ids, bad schema, oversized or deep input',()=>{
 const trace=normalize([call('c')]);trace.nodes.push(trace.nodes[0]);assert.throws(()=>validateTrace(trace),/重复/);
 assert.throws(()=>importTrace('{"schemaVersion":2}'),/schemaVersion/);
 assert.throws(()=>importTrace('x'.repeat(8*1024*1024+1)),/8 MiB/);
 let deep={};for(let i=0;i<40;i++)deep={deep};assert.throws(()=>redact(deep),/层级/);
});
test('secrets are scrubbed in keys, serialized JSON text, bearer values and URL credentials',()=>{
 const text=JSON.stringify(redact({headers:{Authorization:'Bearer abc',Cookie:'session=xyz'},url:'https://u:pw@api.example/?api_key=private',body:'{"password":"top-secret","safe":7}',token:'foo',output:'Authorization: Bearer abc\napi_key=private'}));
 for(const secret of ['top-secret','private','session=xyz','Bearer abc','u:pw','foo'])assert.equal(text.includes(secret),false,secret);
 assert.equal(redactText('ordinary text'),'ordinary text');
});
test('compact reply views avoid amplifying a 90 KB read across 100 replies',()=>{
 const payload='x'.repeat(90*1024), input={file_path:'/workspace/large.txt',context:'y'.repeat(20000)};
 const messages=Array.from({length:100},(_,i)=>({seq:i+2,type:'assistant/message',data:{turn:0,message:{id:`r${i}`,content:[{type:'text',text:'reply'}]}}}));
 const trace=normalize([call('c','read',input),result('c',payload),...messages]);
 assert.equal(trace.replies.length,100);
 for(const reply of trace.replies) {
  const view=reply.nodeViews[0];
  assert.equal(view.compact,true);assert.equal('input' in view,false);assert.equal('output' in view,false);
  const full=getReplyNodeView(trace,reply,'s:c');
  assert.equal(full.output,payload);assert.equal(full.input.context,input.context);assert.equal(full.compact,undefined);
 }
 assert.ok(Buffer.byteLength(JSON.stringify(trace))<8*1024*1024);
 const imported=importTrace(exportTrace(trace));
 assert.equal(imported.replies[99].nodeViews[0].compact,true);
 assert.equal(getReplyNodeView(imported,imported.replies[99],'s:c').output,payload);
});
test('validator accepts canonical legacy full views but rejects altered compact or full views',()=>{
 const message={seq:2,type:'assistant/message',data:{turn:0,message:{id:'r',content:[{type:'text',text:'reply'}]}}};
 const trace=normalize([call('c'),result('c'),message]);
 const legacy=structuredClone(trace);
 legacy.replies[0].nodeViews=legacy.replies[0].nodeIds.map(id=>getReplyNodeView(legacy,legacy.replies[0],id));
 assert.equal(validateTrace(legacy).replies[0].nodeViews[0].output,'12: hello\n13: world');
 for(const base of [trace,legacy]) for(const mutate of [v=>v.output='forged',v=>v.input={},v=>v.sourceIds=[],v=>v.extra=true,v=>v.compact=false]) {
  const bad=structuredClone(base);mutate(bad.replies[0].nodeViews[0]);assert.throws(()=>validateTrace(bad),/nodeViews/);
 }
});
test('full reply resolution still masks future output, source and error from compact storage',()=>{
 const message={seq:1,type:'assistant/message',data:{turn:0,message:{id:'r',content:[{type:'text',text:'progress'}]}}};
 const future=result('c','FUTURE',2,20,true);future.data.error='FUTURE ERROR';future.data.meta={path:'/future'};
 const trace=normalize([call('c'),message,future]);
 const reply=trace.replies[0], view=getReplyNodeView(trace,reply,'s:c');
 assert.equal(reply.nodeViews[0].compact,true);assert.equal(view.output,null);assert.equal(view.error,undefined);
 assert.deepEqual(view.sourceIds,[]);assert.equal(view.resultAvailableAtCut,false);
 const legacy=structuredClone(trace);legacy.replies[0].nodeViews=[view];assert.doesNotThrow(()=>validateTrace(legacy));
 for(const mutate of [v=>v.output='FUTURE',v=>v.sourceIds=trace.nodes[0].sourceIds,v=>v.resultAvailableAtCut=true,v=>v.error='FUTURE ERROR']) {
  const bad=structuredClone(trace);mutate(bad.replies[0].nodeViews[0]);assert.throws(()=>validateTrace(bad),/nodeViews/);
 }
});
test('source and content truncation remain visible; malicious content stays plain text',()=>{
 const trace=normalize([call('c'),result('c','12: <img src=x onerror=alert(1)>\n(Showing lines 12-12)')]);
 assert.equal(trace.sources[0].truncated,true);assert.match(trace.sources[0].snapshot,/<img/);
 const oversized=normalize([call('c'),result('c','x'.repeat(100010))]);assert.match(oversized.nodes[0].output,/Pathway 截断/);
});
