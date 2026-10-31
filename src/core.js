import { redact, LIMITS, boundedJson } from './security.js';

const STATUSES = new Set(['success', 'error', 'running', 'unknown']);
const RESULT_STATES = new Set(['returned', 'error', 'missing-start', 'missing-result']);
const ORDER_BASES = new Set(['seq', 'input-order']);
const validSeq = value => Number.isSafeInteger(value) && value >= 0;

/** Canonical reply-local node. Never resolve a reply detail directly from global nodes. */
export function getReplyNodeView(trace, reply, nodeId) {
  return replyNodeView(trace, reply, trace.nodes.find(n => n.id === nodeId));
}

function replyNodeView(trace, reply, node) {
  if (!node) return null;
  if (reply.cutSeq == null) return { ...node };
  const available = validSeq(node.resultSeq) && node.resultSeq < reply.cutSeq;
  const started = validSeq(node.callSeq) && node.callSeq < reply.cutSeq;
  if (!started && !available) return null;
  const view = Object.fromEntries(['id', 'kind', 'label', 'toolName', 'start', 'end', 'status', 'input', 'output', 'sourceIds', 'turn', 'step', 'parentId', 'callSeq', 'resultSeq', 'resultState', 'activityState', 'error'].filter(key => key in node).map(key => [key, node[key]]));
  Object.assign(view, { cutSeq: reply.cutSeq, resultAvailableAtCut: available,
    attributionBasis: 'same-turn-before-cut', orderBasis: reply.orderBasis ?? trace.orderBasis });
  if (!started) {
    view.input = null; view.start = null; view.toolName = 'unknown'; view.label = '未记录调用名称';
    view.resultState = 'missing-start';
  }
  if (!available) {
    view.output = null; view.end = null; view.sourceIds = []; view.status = 'unknown';
    view.resultState = 'missing-result'; view.activityState = 'unknown';
    delete view.error;
  }
  return view;
}
/** Stored cut metadata references canonical nodes; payloads are resolved only on demand.
 * Keep explicit null masks for unavailable data, but never copy available payloads
 * into every reply. Older full views remain accepted by validateTrace below.
 */
function compactReplyNodeView(trace, reply, node) {
  const view = replyNodeView(trace, reply, node);
  if (!view) return null;
  for (const key of ['input', 'output', 'error']) if (view[key] != null) delete view[key];
  return { ...view, compact: true };
}
const asText = v => typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2);
const time = v => typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' ? (Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null) : null;
const blocksText = blocks => Array.isArray(blocks) ? blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : asText(blocks);
const nameOf = name => String(name ?? 'unknown').split('.').at(-1);
function lineRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a,b) => a-b), ranges = [];
  for (let i=0; i<sorted.length; i++) {
    const start=sorted[i]; let end=start;
    while (sorted[i+1] === end+1) end=sorted[++i];
    ranges.push(start===end ? `${start}` : `${start}–${end}`);
  }
  return ranges.join('、');
}

