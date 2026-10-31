import { normalizeHarnessEvents } from './core.js';
import { redact } from './security.js';
import { selectEvidenceScope } from './history-scope.js';
import { listResults, prepareRegistration, projectRegistrations } from './registration.js';

// Persist only through the host's ordinary successful tool result carrier.
export function registerEvidenceTools(ctx) {
  const register = (name, description, parameters, execute) => ctx.tools.register({
    name, description, parameters,
    output: { schema: {type:'string'}, render: (_args,value)=>[{type:'text',text:value}] },
    async execute(args, exec) {
      try {
        const sessionId=exec.agent?.session?.id;
        if (!sessionId) throw Object.assign(new Error(),{code:'SESSION_CONTEXT_REQUIRED'});
        if (exec.callId !== exec.rootCallId) throw Object.assign(new Error(),{code:'NATIVE_CALL_REQUIRED'});
        if (exec.signal?.aborted) throw Object.assign(new Error(),{code:'REQUEST_ABORTED'});
        const snapshot=await ctx.sessionQuery.readSession(sessionId);
        if (exec.signal?.aborted) throw Object.assign(new Error(),{code:'REQUEST_ABORTED'});
        const call=snapshot.events.find(e=>e.type==='tool/call' && e.data?.callId===exec.callId && e.data?.name?.split('.').at(-1)===name);
        if (!call || !Number.isSafeInteger(call.seq) || call.data.turn==null) throw Object.assign(new Error(),{code:'COMMITTED_CALL_REQUIRED'});
        const history = snapshot.events.filter(e=>Number.isSafeInteger(e.seq)&&e.seq<=call.seq);
        const scope = selectEvidenceScope(history, { sessionId, baseEvents:[call], evidence:args.evidence ?? [], target:args.target, batchId:args.batchId, listLimit:name==='pathway_list_results'?100:0 });
        const boundedEvents=redact(scope.events);
        const trace=normalizeHarnessEvents(boundedEvents,{sessionId});
        const value = await execute(trace,redact(args),{callId:exec.callId,turn:call.data.turn,callSeq:call.seq},boundedEvents);
        if (name === 'pathway_list_results') Object.assign(value, { scope:'bounded-recent-results', historyEventCount:history.length, selectedEventCount:boundedEvents.length, truncated:value.truncated || scope.listTruncated, omittedResultCount:scope.listOmittedCount, eligibleResultCount:scope.listTotalCount });
        return JSON.stringify(value);
      } catch (error) {
        const code=/^[A-Z_]+$/.test(error?.code??'')?error.code:'REGISTRATION_FAILED';
        const hints = {
          INVALID_LOCATOR: 'Omit evidence.locator, or use only "exact-substring". File paths and line ranges are not supported locators. Keep an exact excerpt from the recorded result.',
          EVIDENCE_SCOPE_TOO_LARGE: 'The selected results and references exceed the bounded evidence scope (2000 events / 2 MiB). Use fewer sources or read smaller chunks into separate recorded results; shortening only the excerpt does not reduce the scope budget; unrelated session history is not counted.',
          EXCERPT_NOT_FOUND: 'Use an exact excerpt from the saved result or selected source snapshot; do not paraphrase the excerpt.',
        };
        return JSON.stringify({protocol:'pathway.registration',version:1,status:'rejected',error:code,...(hints[code] ? {hint:hints[code]} : {})});
      }
    }
  });
  register('pathway_list_results', 'List recorded completed results in this session before citing evidence. Use nodeId/sourceIds and exact excerpts with pathway_register_claims. Native calls only. Does not read external resources.', {type:'object',properties:{},additionalProperties:false}, trace=>listResults(trace));
  register('pathway_register_claims', 'Explicitly register claims and exact excerpts from recorded results before your next textual reply in this turn. First call pathway_list_results. Registration is persisted in this ordinary tool result; never implies semantic verification. Native calls only. Existing history is not rewritten. Evidence excerpt must exactly match saved content. Omit locator (recommended); if supplied it must be "exact-substring", never a file path or line range.', {
    type:'object', properties:{
      batchId:{type:'string'},
      evidence:{type:'array',items:{type:'object',properties:{id:{type:'string'},nodeId:{type:'string'},sourceId:{type:'string'},excerpt:{type:'string'},locator:{type:'string',enum:['exact-substring'],description:'Optional: omit this field (recommended). The only supported value is exact-substring; file paths and line ranges are not supported.'}},required:['id','nodeId','excerpt'],additionalProperties:false}},
      claims:{type:'array',items:{type:'object',properties:{id:{type:'string'},text:{type:'string'},evidenceIds:{type:'array',items:{type:'string'}},limitations:{type:'array',items:{type:'string'}}},required:['id','text','evidenceIds'],additionalProperties:false}},
      target:{oneOf:[{type:'object',properties:{kind:{type:'string',const:'next-text-message'}},required:['kind'],additionalProperties:false},{type:'object',properties:{kind:{type:'string',const:'reply'},replyId:{type:'string'}},required:['kind','replyId'],additionalProperties:false}]}
    },required:['batchId','evidence','claims','target'],additionalProperties:false
  }, (trace,args,identity,events)=>{
    // Replay validates prior batches; same id with different payload never creates partial edges.
    const projected=projectRegistrations(trace,events);
    const envelope=prepareRegistration(projected,args,identity);
    const previous=projected.registrations?.find(item=>item.batchId===args.batchId);
    if(previous && previous.status==='conflict') throw Object.assign(new Error(),{code:'BATCH_CONFLICT'});
    return envelope;
  });
}
