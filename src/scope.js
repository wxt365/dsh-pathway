import { getReplyNodeView } from './core.js';

/** Reply-local read model; never treats execution membership as evidence. */
export function replyScope(trace, replyId) {
  const reply = trace.replies?.find(r=>r.id===replyId);
  if (!reply) return {...trace,nodes:[],sources:[],claims:[],evidence:[],replies:[]};
  const claims=trace.claims.filter(c=>(reply.claimIds??[]).includes(c.id));
  const ids=new Set(claims.flatMap(c=>c.evidenceIds));
  const evidence=trace.evidence.filter(e=>ids.has(e.id));
  const nodeIds=new Set(reply.nodeIds);
  for(const e of evidence) {
    if(e.nodeId) nodeIds.add(e.nodeId);
    const source=trace.sources.find(s=>s.id===e.sourceId);
    if(source?.nodeId) nodeIds.add(source.nodeId);
  }
  const nodes=[];
  for(const id of nodeIds) {
    const view=getReplyNodeView(trace,reply,id);
    if(view) {
      nodes.push(view.resultAvailableAtCut===false?{...view,resultSeq:null}:view);
      if(view.parentId) nodeIds.add(view.parentId);
    }
  }
  const sources=trace.sources.filter(s=>nodes.some(n=>n.id===s.nodeId&&n.resultAvailableAtCut!==false&&n.sourceIds.includes(s.id)));
  const safeEvidence=evidence.map(e=>{
    const n=nodes.find(n=>n.id===(e.nodeId??trace.sources.find(s=>s.id===e.sourceId)?.nodeId));
    return (!n||n.resultAvailableAtCut===false||(e.sourceId&&!sources.some(s=>s.id===e.sourceId)))?{...e,excerpt:'',locator:''}:e;
  });
  return {...trace,nodes,sources,claims,evidence:safeEvidence,replies:[reply]};
}
