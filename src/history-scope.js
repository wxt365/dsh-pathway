// Pure history closure: inspect metadata across the history, but serialize only
// selected events. In particular, unrelated tool outputs never enter the budget.
const validSeq = value => Number.isSafeInteger(value) && value >= 0;
const nameOf = value => typeof value === 'string' ? value.split('.').at(-1) : '';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const bytes = value => new TextEncoder().encode(value).length;
const ARG_BYTES = 64_000;
const toolKind = type => type === 'tool/call' || type === 'tool/result' || type === 'tool/ptc-dispatch-start' || type === 'tool/ptc-dispatch';
const finish = type => type === 'tool/result' || type === 'tool/ptc-dispatch';
function callId(event) {
  const d = event.data ?? {};
  return event.type.startsWith('tool/ptc-') ? d.subCallId : d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId;
}
function hasText(event) {
  const content = event.data?.message?.content;
  return Array.isArray(content) && content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text.trim());
}
function registrationArgs(event) {
  const args = event.data?.arguments;
  try {
    const serialized = typeof args === 'string' ? args : JSON.stringify(args);
    // Length first avoids encoding arbitrarily large strings.
    if (typeof serialized !== 'string' || serialized.length > ARG_BYTES || bytes(serialized) > ARG_BYTES) return null;
    const value = typeof args === 'string' ? JSON.parse(args) : args;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * Select a bounded evidence closure over already-read committed session events.
 * No reads, redaction, normalization, or invented references happen here.
 * The caller is responsible for applying its invocation seq cut before calling.
 * Output retains input order (seq is used only for reliable identities/binding).
 */
export function selectEvidenceScope(events, {
  sessionId, baseEvents = [], evidence = [], target = null, batchId = null, listLimit = 0,
  maxEvents = 2000, maxBytes = 2 * 1024 * 1024,
} = {}) {
  if (!Array.isArray(events) || !Array.isArray(baseEvents) || typeof sessionId !== 'string' || !sessionId
    || !Number.isSafeInteger(maxEvents) || maxEvents < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0
    || !Number.isSafeInteger(listLimit) || listLimit < 0) fail('INVALID_EVIDENCE_SCOPE');
  const bySeq = new Map(), tools = new Map(), replies = new Map(), texts = new Map(), boundaries = new Map(), registrations = [];
  const turns = new Map();
  // Sorting metadata, not copying or serializing payloads, also supports callers
  // whose event array is not in commit order.
  for (const event of events) {
    if (!validSeq(event?.seq)) fail('RELIABLE_SEQ_REQUIRED');
    if (bySeq.has(event.seq)) {
      const previous = bySeq.get(event.seq);
      fail(previous === event || JSON.stringify(previous) === JSON.stringify(event) ? 'DUPLICATE_EVENT_SEQ' : 'CONFLICTING_EVENT_SEQ');
    }
    bySeq.set(event.seq, event);
  }
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let currentTurn = null;
  for (const event of ordered) {
    const d = event.data ?? {};
    if (event.type === 'turn/start') currentTurn = d.turn ?? null;
    const turn = d.turn ?? currentTurn;
    turns.set(event.seq, turn);
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      if (!boundaries.has(turn)) boundaries.set(turn, []);
      boundaries.get(turn).push(event);
    }
    if (toolKind(event.type)) {
      const id = callId(event);
      if (typeof id === 'string' && id) {
        const nodeId = `${sessionId}:${id}`;
        if (!tools.has(nodeId)) tools.set(nodeId, []);
        tools.get(nodeId).push(event);
      }
      if (event.type === 'tool/call' && nameOf(d.name) === 'pathway_register_claims') registrations.push(event);
    }
    if (event.type === 'assistant/message' && hasText(event)) {
      replies.set(`${sessionId}:reply:${d.message.id ?? event.seq}`, event);
      if (!texts.has(turn)) texts.set(turn, []);
      texts.get(turn).push(event);
    }
  }
  const selected = new Set(), base = new Set(), queue = [], relevantTurns = new Set(), relevantReplies = new Set();
  const sizes = new Map();
  let totalBytes = 2;
  if (totalBytes > maxBytes) fail('EVIDENCE_SCOPE_TOO_LARGE');
  const add = event => {
    if (!event || selected.has(event.seq)) return;
    if (!sizes.has(event.seq)) {
      let serialized;
      try { serialized = JSON.stringify(event); } catch { fail('EVIDENCE_SCOPE_TOO_LARGE'); }
      if (typeof serialized !== 'string' || serialized.length > maxBytes) fail('EVIDENCE_SCOPE_TOO_LARGE');
      sizes.set(event.seq, bytes(serialized));
    }
    const nextBytes = totalBytes + sizes.get(event.seq) + (selected.size ? 1 : 0);
    if (selected.size + 1 > maxEvents || nextBytes > maxBytes) fail('EVIDENCE_SCOPE_TOO_LARGE');
    totalBytes = nextBytes;
    selected.add(event.seq); queue.push(event);
  };
  const addNode = nodeId => { for (const event of tools.get(nodeId) ?? []) add(event); };
  const addTarget = value => {
    if (value?.kind !== 'reply' || typeof value.replyId !== 'string') return;
    relevantReplies.add(value.replyId);
    const reply = replies.get(value.replyId);
    if (reply) { add(reply); relevantTurns.add(turns.get(reply.seq)); }
  };
  for (const event of baseEvents) {
    if (!validSeq(event?.seq)) fail('RELIABLE_SEQ_REQUIRED');
    const original = bySeq.get(event.seq);
    if (!original) fail('BASE_EVENT_UNAVAILABLE');
    if (original !== event && JSON.stringify(original) !== JSON.stringify(event)) fail('CONFLICTING_EVENT_SEQ');
    base.add(event.seq); add(original); relevantTurns.add(turns.get(event.seq));
    if (event.type === 'assistant/message') relevantReplies.add(`${sessionId}:reply:${event.data?.message?.id ?? event.seq}`);
  }
  if (Array.isArray(evidence)) for (const item of evidence) addNode(item?.nodeId);
  addTarget(target);
  // Registration args are bounded before parsing; malformed/missing references
  // remain malformed/missing for the existing registration validator to reject.
  const args = new Map(registrations.map(event => [event.seq, registrationArgs(event)]));
  const relevantBatches = new Set(typeof batchId === 'string' ? [batchId] : []);
  let cursor = 0;
  const close = () => {
    let previousTurns = -1, previousReplies = -1, previousBatches = -1;
    while (cursor < queue.length || previousTurns !== relevantTurns.size || previousReplies !== relevantReplies.size || previousBatches !== relevantBatches.size) {
      if (previousTurns !== relevantTurns.size || previousReplies !== relevantReplies.size || previousBatches !== relevantBatches.size) {
        previousTurns = relevantTurns.size; previousReplies = relevantReplies.size; previousBatches = relevantBatches.size;
        for (const call of registrations) {
          const value = args.get(call.seq);
          if ((turns.get(call.seq) != null && relevantTurns.has(turns.get(call.seq)))
            || (typeof value?.batchId === 'string' && relevantBatches.has(value.batchId))
            || (value?.target?.kind === 'reply' && relevantReplies.has(value.target.replyId))) add(call);
        }
      }
      while (cursor < queue.length) {
        const event = queue[cursor++], d = event.data ?? {};
        for (const boundary of boundaries.get(turns.get(event.seq)) ?? []) add(boundary);
        if (!toolKind(event.type)) continue;
        const id = callId(event);
        if (typeof id === 'string') addNode(`${sessionId}:${id}`);
        if (typeof d.parentCallId === 'string') addNode(`${sessionId}:${d.parentCallId}`);
        if (event.type !== 'tool/call' || nameOf(d.name) !== 'pathway_register_claims') continue;
        const value = args.get(event.seq);
        // Batch deduplication is global in replay. A selected retry must retain
        // the original acceptance/binding, even when no batchId was supplied by
        // the caller and that original lives in an otherwise unrelated turn.
        if (typeof value?.batchId === 'string') relevantBatches.add(value.batchId);
        if (Array.isArray(value?.evidence)) for (const item of value.evidence) addNode(item?.nodeId);
        addTarget(value?.target);
        for (const result of tools.get(`${sessionId}:${id}`) ?? []) {
          if (result.type !== 'tool/result') continue;
          // Include the FIRST actual text, even when outside base, so replay can
          // never accidentally bind a later base reply instead.
          const next = (texts.get(turns.get(event.seq)) ?? []).find(reply => reply.seq > result.seq);
          add(next);
        }
      }
    }
  };
  // Required base/ref closure is never partially retained or silently omitted.
  close();
  const completed = [];
  if (listLimit) {
    for (const [nodeId, records] of tools) {
      const call = records.find(event => event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start');
      const result = records.filter(event => finish(event.type)).at(-1);
      if (!call || !result || call.seq >= result.seq || ['pathway_register_claims', 'pathway_list_results'].includes(nameOf(call.data?.name))) continue;
      if ((result.type === 'tool/result' ? result.data?.message?.isError : result.data?.isError) === true) continue;
      completed.push({ nodeId, seq: result.seq });
    }
    completed.sort((a, b) => b.seq - a.seq);
  }
  let listSelectedCount = 0;
  for (const item of completed) {
    if (listSelectedCount >= listLimit) break;
    // Each optional candidate is transactional, including parent pairs, turn
    // boundaries and registration closure. A failed fit cannot leave fragments.
    const saved = [selected, relevantTurns, relevantReplies, relevantBatches].map(set => new Set(set));
    const length = queue.length, savedBytes = totalBytes, savedCursor = cursor;
    try {
      addNode(item.nodeId);
      close();
      listSelectedCount++;
    } catch (error) {
      if (error.code !== 'EVIDENCE_SCOPE_TOO_LARGE') throw error;
      [selected, relevantTurns, relevantReplies, relevantBatches].forEach((set, i) => {
        set.clear(); for (const value of saved[i]) set.add(value);
      });
      queue.length = length; totalBytes = savedBytes; cursor = savedCursor;
    }
  }
  const output = events.filter(event => selected.has(event.seq));
  const listOmittedCount = completed.length - listSelectedCount;
  return { events: output, addedEventCount: selected.size - base.size,
    // Counts concern eligible successful completed candidates, not raw events.
    // Omitted includes both limit and byte/event-fit exclusions.
    listTruncated: listOmittedCount > 0, listOmittedCount, listSelectedCount, listTotalCount: completed.length };
}
