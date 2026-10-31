import * as core from './core.js';
import { redact } from './security.js';

// All projections are allowlists, including nested reply projections. Never spread a trace.
const list = value => Array.isArray(value) ? value : [];
const safeIdentifier = value => /^[\w:.-]{1,512}$/.test(value);
function identifiers(trace) {
  // Reserve safe literals up front, including dangling refs. No generated opaque
  // identifier may alias a literal or another original identifier in this export.
  const reserved = new Set(), mapped = new Map();
  const reserve = value => { if (typeof value === 'string' && safeIdentifier(value)) reserved.add(value); };
  reserve(trace.id);
  for (const key of ['nodes', 'sources', 'evidence', 'claims', 'replies']) for (const value of list(trace[key])) {
    for (const field of ['id', 'parentId', 'nodeId', 'sourceId']) reserve(value[field]);
    for (const field of ['sourceIds', 'nodeIds', 'evidenceIds', 'claimIds']) list(value[field]).forEach(reserve);
  }
  let serial = 0;
  return value => {
    if (typeof value !== 'string') return undefined;
    if (safeIdentifier(value)) return value;
    if (!mapped.has(value)) {
      let id;
      do { id = `opaque:${++serial}`; } while (reserved.has(id));
      reserved.add(id); mapped.set(value, id);
    }
    return mapped.get(value);
  };
}
const ids = (value, identifier) => list(value).filter(x => typeof x === 'string').map(identifier);
const enums = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const numeric = ['seq', 'cutSeq', 'callSeq', 'resultSeq', 'turn', 'step', 'eventCount', 'inheritedEventCount'];
function facts(value = {}) {
  const out = {};
  for (const key of numeric) if (Number.isFinite(value[key])) out[key] = value[key];
  for (const key of ['start', 'end', 'time', 'observationTime']) {
    if (value[key] === null) out[key] = null;
    else if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key];
    else if (typeof value[key] === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value[key])) out[key] = value[key];
  }
  for (const key of ['interrupted', 'resultAvailableAtCut', 'inherited', 'truncated']) if (typeof value[key] === 'boolean') out[key] = value[key];
  if (value.resultState) out.resultState = enums(value.resultState, ['returned', 'error', 'missing-start', 'missing-result'], 'missing-result');
  if (value.activityState) out.activityState = enums(value.activityState, ['running', 'stopped', 'unknown'], 'unknown');
  if (value.orderBasis) out.orderBasis = enums(value.orderBasis, ['seq', 'host-seq', 'input-order'], 'input-order');
  return out;
}
function node(value, metadata, identifier, preserveLifecycle = false) {
  const out = { id: identifier(value.id), kind: enums(value.kind, ['tool', 'step'], 'tool'),
    label: metadata ? '工具' : String(value.label ?? '工具'),
    status: enums(value.status, ['success', 'error', 'running', 'unknown'], 'unknown'),
    sourceIds: ids(value.sourceIds, identifier), ...facts(value) };
  // Selected exports flatten already projected nodes into legacy entities.
  // Metadata exports instead preserve lifecycle facts for canonical reply cuts.
  for (const key of ['callSeq', 'resultSeq', 'resultState', 'activityState', 'orderBasis']) delete out[key];
  if (preserveLifecycle && 'resultState' in value) {
    out.callSeq = value.callSeq ?? null;
    out.resultSeq = value.resultSeq ?? null;
    out.resultState = enums(value.resultState, ['returned', 'error', 'missing-start', 'missing-result'], 'missing-result');
    out.activityState = 'unknown';
  }
  if (value.parentId) out.parentId = identifier(value.parentId);
  if (!metadata) for (const key of ['toolName', 'input', 'output', 'error']) if (value[key] !== undefined) out[key] = value[key];
  return out;
}
function reply(value, metadata, identifier, nodeIds = value.nodeIds, claimIds = value.claimIds) {
  const out = { id: identifier(value.id), kind: enums(value.kind, ['assistant', 'pending', 'legacy'], 'legacy'),
    status: enums(value.status, ['recorded', 'pending', 'unassigned'], 'unassigned'), text: metadata ? '回复' : String(value.text ?? ''),
    nodeIds: ids(nodeIds, identifier), claimIds: ids(claimIds, identifier), ...facts(value) };
  // Export projected nodes as canonical entities, not a second independently validated view.
  // Legacy schema-v1 replies remain importable without depending on new core view invariants.
  delete out.cutSeq;
  delete out.orderBasis;
  return out;
}
function base(trace, identifier) {
  const out = { schemaVersion: 1, id: identifier(trace.id), title: '执行链路',
    origin: enums(trace.origin, ['harness', 'import', 'demo'], 'import'),
    nodes: [], sources: [], evidence: [], claims: [], replies: [], warnings: [], observability: [] };
  if (typeof trace.imported === 'boolean') out.imported = trace.imported;
  if (trace.snapshot?.window === 'recent' || trace.snapshot?.truncation?.history === true) {
    out.snapshot = { window: 'recent', coverage: 'partial', truncation: { history: true } };
    for (const key of ['referenceEventCount', 'eventCount', 'omittedEventCount', 'totalEventCount', 'firstSeq', 'lastSeq']) if (Number.isSafeInteger(trace.snapshot[key]) && trace.snapshot[key] >= 0) out.snapshot[key] = trace.snapshot[key];
    if (['resolved-closure','display-only','EVIDENCE_SCOPE_TOO_LARGE','RELIABLE_SEQ_REQUIRED','DUPLICATE_EVENT_SEQ','CONFLICTING_EVENT_SEQ'].includes(trace.snapshot.evidenceScope)) out.snapshot.evidenceScope = trace.snapshot.evidenceScope;
    out.warnings.push('仅导出近期历史窗口及按需引用来源，不代表完整会话');
  }
  // Snapshot content, host errors and arbitrary capability fields are intentionally not copied.
  return out;
}
function source(value, metadata, identifier) {
  return { id: identifier(value.id), nodeId: identifier(value.nodeId),
    kind: enums(value.kind, ['file', 'http', 'other'], 'other'),
    uri: metadata ? enums(value.kind, ['file', 'http', 'other'], 'other') : String(value.uri ?? ''),
    snapshot: metadata ? '' : String(value.snapshot ?? ''), ...facts(value) };
}
function evidence(value, metadata, identifier) {
  const out = { id: identifier(value.id), attribution: enums(value.attribution, ['explicit', 'imported'], 'imported'), verification: 'unverified' };
  for (const key of ['sourceId', 'nodeId']) if (value[key]) out[key] = identifier(value[key]);
  if (!metadata) for (const key of ['locator', 'excerpt']) if (typeof value[key] === 'string') out[key] = value[key];
  return out;
}
function claim(value, metadata, identifier) {
  return { id: identifier(value.id), text: metadata ? '结论' : String(value.text ?? ''), evidenceIds: ids(value.evidenceIds, identifier),
    limitations: metadata ? [] : list(value.limitations).filter(x => typeof x === 'string'), verification: 'unverified' };
}