/** Validate explicit trace data; dangling references are visible warnings, not invented edges. */
export function validateTrace(input) {
  boundedJson(input);
  if (!input || input.schemaVersion !== 1) throw new Error('仅支持 schemaVersion = 1 的 Pathway trace');
  const trace = redact(input);
  trace.replies ??= [];
  for (const key of ['id', 'title', 'origin']) if (typeof trace[key] !== 'string' || !trace[key]) throw new Error(`缺少 ${key}`);
  if (!['demo', 'import', 'harness'].includes(trace.origin)) throw new Error('origin 无效');
  for (const key of ['nodes', 'sources', 'evidence', 'claims', 'replies', 'warnings', 'observability']) if (!Array.isArray(trace[key])) throw new Error(`${key} 必须是数组`);
  if (trace.nodes.length > LIMITS.nodes) throw new Error('节点超过 5000 上限');
  const ids = {};
  for (const key of ['nodes', 'sources', 'evidence', 'claims', 'replies']) {
    ids[key] = new Set();
    for (const item of trace[key]) {
      if (!item || typeof item.id !== 'string' || !item.id || ids[key].has(item.id)) throw new Error(`${key} 包含缺失或重复 ID`);
      ids[key].add(item.id);
    }
  }
  const warn = message => { if (!trace.warnings.includes(message)) trace.warnings.push(message); };
  if (trace.orderBasis != null && !ORDER_BASES.has(trace.orderBasis)) throw new Error('orderBasis 无效');
  for (const n of trace.nodes) {
    for (const key of ['callSeq', 'resultSeq']) if (n[key] != null && !validSeq(n[key])) throw new Error(`节点 ${n.id} ${key} 无效`);
    if (n.resultState != null && !RESULT_STATES.has(n.resultState)) throw new Error(`节点 ${n.id} resultState 无效`);
    if (n.activityState != null && n.activityState !== 'unknown') throw new Error(`节点 ${n.id} activityState 缺少可信 runtime 依据`);
    if ('callSeq' in n || 'resultSeq' in n || 'resultState' in n || 'activityState' in n) {
      if (!('callSeq' in n) || !('resultSeq' in n) || !RESULT_STATES.has(n.resultState) || n.activityState !== 'unknown') throw new Error(`节点 ${n.id} 新状态字段不完整`);
      if (n.callSeq == null && n.resultSeq == null) throw new Error(`节点 ${n.id} 缺少生命周期 seq`);
      if (n.resultSeq == null && (n.output != null || n.end != null || n.error != null)) throw new Error(`节点 ${n.id} 未返回却包含结果`);
      if (n.resultSeq != null && !['success', 'error'].includes(n.status)) throw new Error(`节点 ${n.id} 返回状态不一致`);
      const expected = n.callSeq == null ? 'missing-start' : n.resultSeq == null ? 'missing-result' : n.status === 'error' ? 'error' : 'returned';
      if (n.resultState !== expected || (n.resultSeq == null && n.status !== 'unknown')) throw new Error(`节点 ${n.id} 结果状态不一致`);
    }
    if (!STATUSES.has(n.status) || !['tool', 'step'].includes(n.kind)) throw new Error(`节点 ${n.id} 类型或状态无效`);
    if (typeof n.label !== 'string' || !Array.isArray(n.sourceIds)) throw new Error(`节点 ${n.id} 格式无效`);
    for (const key of ['start', 'end']) if (n[key] != null && time(n[key]) === null) throw new Error(`节点 ${n.id} 时间无效`);
    if (!n.sourceIds.every(id => typeof id === 'string')) throw new Error(`节点 ${n.id} 来源 ID 必须是文本`);
    if (n.parentId != null && typeof n.parentId !== 'string') throw new Error(`节点 ${n.id} 父节点 ID 无效`);
    for (const id of n.sourceIds) if (!ids.sources.has(id)) warn(`节点 ${n.id} 引用缺失来源 ${id}`);
  }
  for (const s of trace.sources) {
    if (!['file', 'http', 'other'].includes(s.kind) || typeof s.uri !== 'string' || typeof s.snapshot !== 'string') throw new Error(`来源 ${s.id} 格式无效`);
    if (!ids.nodes.has(s.nodeId)) warn(`来源 ${s.id} 缺失工具节点 ${s.nodeId}`);
  }
  for (const e of trace.evidence) {
    for (const key of ['sourceId', 'nodeId', 'locator', 'excerpt']) if (e[key] != null && typeof e[key] !== 'string') throw new Error(`证据 ${e.id} 字段 ${key} 必须是文本`);
    if (!['explicit', 'imported'].includes(e.attribution)) throw new Error(`证据 ${e.id} 归属无效`);
    if (e.sourceId && !ids.sources.has(e.sourceId)) warn(`证据 ${e.id} 引用缺失来源 ${e.sourceId}`);
    if (e.nodeId && !ids.nodes.has(e.nodeId)) warn(`证据 ${e.id} 引用缺失节点 ${e.nodeId}`);
    if (!e.sourceId && !e.nodeId) warn(`证据 ${e.id} 没有可定位来源`);
    // Imported assertions are never upgraded to semantic verification by this viewer.
    e.verification = 'unverified';
  }
  for (const c of trace.claims) {
    if (typeof c.text !== 'string' || !Array.isArray(c.evidenceIds) || !Array.isArray(c.limitations)) throw new Error(`结论 ${c.id} 格式无效`);
    if (![...c.evidenceIds, ...c.limitations].every(x => typeof x === 'string')) throw new Error(`结论 ${c.id} 引用和限制条件必须是文本`);
    c.verification = 'unverified';
    if (!c.evidenceIds.length) warn(`结论 ${c.id} 未记录证据绑定`);
    for (const id of c.evidenceIds) if (!ids.evidence.has(id)) warn(`结论 ${c.id} 引用缺失证据 ${id}`);
  }
  const nodesById = new Map(trace.nodes.map(node => [node.id, node]));
  const hasLifecycle = trace.nodes.some(n => 'resultState' in n);
  for (const r of trace.replies) {
    if (typeof r.text !== 'string' || !Array.isArray(r.nodeIds) || !r.nodeIds.every(id => typeof id === 'string')) throw new Error(`回复 ${r.id} 格式无效`);
    if (!['assistant', 'pending', 'legacy'].includes(r.kind) || !['recorded', 'pending', 'unassigned'].includes(r.status)) throw new Error(`回复 ${r.id} 类型无效`);
    if (r.claimIds != null && (!Array.isArray(r.claimIds) || !r.claimIds.every(id => typeof id === 'string'))) throw new Error(`回复 ${r.id} 结论引用无效`);
    if (r.time != null && time(r.time) === null) throw new Error(`回复 ${r.id} 时间无效`);
    if (r.kind === 'assistant' && (trace.orderBasis != null || hasLifecycle) && r.cutSeq == null) throw new Error(`回复 ${r.id} 缺少 cutSeq`);
    if (r.cutSeq != null || r.nodeViews != null || r.orderBasis != null) {
      if (!validSeq(r.cutSeq) || !ORDER_BASES.has(r.orderBasis) || !Array.isArray(r.nodeViews)) throw new Error(`回复 ${r.id} 截面字段无效`);
      if (r.nodeIds.length !== new Set(r.nodeIds).size || r.nodeViews.length !== r.nodeIds.length) throw new Error(`回复 ${r.id} nodeViews 与引用不一致`);
      for (let i = 0; i < r.nodeIds.length; i++) {
        const view = r.nodeViews[i], node = nodesById.get(r.nodeIds[i]);
        const expected = view?.compact === true ? compactReplyNodeView(trace, r, node) : replyNodeView(trace, r, node);
        if (!view || !expected || !node || node.turn == null || node.turn !== r.turn || r.orderBasis !== trace.orderBasis
          || Object.keys(view).length !== Object.keys(expected).length
          || Object.keys(expected).some(key => JSON.stringify(view[key]) !== JSON.stringify(expected[key]))) throw new Error(`回复 ${r.id} nodeViews 非法或泄漏截面后的结果`);
      }
    }
    for (const id of r.nodeIds) if (!ids.nodes.has(id)) warn(`回复 ${r.id} 引用缺失节点 ${id}`);
    for (const id of r.claimIds ?? []) if (!ids.claims.has(id)) warn(`回复 ${r.id} 引用缺失结论 ${id}`);
  }
  if (![...trace.warnings, ...trace.observability].every(x => typeof x === 'string')) throw new Error('提示信息必须是文本');
  boundedJson(trace);
  return trace;
}

