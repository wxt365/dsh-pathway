import test from 'node:test';
import assert from 'node:assert/strict';
import {registerEvidenceTools} from '../src/registration-tools.js';
import {normalizeHarnessEvents, validateTrace} from '../src/core.js';
import {projectRegistrations} from '../src/registration.js';
import {apply as applyHost} from '../src/host.js';
import {buildReplyPlans} from '../src/plan.js';

test('native tool output replays into one reply evidence path without sidecar writes',async()=>{
 const events=[
  {seq:0,type:'turn/start',data:{turn:1}},
  {seq:1,type:'tool/call',data:{turn:1,callId:'read',name:'read',arguments:{file_path:'design.md'}}},
  {seq:2,type:'tool/result',data:{turn:1,message:{toolCallId:'read',content:[{type:'text',text:'1: Evidence is explicit.'}]}}}
 ];
 const tools=new Map();registerEvidenceTools({tools:{register:t=>tools.set(t.name,t)},sessionQuery:{readSession:async()=>({events})}});
 const args={batchId:'batch',evidence:[{id:'ev',nodeId:'s:read',sourceId:'source:s:read',excerpt:'Evidence is explicit.'}],claims:[{id:'claim',text:'Evidence must be registered.',evidenceIds:['ev']}],target:{kind:'next-text-message'}};
 events.push({seq:3,type:'tool/call',data:{turn:1,callId:'reg',name:'pathway_register_claims',arguments:JSON.stringify(args)}});
 const tool=tools.get('pathway_register_claims');
 assert.deepEqual(tool.parameters.properties.evidence.items.properties.locator.enum,['exact-substring']);
 assert.match(tool.description,/Omit locator/);
 const invalid=structuredClone(args);invalid.evidence[0].locator='design.md:1';
 const invalidResult=JSON.parse(await tool.execute(invalid,{callId:'reg',rootCallId:'reg',agent:{session:{id:'s'}}}));
 assert.equal(invalidResult.error,'INVALID_LOCATOR');assert.match(invalidResult.hint,/Omit evidence.locator/);
 const explicit=structuredClone(args);explicit.evidence[0].locator='exact-substring';
 assert.equal(JSON.parse(await tool.execute(explicit,{callId:'reg',rootCallId:'reg',agent:{session:{id:'s'}}})).status,'accepted');
 const value=await tool.execute(args,{callId:'reg',rootCallId:'reg',agent:{session:{id:'s'}}});
 assert.equal(JSON.parse(value).status,'accepted');
 events.push({seq:4,type:'tool/result',sourceEventSeqs:[3],data:{turn:1,message:{toolCallId:'reg',content:tool.output.render(args,value)}}});
 events.push({seq:5,type:'assistant/message',data:{turn:1,message:{id:'reply',content:[{type:'text',text:'The design requires explicit evidence.'}]}}});
 const trace=projectRegistrations(normalizeHarnessEvents(events,{sessionId:'s'}),events);
 assert.equal(trace.claims.length,1);assert.equal(trace.evidence.length,1);assert.equal(trace.replies[0].claimIds.length,1);
 const padding=Array.from({length:21000},(_,i)=>({seq:10+i,type:'diagnostic',data:{text:'x'.repeat(500)}}));
 const longCall={seq:22000,type:'tool/call',data:{turn:2,callId:'long-reg',name:'pathway_register_claims',arguments:JSON.stringify({...args,batchId:'long'})}};
 const longEvents=[...events.slice(0,3),...padding,{seq:21999,type:'turn/start',data:{turn:2}},longCall];
 const longTools=new Map();registerEvidenceTools({tools:{register:t=>longTools.set(t.name,t)},sessionQuery:{readSession:async()=>({events:longEvents})}});
 const longValue=await longTools.get('pathway_register_claims').execute({...args,batchId:'long'},{callId:'long-reg',rootCallId:'long-reg',agent:{session:{id:'s'}}});
 assert.equal(JSON.parse(longValue).status,'accepted');
 longEvents.push({seq:22001,type:'tool/result',sourceEventSeqs:[22000],data:{turn:2,message:{toolCallId:'long-reg',content:[{type:'text',text:longValue}]}}},{seq:22002,type:'assistant/message',data:{turn:2,message:{id:'long-reply',content:[{type:'text',text:'Long session evidence'}]}}});
 const longRoutes=new Map();applyHost({tools:{register(){}},connection:{fetch:{register:r=>longRoutes.set(r.path,r)}},sessionQuery:{readSession:async()=>({session:{id:'s'},events:longEvents})}});
 const longResponse=await longRoutes.get('/api/pathway/trace').fetch(new Request('http://localhost/api/pathway/trace?sessionId=s&window=recent'));
 assert.equal(longResponse.status,200);const longTrace=await longResponse.json();
 assert.doesNotThrow(()=>validateTrace(longTrace));
 assert.equal(longTrace.claims.length,1);assert.equal(longTrace.evidence.length,1);
 assert.equal(longTrace.replies.length,1);assert.equal(longTrace.replies[0].claimIds.length,1);
 assert.equal(longTrace.snapshot.evidenceScope,'resolved-closure');assert.ok(longTrace.snapshot.referenceEventCount>0);
 assert.ok(buildReplyPlans(longTrace,{mode:'evidence'})[0].root.children[0].children[0].children.some(n=>n.kind==='tool'));
 const originalOutput=longEvents[2].data.message.content;
 longEvents[2].data.message.content=[{type:'text',text:'x'.repeat(3*1024*1024)}];
 const unavailable=await (await longRoutes.get('/api/pathway/trace').fetch(new Request('http://localhost/api/pathway/trace?sessionId=s&window=recent'))).json();
 assert.equal(unavailable.snapshot.evidenceScope,'EVIDENCE_SCOPE_TOO_LARGE');assert.equal(unavailable.claims.length,0);assert.equal(unavailable.evidence.length,0);
 assert.ok(unavailable.warnings.some(w=>w.includes('历史证据闭包')));
 longEvents[2].data.message.content=originalOutput;
 const routes=new Map();applyHost({tools:{register(){}},connection:{fetch:{register:r=>routes.set(r.path,r)}},sessionQuery:{readSession:async()=>({session:{id:'s'},events}),listSessions:async()=>[]}});
 for (const mode of ['preview','metadata']) {
  const response=await routes.get('/api/pathway/trace').fetch(new Request(`http://localhost/api/pathway/trace?sessionId=s&content=${mode}`));
  assert.equal(response.status,200);const hosted=await response.json();
  assert.equal(hosted.claims.length,1);assert.equal(hosted.evidence.length,1);
  const plan=buildReplyPlans(hosted,{mode:'evidence'})[0];assert.equal(plan.root.children[0].kind,'claim');
  if(mode==='metadata') assert.equal(JSON.stringify(hosted).includes('Evidence is explicit.'),false);
 }
 const rejected=JSON.parse(await tool.execute(args,{callId:'inner',rootCallId:'reg',agent:{session:{id:'s'}}}));
 assert.equal(rejected.error,'NATIVE_CALL_REQUIRED');
 const noIdentity=JSON.parse(await tool.execute(args,{callId:'reg',rootCallId:'reg'}));
 assert.equal(noIdentity.error,'SESSION_CONTEXT_REQUIRED');
});
