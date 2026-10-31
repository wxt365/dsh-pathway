import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHarnessEvents, validateTrace } from '../src/core.js';
import { buildReplyPlans } from '../src/plan.js';
import { createDemoTrace } from '../src/demo.js';
test('evidence cards use reply-local stable numbers and quotes without losing reference ids',()=>{
 const trace=createDemoTrace();
 const plans=buildReplyPlans(trace,{mode:'evidence'});
 let checked=0;
 for(const plan of plans) {
  const numbers=new Map();
  for(const node of walk(plan.root).filter(n=>n.kind==='evidence')) {
   if(!numbers.has(node.refId)) numbers.set(node.refId,numbers.size+1);
   assert.equal(node.label,`证据 ${numbers.get(node.refId)}`);
   const evidence=trace.evidence.find(e=>e.id===node.refId);
   if(evidence.excerpt) assert.equal(node.subtitle,evidence.excerpt);
   checked++;
  }
 }
 assert.ok(checked>0);
});

const walk = root => [root, ...root.children.flatMap(walk)];
const event = (seq,type,data) => ({seq,type,data,time:seq*1000});
const call = (seq,id,turn=1) => event(seq,'tool/call',{turn,step:1,callId:id,name:'read',arguments:{file_path:'data.txt'}});
const result = (seq,id,turn=1) => event(seq,'tool/result',{turn,step:1,message:{toolCallId:id,isError:false,content:[{type:'text',text:'1: data'}]}});
const reply = (seq,id,text,turn=1) => event(seq,'assistant/message',{turn,step:2,message:{id,content:[{type:'text',text}]}});