export function importTrace(text) {
  if (new TextEncoder().encode(text).length > LIMITS.bytes) throw new Error('导入文件超过 8 MiB');
  const trace = validateTrace(JSON.parse(text));
  trace.origin = 'import';
  return trace;
}
export function exportTrace(trace) { return JSON.stringify(validateTrace(trace), null, 2); }

/** Parse only known read/web tool facts. Script contents are deliberately not scanned. */
function sourceFor(node, meta) {
  const name = nameOf(node.toolName), args = node.input && typeof node.input === 'object' ? node.input : {};
  const snapshot = asText(node.output ?? ''), returned = node.resultSeq != null;
  let source;
  if (name === 'read' && typeof args.file_path === 'string') {
    const lines = Array.isArray(meta?.lines) ? meta.lines.filter(l => Number.isSafeInteger(l?.number) && typeof l.text === 'string') : [];
    const numbered = lines.length ? lines.map(l => l.number) : [...snapshot.matchAll(/^\s*(\d+): /gm)].map(m => Number(m[1]));
    const offset = Number.isSafeInteger(args.offset) ? args.offset : 1;
    source = {
      kind: 'file', uri: typeof meta?.path === 'string' ? meta.path : args.file_path,
      locator: `请求第 ${offset} 行起，${Number.isSafeInteger(args.limit) ? `最多 ${args.limit} 行` : '使用工具默认行数'}`,
      returnedLocator: numbered.length ? `已记录返回第 ${lineRanges(numbered)} 行（可能有单行截断）` : '返回范围未知',
      observation: returned && node.status === 'success' ? '已记录工具返回；磁盘实际访问范围、文件全文版本、是否进入后续模型请求均未知' : '仅请求声明；不能确认成功读取',
      snapshotKind: 'tool-return-fragment', snapshot
    };
  } else if (['web_fetch', 'http_request'].includes(name) && typeof args.url === 'string') {
    source = {
      kind: 'http', uri: args.url, locator: `${args.method ?? (name === 'web_fetch' ? '工具默认方法' : '方法未知')} ${args.url}`,
      returnedLocator: returned ? '已记录工具返回；原始 HTTP 字段仅在返回中存在时可见' : '暂无返回',
      observation: '工具边界可观测；SDK 内部请求、原始响应与模型上下文可见性未确认', snapshotKind: 'tool-return-not-raw-http', snapshot
    };
  }
  return source ? { id: `source:${node.id}`, nodeId: node.id, ...source, truncated: /truncat|截断|Showing lines|Pathway 截断/i.test(snapshot) } : null;
}

