import { normalizeHarnessEvents } from './core.js';
import { redact, LIMITS } from './security.js';
import { metadataTrace } from './transfer.js';
import { randomUUID } from 'node:crypto';
import { selectEvidenceScope } from './history-scope.js';
import { projectRegistrations } from './registration.js';
import { registerEvidenceTools } from './registration-tools.js';

/** Host-only Cordis entry. Connection owns authentication and route disposal. */
export const name = 'pathway';
export const inject = ['connection', 'sessionQuery', 'tools'];

// Bounds apply after the backend's complete read; they do not make cold reads streaming.
const MAX_EVENTS = 20_000;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(redact(value)), {
    status,
    headers: { ...headers, ...extra },
  });
}

function onlyGet(request) {
  return request.method === 'GET'
    ? undefined
    : json({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET' });
}

const RECENT_EVENTS = 1000;
const RECENT_BYTES = 512 * 1024;
function recentWindow(events) {
  let start = events.length, bytes = 2;
  while (start > 0 && events.length - start < RECENT_EVENTS) {
    const size = Buffer.byteLength(JSON.stringify(events[start - 1]), 'utf8') + 1;
    if (bytes + size > RECENT_BYTES) break;
    bytes += size; start--;
  }
  // Prefer a whole turn within the bounded tail, never silently skip a huge event.
  const boundary = events.findIndex((event, index) => index >= start && event?.type === 'turn/start');
  if (boundary >= start && boundary !== -1) start = boundary;
  return { events: events.slice(start), omitted: start };
}

function hasLongField(value) {
  if (typeof value === 'string') return value.length > LIMITS.text;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasLongField);
}

/** Register two read-only exact routes under the authenticated /api carrier. */
export function apply(ctx) {
  registerEvidenceTools(ctx);
  ctx.connection.fetch.register({
    path: '/api/pathway/sessions',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const refusal = onlyGet(request);
      if (refusal) return refusal;
      if (request.signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 408);
      try {
        // Official logical corpus includes cold persisted sessions; no per-item history reads.
        const records = await ctx.sessionQuery.listSessions(request.signal);
        if (request.signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 408);
        const sessions = records.slice(0, 1000).map(({ header, live, persisted, formatStatus }) => ({
          id: metadataTrace({ id: header.id }).id,
          ...(Number.isFinite(header.createdAt) ? { createdAt: header.createdAt } : {}),
          live: live === true, persisted: persisted === true,
          ...(header.origin === 'subagent' ? { origin: 'subagent',
            ...(typeof header.parentSession === 'string' ? { parentSessionId: metadataTrace({ id: header.parentSession }).id } : {}) } : {}),
          ...(formatStatus === undefined ? {} : { formatStatus: ['current', 'migration-required', 'legacy', 'unsupported'].includes(formatStatus) ? formatStatus : 'unknown' }),
        }));
        return json({ sessions, scope: 'live+persisted', truncated: records.length > 1000 });
      } catch {
        return json({ error: 'SESSION_LIST_FAILED' }, 500);
      }
    },
  });

  ctx.connection.fetch.register({
    path: '/api/pathway/trace',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const refusal = onlyGet(request);
      if (refusal) return refusal;
      const params = new URL(request.url).searchParams;
      const ids = params.getAll('sessionId');
      const content = params.getAll('content');
      const windows = params.getAll('window');
      if (windows.length > 1 || (windows.length && !['full', 'recent'].includes(windows[0]))) return json({ error: 'INVALID_WINDOW' }, 400);
      if (content.length > 1 || (content.length === 1 && !['metadata', 'preview'].includes(content[0]))) {
        return json({ error: 'INVALID_CONTENT_MODE' }, 400);
      }
      if (ids.length !== 1 || !ids[0].trim() || ids[0].length > 512) {
        return json({ error: 'INVALID_SESSION_ID' }, 400);
      }
      if (request.signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 408);
      try {
        // Includes persisted-but-unloaded history without making that Session live.
        const snapshot = await ctx.sessionQuery.readSession(ids[0]);
        if (request.signal.aborted) return json({ error: 'REQUEST_ABORTED' }, 408);
        const recent = windows[0] === 'recent';
        const selected = recent ? recentWindow(snapshot.events) : { events: snapshot.events, omitted: 0 };
        if (recent && snapshot.events.length && !selected.events.length) return json({ error: 'RECENT_EVENT_TOO_LARGE', reason: 'single-event-bytes', limits: { recentBytes: RECENT_BYTES } }, 413);
        if (selected.events.length > MAX_EVENTS) return json({ error: 'HISTORY_TOO_LARGE', reason: 'event-count', actual: { eventCount: selected.events.length }, limits: { eventCount: MAX_EVENTS, historyBytes: MAX_HISTORY_BYTES } }, 413);
        if (Buffer.byteLength(JSON.stringify(selected.events), 'utf8') > MAX_HISTORY_BYTES) return json({ error: 'HISTORY_TOO_LARGE', reason: 'history-bytes', limits: { eventCount: MAX_EVENTS, historyBytes: MAX_HISTORY_BYTES } }, 413);
        let scoped = { events:selected.events, addedEventCount:0 }, evidenceScope = 'display-only';
        if (recent) {
          try {
            scoped = selectEvidenceScope(snapshot.events, { sessionId:ids[0], baseEvents:selected.events });
            evidenceScope = 'resolved-closure';
          } catch (cause) {
            evidenceScope = cause?.code ?? 'unavailable';
          }
        }
        const safeEvents = redact(scoped.events);
        const normalized = normalizeHarnessEvents(safeEvents, {
          sessionId: ids[0],
          title: snapshot.session.id,
          origin: 'harness',
          truncatedHistory: selected.omitted > 0,
        });
        const trace = !recent || evidenceScope === 'resolved-closure' ? projectRegistrations(normalized, safeEvents) : normalized;
        if (recent) {
          const displaySeqs = new Set(selected.events.map(e=>e.seq));
          trace.replies = trace.replies.filter(r=>displaySeqs.has(r.cutSeq ?? r.seq));
          // Historical tools remain reachable through evidence, not execution membership.
          const displayNodeIds = new Set(normalizeHarnessEvents(redact(selected.events),{sessionId:ids[0]}).nodes.map(n=>n.id));
          trace.referenceNodeIds = trace.nodes.filter(n=>!displayNodeIds.has(n.id)).map(n=>n.id);
          for (const reply of trace.replies) {
            reply.nodeIds = reply.nodeIds.filter(id=>displayNodeIds.has(id));
            if (Array.isArray(reply.nodeViews)) reply.nodeViews = reply.nodeViews.filter(view=>displayNodeIds.has(view.id));
          }
          if (evidenceScope !== 'resolved-closure') trace.warnings.push(`历史证据闭包未完整加载：${evidenceScope}；不代表会话未登记证据。`);
        }
        const seqs = selected.events.map(e => e?.seq).filter(Number.isSafeInteger);
        const fieldTruncated = hasLongField(selected.events);
        trace.snapshot = {
          snapshotId: randomUUID(), capturedAt: new Date().toISOString(), sessionId: ids[0], hostVersion: 'unknown',
          ...(seqs.length ? { firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) } : {}),
          evidenceScope, referenceEventCount:scoped.addedEventCount,
          eventCount: selected.events.length, window: recent ? 'recent' : 'full', omittedEventCount: selected.omitted, totalEventCount: snapshot.events.length,
          ...(Number.isSafeInteger(snapshot.inheritedEventCount) ? { inheritedEventCount: snapshot.inheritedEventCount } : {}),
          ...(snapshot.session.origin === 'subagent' && typeof snapshot.session.parentSession === 'string'
            ? { parentSessionId: metadataTrace({ id: snapshot.session.parentSession }).id } : {}),
          historyMode: 'raw-committed', consistency: 'unknown', coverage: fieldTruncated || selected.omitted > 0 ? 'partial' : 'read-complete',
          bodyPolicy: content[0] === 'metadata' ? 'metadata-only' : 'redacted-preview',
          truncation: { history: selected.omitted > 0, node: false, field: fieldTruncated },
          limitations: ['backend-provided-range-only', 'not-current-model-context', 'no-persistence-checkpoint', 'post-read-limits-do-not-bound-backend-memory', 'heuristic-redaction'],
        };
        trace.capabilities = { historyMode: 'raw-committed', refresh: 'manual', contentModes: ['metadata', 'preview'],
          liveAndPersisted: true, atomicSnapshot: false, persistenceCheckpoint: false, childMapping: 'session-header-only', evidenceRegistration: 'native-tool-result-v1' };
        if (content[0] === 'metadata') {
          const safe = metadataTrace(trace);
          // These are freshly constructed Host facts, not arbitrary trace metadata.
          safe.snapshot = { ...trace.snapshot, sessionId: safe.id };
          safe.capabilities = trace.capabilities;
          return json(safe);
        }
        return json(trace);
      } catch (error) {
        const code = error?.code;
        if (request.signal.aborted || code === 'SESSION_QUERY_ABORTED') return json({ error: 'REQUEST_ABORTED' }, 408);
        if (['SESSION_QUERY_FORBIDDEN', 'FORBIDDEN', 'EACCES'].includes(code)) return json({ error: 'SESSION_FORBIDDEN' }, 403);
        if (/超过|超限/.test(error?.message ?? '')) return json({ error: 'TRACE_TOO_LARGE', reason: 'normalized-trace', limits: { eventCount: MAX_EVENTS, historyBytes: MAX_HISTORY_BYTES } }, 413);
        if (code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          return json({ error: 'SESSION_NOT_FOUND' }, 404);
        }
        // Never return backend messages, stacks, raw events, or credential-bearing paths.
        return json({ error: 'SESSION_READ_FAILED' }, 500);
      }
    },
  });
}