test('each textual assistant message has own plan, later tool execution never joins earlier reply',()=>{
 const trace=normalizeHarnessEvents([event(0,'turn/start',{turn:1}),call(1,'a'),result(2,'a'),reply(3,'progress','已获得第一份数据'),call(4,'b'),result(5,'b'),reply(6,'final','最终答复'),call(7,'later'),result(8,'later'),event(9,'turn/end',{turn:1,reason:{kind:'completed'}})],{sessionId:'s'});
 assert.equal(trace.replies.length,3);
 assert.deepEqual(trace.replies[0].nodeIds,['s:a']);
 assert.deepEqual(trace.replies[1].nodeIds,['s:a','s:b']);
 assert.deepEqual(trace.replies[2].nodeIds,['s:later']);
 assert.equal(trace.replies[2].kind,'pending');
 assert.equal(buildReplyPlans(trace).length,3);
});
test('zero-turn and zero-step are valid; turn step reset and tool-only messages ignored',()=>{
 const trace=normalizeHarnessEvents([event(0,'turn/start',{turn:0}),call(1,'a',0),result(2,'a',0),event(3,'assistant/message',{turn:0,step:0,message:{id:'tool-message',content:[{type:'tool-call',id:'x',name:'read',arguments:'{}'}]}}),reply(4,'text','直接文本',0),event(5,'turn/start',{turn:1}),reply(6,'next','新一轮',1)],{sessionId:'s'});
 assert.equal(trace.replies.length,2);assert.equal(trace.replies[0].turn,0);
 assert.deepEqual(trace.replies[1].nodeIds,[]);
});
test('attempts and reasoning blocks never become reply text; interrupted text is marked',()=>{
 const r=reply(2,'partial','部分答复');r.data.interrupted=true;
 const trace=normalizeHarnessEvents([event(0,'assistant/attempt',{message:{content:[{type:'text',text:'attempt'}]}}),event(1,'assistant/message',{message:{content:[{type:'reasoning',text:'private'}]}}),r]);
 assert.equal(trace.replies.length,1);assert.equal(trace.replies[0].interrupted,true);assert.equal(trace.replies[0].text,'部分答复');
});
test('unknown turn tools stay unassigned instead of entering an arbitrary reply',()=>{
 const c=call(0,'a');delete c.data.turn;
 const trace=normalizeHarnessEvents([c,reply(1,'answer','回复',2)],{sessionId:'s'});
 assert.deepEqual(trace.replies[0].nodeIds,[]);assert.equal(trace.replies[1].status,'unassigned');
});
test('result committed after reply is not exposed as that reply input',()=>{
 const trace=normalizeHarnessEvents([call(0,'a'),reply(1,'early','还在获取'),result(2,'a')],{sessionId:'s'});
 assert.deepEqual(trace.replies[0].nodeIds,['s:a']);assert.equal(trace.replies.length,1);
 assert.equal(trace.replies[0].cutSeq,1);
 assert.equal(trace.replies[0].nodeViews[0].output,null);
 assert.equal(trace.nodes[0].output,'1: data');
 const tool=walk(buildReplyPlans(trace)[0].root).find(n=>n.refId==='s:a');
 assert.equal(tool.nodeView.output,null);assert.equal(tool.status,'unknown');
 assert.equal(walk(buildReplyPlans(trace)[0].root).some(n=>n.kind==='source'),false);
});
test('refresh keeps old cut stable and evidence never exposes a future source or excerpt',()=>{
 const events=[call(0,'a'),reply(1,'early','处理中'),result(2,'a'),reply(3,'late','完成')];
 const before=normalizeHarnessEvents(events.slice(0,2),{sessionId:'s'});
 const trace=normalizeHarnessEvents(events,{sessionId:'s'});
 assert.deepEqual(before.replies[0].nodeIds,trace.replies[0].nodeIds);
 assert.equal(trace.replies[0].nodeViews[0].resultState,'missing-result');
 assert.equal(trace.replies[1].nodeViews[0].resultState,'returned');
 const plans=buildReplyPlans(trace);
 assert.equal(walk(plans[0].root).filter(n=>n.kind==='source').length,0);
 assert.equal(walk(plans[1].root).filter(n=>n.kind==='source').length,1);
 trace.evidence=[{id:'e',nodeId:'s:a',sourceId:trace.sources[0].id,excerpt:'FUTURE EXCERPT',attribution:'explicit'}];
 trace.claims=[{id:'c',text:'claim',evidenceIds:['e'],limitations:[]}];trace.replies[0].claimIds=['c'];
 const tree=walk(buildReplyPlans(validateTrace(trace),{mode:'evidence'})[0].root);
 assert.equal(JSON.stringify(tree).includes('FUTURE EXCERPT'),false);
 assert.equal(tree.some(n=>n.kind==='source'),false);assert.ok(tree.some(n=>n.label==='证据在此截面不可用'));
});
test('execution tree nests step, PTC tool and source, with distinct edge semantics',()=>{
 const trace=validateTrace(createDemoTrace()),plan=buildReplyPlans(trace)[1];
 assert.equal(plan.root.kind,'reply');assert.equal(plan.root.children.length,2);
 const tree=walk(plan.root);assert.equal(tree.filter(n=>n.kind==='tool').length,7);
 assert.equal(tree.filter(n=>n.kind==='source').length,2);
 assert.equal(tree.find(n=>n.refId==='read-1').edge,'execution');
 assert.equal(tree.find(n=>n.refId==='source-file').edge,'observed');
 const first=walk(buildReplyPlans(trace)[0].root);assert.equal(first.some(n=>n.refId==='calc-1'),false);
});
test('evidence mode uses only reply claimIds, preserves missing evidence, no fake fallback',()=>{
 const plans=buildReplyPlans(validateTrace(createDemoTrace()),{mode:'evidence'});
 assert.match(plans[0].root.children[0].label,/未记录/);
 const tree=walk(plans[1].root);
 assert.equal(tree.filter(n=>n.kind==='claim').length,2);
 assert.equal(tree.filter(n=>n.kind==='evidence').length,3);
 assert.ok(tree.some(n=>n.label.includes('e-campaign-missing')));
 assert.equal(tree.some(n=>n.refId==='check-1'),false);
});
test('legacy imports and orphan nodes are explicitly unassigned, not fabricated assistant messages',()=>{
 const demo=createDemoTrace();delete demo.replies;
 const legacy=buildReplyPlans(validateTrace(demo));assert.equal(legacy.length,1);assert.equal(legacy[0].reply.kind,'legacy');
 demo.replies=[{id:'r',kind:'assistant',status:'recorded',text:'回复',nodeIds:['read-1'],claimIds:[]}];
 const plans=buildReplyPlans(validateTrace(demo));assert.equal(plans.length,2);assert.equal(plans[1].reply.status,'unassigned');
});
test('cyclic parentId never causes unbounded recursion',()=>{
 const demo=createDemoTrace();demo.nodes[0].parentId='read-1';
 const tree=walk(buildReplyPlans(validateTrace(demo))[1].root);
 assert.ok(tree.some(n=>n.label.includes('循环')));assert.ok(tree.length<100);
});
test('reply validation rejects malformed references and duplicate ids',()=>{
 const demo=createDemoTrace();demo.replies[0].nodeIds=[{}];assert.throws(()=>validateTrace(demo),/回复/);
 const d=createDemoTrace();d.replies.push(d.replies[0]);assert.throws(()=>validateTrace(d),/重复/);
});