/** Project committed Harness events without synchronous Session log readers. */
export function normalizeHarnessEvents(events, { sessionId = 'unknown', title = '会话执行链路', origin = 'harness', truncatedHistory = false } = {}) {
  if (!Array.isArray(events) || events.length > LIMITS.events) throw new Error('事件数组无效或超过 20000 条');
  boundedJson(events);
  const safe = redact(events), nodes = new Map(), meta = new Map(), warnings = [], seen = new Map(), replies = [], eventOrder = new Map(), resultOrder = new Map(), turns = new Map();
  const orderBasis = safe.every(event => event && validSeq(event.seq)) ? 'seq' : 'input-order';
  if (orderBasis === 'input-order') warnings.push('缺少可靠 seq；顺序依据为 input-order，不代表宿主提交顺序');
  // Do not mix host seq and array offsets into a purported commit order.
  const ordered = safe.map((event, i) => ({ event, i })).filter(({event}) => event && typeof event === 'object');
  if (orderBasis === 'seq') ordered.sort((a,b) => a.event.seq - b.event.seq);
  let turn = null, step = null;
  for (const { event, i } of ordered) {
    const position = orderBasis === 'seq' ? event.seq : i;
    if (!event || typeof event.type !== 'string') continue;
    if (validSeq(event.seq)) {
      const fingerprint = JSON.stringify(events[i]);
      if (seen.has(event.seq)) {
        if (seen.get(event.seq) !== fingerprint) warnings.push(`seq ${event.seq} 内容冲突：保留首次记录，后续冲突事件未采用`);
        continue;
      }
      seen.set(event.seq, fingerprint);
    }
    const d = event.data ?? {};
    if (event.type === 'turn/start') { turn = d.turn ?? null; step = null; }
    if (event.type === 'step/start') step = d.step ?? null;
    if (event.type === 'turn/end') turns.set(d.turn ?? turn, d.reason?.kind ?? 'unknown');
    if (event.type === 'assistant/message') {
      const message = d.message ?? {}, text = blocksText(message.content ?? []);
      if (text.trim()) replies.push({ id: `${sessionId}:reply:${message.id ?? position}`, kind: 'assistant', status: 'recorded', text, turn: d.turn ?? turn, step: d.step ?? step, time: time(event.time), seq: position, nodeIds: [], claimIds: [], interrupted: d.interrupted === true });
    }
    const ptc = event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch';
    const start = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start';
    const finish = event.type === 'tool/result' || event.type === 'tool/ptc-dispatch';
    if (!start && !finish) continue;
    const message = d.message ?? {};
    const callId = ptc ? d.subCallId : d.callId ?? message.toolCallId ?? message.source?.callId;
    if (typeof callId !== 'string' || !callId) { warnings.push('存在缺失 callId 的工具事件，无法配对'); continue; }
    const id = `${sessionId}:${callId}`;
    let node = nodes.get(id);
    if (!node) {
      node = { id, kind: 'tool', label: d.name ?? '未记录调用名称', toolName: d.name ?? 'unknown', start: null, end: null, status: 'unknown', input: null, output: null, sourceIds: [], turn: d.turn ?? turn, step: d.step ?? step };
      nodes.set(id, node);
    }
    if (ptc && d.parentCallId) node.parentId = `${sessionId}:${d.parentCallId}`;
    if (start) {
      node.start = time(event.time);
      eventOrder.set(id, position); node.callSeq = position;
      node.turn = d.turn ?? node.turn ?? turn; node.step = d.step ?? node.step ?? step;
      node.toolName = d.name ?? 'unknown'; node.label = node.toolName;
      if (typeof d.arguments === 'string') { try { node.input = JSON.parse(d.arguments); } catch { node.input = d.arguments; warnings.push(`${id} 参数不是有效 JSON，按文本展示`); } }
      else node.input = d.arguments ?? null;
      if (node.output === null) node.status = 'unknown';
    }
    if (finish) {
      node.end = time(event.time);
      resultOrder.set(id, position); node.resultSeq = position;
      node.status = (ptc ? d.isError : message.isError) === true ? 'error' : 'success';
      node.output = blocksText(ptc ? d.content : message.content);
      if (d.error) node.error = d.error;
      if (d.meta) meta.set(id, d.meta);
    }
  }
  // PTC records do not carry turn/step: resolve their explicit parent before
  // reply grouping, rather than trusting whichever turn was current on arrival.
  for (const node of nodes.values()) if (node.parentId) {
    const seenParents = new Set([node.id]); let parent = nodes.get(node.parentId);
    while (parent && !seenParents.has(parent.id)) {
      seenParents.add(parent.id);
      if (parent.turn != null) { node.turn = parent.turn; node.step = parent.step; break; }
      parent = nodes.get(parent.parentId);
    }
  }
  const sources = [];
  for (const node of nodes.values()) {
    node.callSeq ??= null; node.resultSeq ??= null;
    node.resultState = node.callSeq === null ? 'missing-start' : node.resultSeq === null ? 'missing-result' : node.status === 'error' ? 'error' : 'returned';
    node.activityState = 'unknown';
    if (node.callSeq === null) warnings.push(`${node.id} 缺失调用开始，历史可能不完整`);
    if (node.resultSeq === null) warnings.push(`${node.id} 未记录返回：运行活性未知，不能确定仍在运行`);
    if (node.start && node.end && new Date(node.end) < new Date(node.start)) warnings.push(`${node.id} 时间顺序异常，不能可靠计算耗时`);
    const source = sourceFor(node, meta.get(node.id));
    if (source) { sources.push(source); node.sourceIds.push(source.id); }
  }
  const assigned = new Set(), nodesByTurn = new Map();
  for (const node of nodes.values()) {
    if (!nodesByTurn.has(node.turn)) nodesByTurn.set(node.turn, []);
    nodesByTurn.get(node.turn).push(node);
  }
  for (const reply of replies) {
    reply.turnEndReason = turns.get(reply.turn) ?? null;
    reply.cutSeq = reply.seq; reply.orderBasis = orderBasis;
    reply.nodeIds = (nodesByTurn.get(reply.turn) ?? []).filter(node => node.turn != null
      && (eventOrder.get(node.id) ?? resultOrder.get(node.id) ?? Infinity) < reply.cutSeq).map(node => node.id);
    reply.nodeViews = reply.nodeIds.map(id => compactReplyNodeView({ orderBasis }, reply, nodes.get(id)));
    reply.nodeIds.forEach(id => assigned.add(id));
  }
  const remaining = new Map();
  for (const node of nodes.values()) if (!assigned.has(node.id)) {
    const key = node.turn ?? 'unassigned';
    if (!remaining.has(key)) remaining.set(key, []);
    remaining.get(key).push(node.id);
  }
  for (const [key, nodeIds] of remaining) replies.push({ id: `${sessionId}:pending:${key}`, kind: key === 'unassigned' ? 'legacy' : 'pending', status: key === 'unassigned' ? 'unassigned' : 'pending', text: key === 'unassigned' ? '未归属执行：缺少轮次信息，不猜测对应回复' : `Turn ${key} · 尚无对应正文回复的执行`, turn: key === 'unassigned' ? null : key, step: null, time: null, nodeIds, claimIds: [] });
  if (truncatedHistory) warnings.push('历史窗口不完整，不能视为整个执行链路');
  return validateTrace({ schemaVersion: 1, id: sessionId, title, origin, orderBasis,
    observability: ['展示原始日志的已提交工具和正文回复，不等于 surface replacement 后的当前模型可见对话', '不还原模型私有思维；虚线执行归属不证明内容被用于结论', '未观测脚本内部 I/O；未自动跨子 Agent 会话汇总', '工具返回不等于已进入后续模型请求；结论绑定需显式导入', '快照为脱敏工具返回，不是原文件全文版本或原始 HTTP 响应'],
    nodes: [...nodes.values()], sources, evidence: [], claims: [], replies, warnings });
}
