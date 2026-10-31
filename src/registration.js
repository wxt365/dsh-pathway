import { normalizeHarnessEvents } from './core.js';

/** Pure S2 protocol. Storage is the ordinary successful native tool result. */
export const REGISTRATION_PROTOCOL = 'pathway.registration';
export const REGISTRATION_LIMITS = Object.freeze({ count: 50, id: 512, text: 16_000, bytes: 64_000, results: 100, summary: 500 });
const seq = n => Number.isSafeInteger(n) && n >= 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function text(x, max = REGISTRATION_LIMITS.text) { if (typeof x !== 'string' || !x.trim() || x.length > max) fail('INVALID_TEXT'); return x; }
const id = x => text(x, REGISTRATION_LIMITS.id);
function array(x, nonempty = true) { if (!Array.isArray(x) || x.length > REGISTRATION_LIMITS.count || (nonempty && !x.length)) fail('INVALID_COUNT'); return x; }
function unique(items) { if (new Set(items).size !== items.length) fail('DUPLICATE_ID'); }
const outputText = x => typeof x === 'string' ? x : JSON.stringify(x ?? null, null, 2);
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`; return JSON.stringify(value); }
function payload(envelope) { const { batchId, evidence, claims, target } = envelope; return { batchId, evidence, claims, target }; }

/** Validate all references at the invocation cut; never create partial acceptance. */
export function prepareRegistration(trace, args, { callId, turn, callSeq } = {}) {
  if (!object(args) || !seq(callSeq) || !seq(turn)) fail('INVALID_REGISTRATION_CONTEXT');
  id(callId); id(trace.id);
  if (new TextEncoder().encode(JSON.stringify(args)).length > REGISTRATION_LIMITS.bytes) fail('REGISTRATION_TOO_LARGE');
  const batchId = id(args.batchId);
  const evidence = array(args.evidence).map(e => {
    if (!object(e)) fail('INVALID_EVIDENCE');
    const entry = { id: id(e.id), nodeId: id(e.nodeId), excerpt: text(e.excerpt) };
    const node = trace.nodes.find(n => n.id === entry.nodeId);
    if (!node || node.status !== 'success' || !seq(node.resultSeq) || node.resultSeq >= callSeq) fail('RESULT_UNAVAILABLE');
    let snapshot = outputText(node.output);
    if (e.sourceId !== undefined) {
      entry.sourceId = id(e.sourceId);
      const source = trace.sources.find(s => s.id === entry.sourceId && s.nodeId === node.id);
      if (!source || !node.sourceIds.includes(source.id)) fail('SOURCE_UNAVAILABLE');
      snapshot = source.snapshot;
    }
    if (typeof snapshot !== 'string' || !snapshot.includes(entry.excerpt)) fail('EXCERPT_NOT_FOUND');
    // Locator is an explicit exact quote, not an unchecked claim about file lines.
    if (e.locator !== undefined && e.locator !== 'exact-substring') fail('INVALID_LOCATOR');
    entry.locator = 'exact-substring';
    return entry;
  });
  unique(evidence.map(e => e.id));
  const evidenceIds = new Set(evidence.map(e => e.id));
  const claims = array(args.claims).map(c => {
    if (!object(c)) fail('INVALID_CLAIM');
    const claim = { id: id(c.id), text: text(c.text), evidenceIds: array(c.evidenceIds).map(id), limitations: array(c.limitations ?? [], false).map(x => text(x)) };
    unique(claim.evidenceIds);
    if (claim.evidenceIds.some(ref => !evidenceIds.has(ref))) fail('EVIDENCE_UNAVAILABLE');
    return claim;
  });
  unique(claims.map(c => c.id));
  if (!object(args.target)) fail('INVALID_TARGET');
  let target;
  if (args.target.kind === 'next-text-message') target = { kind: 'next-text-message' };
  else if (args.target.kind === 'reply') {
    target = { kind: 'reply', replyId: id(args.target.replyId) };
    const reply = trace.replies.find(r => r.id === target.replyId && r.kind === 'assistant');
    if (!reply || !seq(reply.cutSeq) || reply.cutSeq >= callSeq) fail('REPLY_UNAVAILABLE');
    if (evidence.some(e => trace.nodes.find(n => n.id === e.nodeId).resultSeq >= reply.cutSeq)) fail('RESULT_AFTER_REPLY');
  } else fail('INVALID_TARGET');
  const envelope = { protocol: REGISTRATION_PROTOCOL, version: 1, status: 'accepted', sessionId: trace.id, callId, turn, callSeq, batchId, evidence, claims, target,
    validation: { schema: 'valid', references: 'resolved', locators: 'resolved', semanticSupport: 'unverified' } };
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > REGISTRATION_LIMITS.bytes) fail('REGISTRATION_TOO_LARGE');
  const prior = trace.registrations?.find(r => r.batchId === batchId);
  if (prior && stable(payload(prior)) !== stable(payload(envelope))) fail('BATCH_CONFLICT');
  return envelope;
}

/** Caller supplies an already authorized, bounded snapshot. */
export function listResults(trace) {
  const nodes = trace.nodes.filter(n => n.status === 'success' && seq(n.resultSeq) && n.toolName !== 'pathway_register_claims' && n.toolName !== 'pathway_list_results').sort((a, b) => a.resultSeq - b.resultSeq);
  return { sessionId: trace.id, results: nodes.slice(-REGISTRATION_LIMITS.results).map(n => ({ nodeId: n.id, resultSeq: n.resultSeq, turn: n.turn, toolName: n.toolName,
    summary: outputText(n.output).slice(0, REGISTRATION_LIMITS.summary), sourceIds: [...n.sourceIds] })), truncated: nodes.length > REGISTRATION_LIMITS.results };
}

/** Rebuild only from validated successful native tool results, without writes. */
export function projectRegistrations(trace, events) {
  const result = structuredClone(trace);
  result.registrations = [];
  const warn = code => { const value = `Pathway registration: ${code}`; if (!result.warnings.includes(value)) result.warnings.push(value); };
  if (trace.orderBasis !== 'seq') { warn('RELIABLE_SEQ_REQUIRED'); return result; }
  const calls = new Map(), batches = new Map(), seenSeq = new Set();
  const ordered = events.filter(e => seq(e?.seq)).slice().sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (seenSeq.has(event.seq)) { warn('DUPLICATE_EVENT_SEQ'); continue; }
    seenSeq.add(event.seq);
    const d = event.data ?? {};
    if (event.type === 'tool/call') {
      if (calls.has(d.callId)) { calls.set(d.callId, null); warn('DUPLICATE_CALL_ID'); }
      else calls.set(d.callId, event);
      continue;
    }
    if (event.type !== 'tool/result' || d.message?.isError === true) continue;
    const callId = d.message?.toolCallId;
    const call = calls.get(callId);
    if (!call || call.data.name !== 'pathway_register_claims') continue;
    try {
      if (d.turn !== call.data.turn || call.seq >= event.seq || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== call.seq) fail('INVALID_CALL_PAIR');
      const blocks = d.message.content;
      if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0].type !== 'text' || typeof blocks[0].text !== 'string' || blocks[0].text.length > REGISTRATION_LIMITS.bytes) fail('INVALID_ENVELOPE');
      const envelope = JSON.parse(blocks[0].text);
      const args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments;
      // Validation belongs to the original invocation cut, not a later surface
      // replacement's overwritten normalized node/resultSeq.
      const invocationTrace = normalizeHarnessEvents(ordered.filter(e => e.seq <= call.seq), { sessionId: trace.id, title: trace.title, origin: trace.origin });
      const expected = prepareRegistration(invocationTrace, args, { callId, turn: call.data.turn, callSeq: call.seq });
      if (stable(expected) !== stable(envelope)) fail('ENVELOPE_MISMATCH');
      const fingerprint = stable(payload(envelope));
      if (batches.has(envelope.batchId)) {
        if (batches.get(envelope.batchId) !== fingerprint) warn('BATCH_CONFLICT');
        continue;
      }
      batches.set(envelope.batchId, fingerprint);
      const target = envelope.target;
      const reply = target.kind === 'reply' ? result.replies.find(r => r.id === target.replyId && r.kind === 'assistant')
        : result.replies.filter(r => r.kind === 'assistant' && r.turn === envelope.turn && r.cutSeq > event.seq && r.text.trim()).sort((a, b) => a.cutSeq - b.cutSeq)[0];
      const closed = ordered.some(e => e.type === 'turn/end' && e.data?.turn === envelope.turn && e.seq > event.seq);
      const registration = { ...envelope, resultSeq: event.seq, registeredAt: event.time ?? null, status: reply ? 'bound' : closed ? 'unbound' : 'pending' };
      const sourceChanged = envelope.evidence.some(e => {
        const before = invocationTrace.nodes.find(n => n.id === e.nodeId);
        const now = trace.nodes.find(n => n.id === e.nodeId);
        if (!before || !now || before.resultSeq !== now.resultSeq || before.status !== now.status || outputText(before.output) !== outputText(now.output)) return true;
        if (!e.sourceId) return false;
        const oldSource = invocationTrace.sources.find(s => s.id === e.sourceId);
        const newSource = trace.sources.find(s => s.id === e.sourceId);
        return !oldSource || !newSource || oldSource.nodeId !== newSource.nodeId || oldSource.snapshot !== newSource.snapshot;
      });
      if (sourceChanged) {
        registration.status = 'source-unavailable';
        registration.validation = { ...registration.validation, references: 'unavailable', locators: 'unavailable' };
        warn('SOURCE_SNAPSHOT_CHANGED');
        result.registrations.push(registration);
        continue;
      }
      if (reply) {
        registration.replyId = reply.id;
        const namespace = (kind, value) => `registration:${encodeURIComponent(envelope.batchId)}:${kind}:${encodeURIComponent(value)}`;
        const evIds = new Map(envelope.evidence.map(e => [e.id, namespace('evidence', e.id)]));
        const newEvidence = envelope.evidence.map(e => ({ ...e, id: evIds.get(e.id), attribution: 'explicit', verification: 'unverified', semanticSupport: 'unverified', registrationBatchId: envelope.batchId }));
        const newClaims = envelope.claims.map(c => ({ ...c, id: namespace('claim', c.id), evidenceIds: c.evidenceIds.map(x => evIds.get(x)), verification: 'unverified', registrationBatchId: envelope.batchId }));
        if (newEvidence.some(e => result.evidence.some(old => old.id === e.id)) || newClaims.some(c => result.claims.some(old => old.id === c.id))) fail('PROJECTION_ID_CONFLICT');
        result.evidence.push(...newEvidence); result.claims.push(...newClaims);
        reply.claimIds = [...(reply.claimIds ?? []), ...newClaims.map(c => c.id)];
      }
      result.registrations.push(registration);
    } catch (error) { warn(error.code ?? 'INVALID_ENVELOPE'); }
  }
  return result;
}