/** Default structure export. Returns a schema-v1 trace object accepted by exportTrace/importTrace. */
export function metadataTrace(trace) {
  const identifier = identifiers(trace), out = base(trace, identifier);
  out.nodes = list(trace.nodes).map(v => node(v, true, identifier, true));
  out.sources = list(trace.sources).map(v => source(v, true, identifier));
  out.evidence = list(trace.evidence).map(v => evidence(v, true, identifier));
  out.claims = list(trace.claims).map(v => claim(v, true, identifier));
  if (['seq', 'input-order'].includes(trace.orderBasis)) out.orderBasis = trace.orderBasis;
  out.replies = list(trace.replies).map(value => {
    const projected = reply(value, true, identifier);
    if (value.cutSeq != null) {
      projected.cutSeq = value.cutSeq;
      projected.orderBasis = out.orderBasis;
      // Derive canonical cuts from sanitized global nodes, never copy arbitrary
      // nodeViews (which may carry private content or post-cut results).
      projected.nodeViews = projected.nodeIds.map(id => core.getReplyNodeView(out, projected, id));
    }
    return projected;
  });
  out.exportScope = { type: 'metadata', bodyPolicy: 'metadata-only', omitted: ['content', 'resource-locations', 'free-text', 'snapshot'], missing: [] };
  return core.validateTrace(out);
}

