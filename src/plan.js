import { getReplyNodeView } from './core.js';

/** Presentation trees: execution membership is NOT a claim of data dependency. */
export function buildReplyPlans(trace, { mode = 'execution' } = {}) {
  const nodes = new Map(trace.nodes.map(n => [n.id, n]));
  const sources = new Map(trace.sources.map(s => [s.id, s]));
  const claims = new Map(trace.claims.map(c => [c.id, c]));
  const evidence = new Map(trace.evidence.map(e => [e.id, e]));
  const replies = [...(trace.replies ?? [])];
  if (!replies.length) replies.push({ id: `${trace.id}:legacy`, kind: 'legacy', status: 'unassigned', text: '旧版未绑定执行记录 · 未记录回复正文', turn: null, step: null, time: null, nodeIds: trace.nodes.map(n => n.id), claimIds: trace.claims.map(c => c.id) });
  else {
    const included = new Set(replies.flatMap(r => r.nodeIds));
    const unassigned = trace.nodes.filter(n => !included.has(n.id) && !(trace.referenceNodeIds ?? []).includes(n.id));
    if (unassigned.length) replies.push({ id: `${trace.id}:unassigned`, kind: 'legacy', status: 'unassigned', text: '未归属执行 · 不猜测对应回复', nodeIds: unassigned.map(n => n.id), claimIds: [] });
  }
  return replies.map((reply, index) => {
    let count = 0;
    const evidenceNumbers = new Map();
    for (const cid of reply.claimIds ?? []) for (const eid of claims.get(cid)?.evidenceIds ?? []) {
      if (!evidenceNumbers.has(eid)) evidenceNumbers.set(eid, evidenceNumbers.size + 1);
    }
    const missing = (id, label, subtitle = '记录缺失，不补造依据') => ({ id, kind: 'missing', label, subtitle, edge: 'unassigned', children: [] });
    const sourceTree = (s, prefix) => ({ id: `${prefix}:source:${s.id}`, kind: 'source', refId: s.id, label: s.kind === 'file' ? '文件片段' : s.kind === 'http' ? 'API / 网页返回' : '来源快照', subtitle: `${s.uri}\n${s.returnedLocator ?? ''}`, edge: 'observed', children: [] });
    const visibleNode = id => getReplyNodeView(trace, reply, id);
    const sourceVisible = s => {
      const node = visibleNode(s.nodeId);
      return reply.cutSeq == null || (node?.resultAvailableAtCut === true && node.callSeq != null && node.callSeq < reply.cutSeq && node.sourceIds.includes(s.id));
    };
    const relatedSources = node => node ? trace.sources.filter(s => sourceVisible(s) && (s.nodeId === node.id || node.sourceIds.includes(s.id))) : [];
    const toolTree = (id, prefix, edge, childrenByParent = new Map(), visited = new Set()) => {
      if (++count > 1500 || visited.size >= 40) return missing(`${prefix}:limit`, '分支已限制', '显示上限 1500 个节点 / 40 层，请缩小记录范围');
      if (visited.has(id)) return missing(`${prefix}:cycle:${id}`, '执行父级循环', '无效 parentId；已停止递归');
      const n = visibleNode(id);
      if (!n) return missing(`${prefix}:missing:${id}`, `缺失工具 ${id}`, '记录缺失或在回复截面后，不展示未来执行');
      const next = new Set(visited); next.add(id);
      return { id: `${prefix}:tool:${id}`, kind: n.kind, refId: id, label: n.label || n.toolName || id, subtitle: n.resultAvailableAtCut === false ? '当时已开始、当时无返回 · 活性未知' : n.toolName || `Step ${n.step ?? '未知'}`, status: n.status, resultState: n.resultState, activityState: n.activityState, nodeView: n, edge,
        children: [...relatedSources(n).map(s => sourceTree(s, `${prefix}:${id}`)), ...(childrenByParent.get(id) ?? []).map(child => toolTree(child, `${prefix}:${id}`, 'execution', childrenByParent, next))] };
    };
    const root = { id: `plan:${reply.id}`, kind: 'reply', refId: reply.id, label: reply.kind === 'assistant' ? `${trace.snapshot?.window === 'recent' || trace.snapshot?.truncation?.history ? '近期回复' : '回复'} ${index + 1}` : reply.status === 'pending' ? '待回复执行' : '未绑定执行记录', subtitle: reply.text, status: reply.status, edge: 'execution', children: [] };
    if (mode === 'evidence') {
      root.children = (reply.claimIds ?? []).map(id => {
        const c = claims.get(id);
        if (!c) return missing(`${root.id}:missing:${id}`, `缺失结论 ${id}`);
        return { id: `${root.id}:claim:${id}`, kind: 'claim', refId: id, label: c.text, subtitle: '显式结论声明 · 未语义核验', edge: 'evidence', children: c.evidenceIds.length ? c.evidenceIds.map(eid => {
          const e = evidence.get(eid);
          if (!e) return missing(`${root.id}:${id}:missing:${eid}`, `缺失证据 ${eid}`);
          const s = sources.get(e.sourceId), nid = e.nodeId ?? s?.nodeId;
          if (reply.cutSeq != null && ((nid && visibleNode(nid)?.resultAvailableAtCut !== true) || (s && !sourceVisible(s)))) return missing(`${root.id}:${id}:${eid}:future`, '证据在此截面不可用', '不展示后续返回、来源或摘录');
          const children = nid ? [toolTree(nid, `${root.id}:${id}:${eid}`, 'evidence')] : s ? [sourceTree(s, `${root.id}:${id}:${eid}`)] : [missing(`${root.id}:${id}:${eid}:unknown`, '无法定位证据来源')];
          if (e.sourceId && !s) children.push(missing(`${root.id}:${id}:${eid}:source-missing`, `缺失来源 ${e.sourceId}`));
          // A cited source need not be owned by nodeId; keep the explicit source visible too.
          if (s && nid && !relatedSources(nodes.get(nid) ?? { id: '', sourceIds: [] }).some(v => v.id === s.id)) children.push(sourceTree(s, `${root.id}:${id}:${eid}:explicit`));
          return { id: `${root.id}:${id}:evidence:${eid}`, kind: 'evidence', refId: eid, label: `证据 ${evidenceNumbers.get(eid)}`, subtitle: e.excerpt || (e.locator === 'exact-substring' ? '精确摘录匹配' : e.locator) || '摘录未记录', edge: 'evidence', children };
        }) : [missing(`${root.id}:${id}:no-evidence`, '未登记证据引用')] };
      });
      if (!root.children.length) root.children = [missing(`${root.id}:no-binding`, trace.capabilities?.evidenceRegistration === 'not-implemented' ? '证据登记尚未接入' : '未记录这条回复的显式证据绑定', trace.capabilities?.evidenceRegistration === 'not-implemented' ? '文件来源已采集不等于结论引用已登记；并非读取失败' : '执行记录不自动转成结论依据；请补充 reply.claimIds 和 claim.evidenceIds')];
    } else {
      const owned = new Set(reply.nodeIds), childrenByParent = new Map(), roots = [];
      for (const id of owned) {
        const n = nodes.get(id);
        if (n?.parentId && owned.has(n.parentId) && n.parentId !== id) {
          if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
          childrenByParent.get(n.parentId).push(id);
        } else roots.push(id);
      }
      // Cycles have no normal roots: include one explicit root for every unreachable component.
      const reachable = new Set();
      const mark = id => { const stack = [id]; while (stack.length) { const current = stack.pop(); if (reachable.has(current)) continue; reachable.add(current); for (const child of childrenByParent.get(current) ?? []) stack.push(child); } };
      roots.forEach(mark);
      for (const id of owned) if (!reachable.has(id)) { roots.push(id); mark(id); }
      const steps = new Map();
      for (const id of roots) {
        const node = nodes.get(id), key = node?.step ?? 'unknown';
        if (!steps.has(key)) steps.set(key, []);
        steps.get(key).push(toolTree(id, `${root.id}:step:${key}`, 'execution', childrenByParent));
      }
      root.children = [...steps].map(([key, children]) => ({ id: `${root.id}:step:${key}`, kind: 'step', label: key === 'unknown' ? '步骤未记录' : `Step ${key}`, subtitle: '同轮此前记录的执行 · 非证据依赖', edge: 'execution', children }));
      if (!root.children.length) root.children = [missing(`${root.id}:no-tools`, '这条回复之前未记录工具执行', '可能是直接回复，也可能历史不完整；不自动引入其他轮次记录')];
    }
    return { id: reply.id, label: root.label, reply, root };
  });
}
