import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHarnessEvents } from '../src/core.js';
import { replyScope } from '../src/scope.js';
import { buildReplyPlans } from '../src/plan.js';
import { selectedTrace } from '../src/transfer.js';

test('reply scope includes explicit old references but masks future outputs and sources',()=>{
 const events=[
 {type:'turn/start',seq:0,data:{turn:1}},
 {type:'tool/call',seq:1,data:{turn:1,callId:'old',name:'read',arguments:{file_path:'old.md'}}},
 {type:'tool/result',seq:2,data:{message:{toolCallId:'old',content:[{type:'text',text:'1: old evidence'}]}}},
 {type:'assistant/message',seq:3,data:{turn:1,message:{id:'first',content:[{type:'text',text:'first'}]}}},
 {type:'turn/start',seq:4,data:{turn:2}},
 {type:'tool/call',seq:5,data:{turn:2,callId:'late',name:'read',arguments:{file_path:'late.md'}}},
 {type:'assistant/message',seq:6,data:{turn:2,message:{id:'early',content:[{type:'text',text:'early'}]}}},
 {type:'tool/result',seq:7,data:{message:{toolCallId:'late',content:[{type:'text',text:'1: FUTURE'}]}}},
 {type:'assistant/message',seq:8,data:{turn:2,message:{id:'last',content:[{type:'text',text:'last'}]}}}
 ];
 const trace=normalizeHarnessEvents(events,{sessionId:'s'});
 trace.evidence=[{id:'E1',nodeId:'s:old',excerpt:'old evidence'},{id:'E2',nodeId:'s:late',excerpt:'FUTURE'}];
 trace.claims=[{id:'C',text:'claim',evidenceIds:['E1','E2']}];
 trace.replies[1].claimIds=['C'];
 const scoped=replyScope(trace,'s:reply:early');
 assert.equal(scoped.nodes.length,2);
 assert.equal(scoped.nodes.find(n=>n.id==='s:late').output,null);
 assert.equal(scoped.evidence.find(e=>e.id==='E2').excerpt,'');
 assert.equal(scoped.sources.some(s=>s.uri==='late.md'),false);
 assert.equal(scoped.claims.length,1);
 assert.equal(replyScope(trace,'missing').nodes.length,0);
});

function cutTrace() {
 return normalizeHarnessEvents([
  {type:'turn/start',seq:0,data:{turn:1}},
  {type:'tool/call',seq:1,data:{callId:'parent',name:'read',arguments:{file_path:'parent.md'}}},
  {type:'tool/result',seq:2,data:{message:{toolCallId:'parent',content:[{type:'text',text:'parent snapshot'}]}}},
  {type:'turn/start',seq:3,data:{turn:2}},
  {type:'tool/call',seq:4,data:{callId:'child',name:'read',arguments:{file_path:'child.md'}}},
  {type:'assistant/message',seq:5,data:{message:{id:'early',content:[{type:'text',text:'early'}]}}},
  {type:'tool/result',seq:6,data:{message:{toolCallId:'child',content:[{type:'text',text:'FUTURE SNAPSHOT'}]}}}
 ],{sessionId:'s'});
}

test('reply scope masks future completion metadata, not just result payloads',()=>{
 const trace=cutTrace(), scoped=replyScope(trace,'s:reply:early');
 const child=scoped.nodes.find(n=>n.id==='s:child');
 assert.equal(child.resultAvailableAtCut,false);
 assert.equal(child.resultSeq,null);
 assert.equal(child.end,null);
 assert.equal(child.output,null);
 assert.deepEqual(child.sourceIds,[]);
});

test('reply scope retains explicit execution ancestors for source parent navigation and export parity',()=>{
 const trace=cutTrace();
 trace.nodes.find(n=>n.id==='s:child').parentId='s:parent';
 const scoped=replyScope(trace,'s:reply:early');
 const exported=selectedTrace(trace,{replyId:'s:reply:early'});
 assert.ok(scoped.nodes.some(n=>n.id==='s:parent'));
 assert.deepEqual(new Set(scoped.nodes.map(n=>n.id)),new Set(exported.nodes.map(n=>n.id)));
 assert.deepEqual(new Set(scoped.sources.map(s=>s.id)),new Set(exported.sources.map(s=>s.id)));
});

test('reply scope does not expose a future-owned source via another node sourceIds',()=>{
 const trace=cutTrace();
 const future=trace.sources.find(s=>s.nodeId==='s:child');
 const parent=trace.nodes.find(n=>n.id==='s:parent');
 parent.sourceIds.push(future.id);
 trace.replies.find(r=>r.id==='s:reply:early').nodeIds.push(parent.id);
 const scoped=replyScope(trace,'s:reply:early');
 assert.equal(scoped.sources.some(s=>s.id===future.id),false);
 assert.equal(JSON.stringify(scoped.sources).includes('FUTURE SNAPSHOT'),false);
 assert.equal(selectedTrace(trace,{replyId:'s:reply:early'}).sources.some(s=>s.id===future.id),false);
});

test('synthetic legacy choices must not silently broaden a missing reply scope',()=>{
 const trace=cutTrace(); trace.replies=[];
 const legacy=buildReplyPlans(trace)[0];
 assert.equal(legacy.reply.kind,'legacy');
 assert.ok(legacy.reply.nodeIds.length>0);
 // The viewer must use snapshot mode for synthetic choices rather than pretending
 // this empty, fail-closed model represents the legacy execution graph.
 assert.deepEqual(replyScope(trace,legacy.id).nodes,[]);
 assert.throws(()=>selectedTrace(trace,{replyId:legacy.id}),/EXPORT_SELECTION_NOT_FOUND/);
});