/** Explicit selected subgraph only; never falls back to full content on a missing selection. */
export function selectedTrace(trace, { replyId, claimId } = {}) {
  if (!replyId && !claimId) throw new Error('EXPORT_SELECTION_REQUIRED');
  const selectedReply = replyId ? list(trace.replies).find(r => r.id === replyId) : undefined;
  const selectedClaim = claimId ? list(trace.claims).find(c => c.id === claimId) : undefined;
  if ((replyId && !selectedReply) || (claimId && !selectedClaim)) throw new Error('EXPORT_SELECTION_NOT_FOUND');
  if (selectedReply && selectedClaim && !list(selectedReply.claimIds).includes(claimId)) throw new Error('EXPORT_SELECTION_MISMATCH');
  const identifier = identifiers(trace), out = base(trace, identifier), missing = [], sets = Object.fromEntries(['nodes', 'sources', 'evidence', 'claims'].map(k => [k, new Set()]));
  const maps = Object.fromEntries(Object.keys(sets).map(k => [k, new Map(list(trace[k]).map(v => [v.id, v]))]));
  const selectedNodes = new Map();
  const visit = (kind, id) => {
    if (sets[kind].has(id)) return;
    sets[kind].add(id);
    let value = maps[kind].get(id);
    if (kind === 'nodes' && selectedReply) {
      value = core.getReplyNodeView(trace, selectedReply, id);
    }
    if (!value) { missing.push({ kind, id: identifier(id) }); return; }
    if (kind === 'claims') list(value.evidenceIds).forEach(id => visit('evidence', id));
    if (kind === 'evidence') { if (value.nodeId) visit('nodes', value.nodeId); if (value.sourceId) visit('sources', value.sourceId); }
    if (kind === 'nodes') { selectedNodes.set(id, value); list(value.sourceIds).forEach(id => visit('sources', id)); if (value.parentId) visit('nodes', value.parentId); }
    if (kind === 'sources' && value.nodeId) visit('nodes', value.nodeId);
  };
  if (selectedClaim) visit('claims', claimId);
  else if (selectedReply) { list(selectedReply.claimIds).forEach(id => visit('claims', id)); list(selectedReply.nodeIds).forEach(id => visit('nodes', id)); }
  out.nodes = [...selectedNodes.values()].map(v => node(v, false, identifier));
  // A reply projection with no visible sourceIds must never regain a later source snapshot.
  const visibleSource = value => !selectedReply || !value.nodeId || list(selectedNodes.get(value.nodeId)?.sourceIds).includes(value.id);
  out.sources = [...sets.sources].map(id => maps.sources.get(id)).filter(Boolean).filter(value => {
    if (visibleSource(value)) return true;
    missing.push({ kind: 'sources', id: identifier(value.id), reason: 'not-visible-at-cut' }); return false;
  }).map(v => source(v, false, identifier));
  out.evidence = [...sets.evidence].map(id => maps.evidence.get(id)).filter(Boolean).map(v => {
    const unavailable = selectedReply && ((v.sourceId && !out.sources.some(s => s.id === identifier(v.sourceId)))
      || (v.nodeId && (!selectedNodes.has(v.nodeId) || selectedNodes.get(v.nodeId)?.resultAvailableAtCut === false)));
    if (unavailable) missing.push({ kind: 'evidence-content', id: identifier(v.id), reason: 'not-visible-at-cut' });
    return evidence(v, unavailable, identifier);
  });
  out.claims = [...sets.claims].map(id => maps.claims.get(id)).filter(Boolean).map(v => claim(v, false, identifier));
  if (selectedReply) out.replies = [reply(selectedReply, false, identifier, [...selectedNodes.keys()], selectedClaim ? [claimId] : selectedReply.claimIds)];
  out.exportScope = { type: 'selected', bodyPolicy: 'redacted-preview',
    ...(replyId ? { replyId: identifier(replyId) } : {}), ...(claimId ? { claimId: identifier(claimId) } : {}),
    missing, omitted: Object.fromEntries(Object.keys(sets).map(k => [k, Math.max(0, list(trace[k]).length - out[k].length)])),
    limitations: ['selected-subgraph-only', 'heuristic-redaction', 'not-semantic-verification'] };
  return core.validateTrace(redact(out));
}
