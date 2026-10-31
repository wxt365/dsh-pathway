import { validateTrace, importTrace, exportTrace, getReplyNodeView } from './core.js';
import { createDemoTrace } from './demo.js';
import { replyScope } from './scope.js';
import { buildReplyPlans } from './plan.js';
import { operatorIcon } from './icons.js';
import { metadataTrace, selectedTrace } from './transfer.js';

let viewerSequence = 0;

const STATUS = { success: '已返回', error: '失败', running: '进行中', unknown: '状态未知' };
const TABS = [['plan', '按回复查看'], ['timeline', '时间线'], ['sources', '来源快照'], ['claims', '结论与证据']];
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(text, className, action) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function badge(text, style = '') { return el('span', `pw-badge ${style}`, text); }
function format(value) {
  if (value === null || value === undefined) return '未记录';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
function time(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '未知';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}
function duration(node) {
  if (!node.start || !node.end) return '耗时未知';
  const ms = Date.parse(node.end) - Date.parse(node.start);
  if (!Number.isFinite(ms) || ms < 0) return '耗时未知';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function field(label, value, mono = false) {
  const row = el('div', 'pw-field');
  row.append(el('dt', '', label), el('dd', mono ? 'pw-mono' : '', value || '未记录'));
  return row;
}
function section(title, content) {
  const block = el('section', 'pw-section');
  block.append(el('h3', '', title));
  if (typeof content === 'string') block.append(el('p', 'pw-muted', content));
  else if (content) block.append(content);
  return block;
}
function codeBlock(value) { return el('pre', 'pw-code', format(value)); }
function safeLink(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const link = el('a', 'pw-link', '打开外部来源 ↗');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    return link;
  } catch { return null; }
}

/** Mounts the native-DOM viewer. CSS is loaded separately by the host/page. */
export function mountViewer(container, { trace: initialTrace, loadSessions, loadTrace, sessionId: initialSessionId = '', replyId: initialReplyId = '', embedded = false } = {}) {
  if (!container || typeof container.append !== 'function') throw new TypeError('需要有效的挂载容器');
  let disposed = false;
  let revision = 0;
  let trace = null;
  let activeTab = 'plan';
  let scopeMode = 'reply';
  const scopeData = () => scopeMode === 'reply' && trace ? replyScope(trace, selectedReply) : trace;
  let selectedNode = null;
  let selectedSource = null;
  let selectedClaim = null;
  let planMode = 'execution';
  let selectedReply = null;
  let selectedPlanNode = null;
  let planZoom = 1;
  let replyExpanded = false;
  let planViewportState = null;
  let planTraceRevision = 0;
  const collapsedBranches = new Set();
  const viewerId = `pw-graph-${++viewerSequence}`;
  let query = '';
  let status = 'all';
  let busy = false;
  let error = '';
  let recoverableError = null;
  let traceWindow = 'full';
  let sessions = [];
  let currentSession = initialSessionId;
  let preferredReply = initialReplyId;
  let selectionNotice = '';
  const urls = new Set();
  const hostMode = typeof loadSessions === 'function' || typeof loadTrace === 'function';
  const root = el('div', `pw-viewer${embedded ? ' pw-embedded' : ''}`);
  const header = el('header', 'pw-header');
  const identity = el('div', 'pw-identity');
  const logo = el('span', 'pw-logo');
  const logoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  logoSvg.setAttribute('viewBox', '0 0 48 48'); logoSvg.setAttribute('aria-hidden', 'true');
  const logoGradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  const gradientId = `${viewerId}-logo`; logoGradient.setAttribute('id', gradientId); logoGradient.setAttribute('x1', '0'); logoGradient.setAttribute('y1', '0'); logoGradient.setAttribute('x2', '0'); logoGradient.setAttribute('y2', '1');
  for (const [offset, color] of [['0', '#42dfcf'], ['.52', '#508ef3'], ['1', '#6771ea']]) { const stop = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); stop.setAttribute('offset', offset); stop.setAttribute('stop-color', color); logoGradient.append(stop); }
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); defs.append(logoGradient); logoSvg.append(defs);
  for (const [tag, attrs] of [['path', { d:'M14 31h6a4 4 0 0 0 4-4v-3a4 4 0 0 1 4-4h5M24 27a4 4 0 0 0 4 4h5', fill:'none', stroke:`url(#${gradientId})`, 'stroke-width':'6', 'stroke-linecap':'round' }], ['circle',{cx:'14',cy:'12',r:'4.5'}], ['circle',{cx:'34',cy:'16',r:'5.5'}], ['rect',{x:'8',y:'26',width:'12',height:'12',rx:'5'}], ['rect',{x:'28',y:'26',width:'12',height:'12',rx:'5'}]]) { const shape = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key,value] of Object.entries(attrs)) shape.setAttribute(key,value); if (tag !== 'path') shape.setAttribute('fill', `url(#${gradientId})`); logoSvg.append(shape); }
  logo.append(logoSvg);
  const brand = el('div');
  brand.append(el('div', 'pw-brand', 'PATHWAY'), el('div', 'pw-brand-sub', '执行可见 · 证据可查'));
  identity.append(logo, brand);
  const actions = el('div', 'pw-actions');
  const sessionSelect = el('select', 'pw-select pw-session-select');
  sessionSelect.setAttribute('aria-label', '选择宿主会话');
  sessionSelect.addEventListener('change', () => { void fetchTrace(sessionSelect.value); });
  const refresh = button('↻ 刷新会话', 'pw-button pw-button-dark', () => { void fetchSessions(true); });
  const input = el('input', 'pw-file-input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.setAttribute('aria-label', '导入 Pathway trace JSON');
  const importButton = button('↑ 导入 JSON', 'pw-button pw-button-dark', () => input.click());
  const exportButton = button('↓ 导出结构', 'pw-button pw-button-primary', () => download(metadataTrace(scopeMode === 'reply' && trace.replies?.some(r=>r.id===selectedReply) ? selectedTrace(trace,{replyId:selectedReply}) : trace), 'structure'));
  const contentExport = button('导出选中内容…', 'pw-button pw-button-dark pw-export-selected', confirmExport);
  const exportDialog = el('dialog', 'pw-export-dialog');
  exportDialog.setAttribute('aria-label', '确认导出选中内容');
  let pendingExport = null;
  const exportSummary = el('p');
  const dialogActions = el('div', 'pw-actions');
  dialogActions.append(button('取消', 'pw-button pw-button-dark', () => { pendingExport = null; exportDialog.close(); }), button('确认导出', 'pw-button pw-button-primary', () => {
    if (pendingExport) download(pendingExport, 'selected');
    pendingExport = null; exportDialog.close();
  }));
  exportDialog.append(el('h2', '', '导出选中的脱敏内容'), exportSummary, el('p', 'pw-muted', '包含正文、参数或返回片段。启发式脱敏可能遗漏业务敏感信息，分享前请人工审阅。'), dialogActions);
  exportDialog.addEventListener('cancel', () => { pendingExport = null; });
  actions.append(sessionSelect, refresh, importButton, exportButton, contentExport, input);
  header.append(identity, actions);
  const main = el('main', 'pw-main');
  const notice = el('div');
  notice.setAttribute('aria-live', 'polite');
  const intro = el('div', 'pw-intro');
  const heading = el('div');
  heading.append(el('div', 'pw-eyebrow', 'AGENT EXECUTION EXPLORER'));
  const title = el('h1', '', '执行链路与证据溯源');
  const subtitle = el('p', 'pw-subtitle', '从工具返回到结论引用，让每一步依据都可检查。');
  heading.append(title, subtitle);
  const originBadge = badge('等待数据', 'pw-origin');
  intro.append(heading, originBadge);
  const statistics = el('div', 'pw-stats');
  const boundary = el('details', 'pw-boundary');
  const recordInfo = el('details', 'pw-record-info');
  recordInfo.append(el('summary', '', '记录信息'));
  const snapshotInfo = el('div', 'pw-record-snapshot');
  const recordBody = el('div', 'pw-record-body');
  recordBody.append(snapshotInfo, boundary);
  recordInfo.append(recordBody);
  const scopeBar = el('div', 'pw-reply-bar pw-scope-bar');
  const scopeSelect = el('select','pw-select pw-scope-select');
  scopeSelect.setAttribute('aria-label','查看范围');
  for(const [value,label] of [['reply','当前回复'],['snapshot','当前快照／近期窗口']]) {
    const option=el('option','',label); option.value=value; scopeSelect.append(option);
  }
  const globalReplySelect=el('select','pw-select pw-reply-select');
  globalReplySelect.setAttribute('aria-label','选择回复');
  globalReplySelect.addEventListener('change',()=>{
    selectedReply=globalReplySelect.value; if(!trace.replies?.some(r=>r.id===selectedReply)) scopeMode='snapshot'; selectedNode=null; selectedSource=null; selectedClaim=null; selectedPlanNode=null;
    collapsedBranches.clear(); replyExpanded=false; render();
  });
  scopeSelect.addEventListener('change',()=>{scopeMode=scopeSelect.value; selectedNode=null;selectedSource=null;selectedClaim=null;selectedPlanNode=null;render();});
  scopeBar.append(el('span','pw-muted','查看范围'),scopeSelect,globalReplySelect);
  const tabs = el('div', 'pw-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '执行记录视图');
  const tabButtons = new Map();
  for (const [id, label] of TABS) {
    const item = button(label, 'pw-tab', () => { activeTab = id; renderContent(); });
    item.id = `pw-tab-${id}`;
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-controls', `pw-panel-${id}`);
    tabButtons.set(id, item);
    tabs.append(item);
  }
  const toolbar = el('div', 'pw-toolbar');
  const searchWrap = el('label', 'pw-search-wrap');
  searchWrap.append(el('span', 'pw-search-icon', '⌕'));
  const search = el('input', 'pw-search');
  search.type = 'search';
  search.placeholder = '搜索工具、路径、返回内容或结论…';
  search.setAttribute('aria-label', '搜索执行记录');
  search.addEventListener('input', () => { query = search.value.trim().toLocaleLowerCase(); renderContent(); });
  searchWrap.append(search);
  const statusSelect = el('select', 'pw-select pw-filter');
  statusSelect.setAttribute('aria-label', '按工具状态筛选');
  for (const [value, label] of [['all', '全部状态'], ...Object.entries(STATUS)]) {
    const option = el('option', '', label); option.value = value; statusSelect.append(option);
  }
  statusSelect.addEventListener('change', () => { status = statusSelect.value; renderContent(); });
  const resultCount = el('span', 'pw-result-count');
  toolbar.append(searchWrap, statusSelect, resultCount);
  const workspace = el('div', 'pw-workspace');
  const list = el('section', 'pw-list-panel');
  list.setAttribute('role', 'tabpanel');
  const detail = el('aside', 'pw-detail');
  detail.setAttribute('aria-label', '所选记录详情');
  const drawer = el('dialog', 'pw-detail-drawer');
  drawer.setAttribute('aria-label', '节点详情抽屉');
  const drawerHeader = el('div', 'pw-drawer-header');
  const drawerClose = button('关闭 ×', 'pw-button pw-button-dark', closeDrawer);
  drawerClose.setAttribute('aria-label', '关闭节点详情');
  drawerHeader.append(el('strong', '', '节点详情'), drawerClose);
  drawer.append(drawerHeader);
  let drawerTrigger = null;
  function openDrawer() {
    if (activeTab !== 'plan') return;
    drawerTrigger = selectedPlanNode;
    if (!drawer.open) drawer.show();
    drawerClose.focus({preventScroll:true});
  }
  function closeDrawer() {
    if (drawer.open) drawer.close();
    const card = [...list.querySelectorAll('.pw-plan-card')].find(item => item.dataset.planNodeId === drawerTrigger);
    card?.querySelector('.pw-plan-node-select')?.focus({preventScroll:true});
  }
  drawer.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); } });
  workspace.append(list, detail);
  const footer = el('footer', 'pw-footer', '只展示已记录事实和显式引用 · 不推断私有思维 · 引用存在 ≠ 证据充分 ≠ 结论正确');
  if (embedded) actions.prepend(recordInfo);
  main.append(notice, intro, statistics, ...(embedded ? [] : [recordInfo]), scopeBar, tabs, toolbar, workspace, footer);
  root.append(header, main, exportDialog, drawer);
  container.append(root);

  function setTrace(value) {
    // validateTrace also redacts imported/supplied snapshots before any rendering.
    const checked = validateTrace(value);
    pendingExport = null;
    if (drawer.open) drawer.close();
    if (exportDialog.open) exportDialog.close();
    trace = checked;
    selectedNode = trace.nodes.find(n => n.kind === 'tool')?.id || trace.nodes[0]?.id || null;
    selectedSource = trace.sources[0]?.id || null;
    selectedClaim = null;
    if (!trace.replies?.length) scopeMode = 'snapshot';
    const wantedReply = preferredReply || selectedReply;
    preferredReply = '';
    selectedReply = trace.replies?.some(reply => reply.id === wantedReply) ? wantedReply : [...(trace.replies ?? [])].reverse().find(r=>r.kind==='assistant')?.id ?? trace.replies?.at(-1)?.id ?? null;
    selectionNotice = wantedReply && !selectedReply ? '指定回复在本快照中不存在；已回到最新正文。' : '';
    selectedPlanNode = null;
    collapsedBranches.clear(); planZoom = 1; replyExpanded = false;
    planViewportState = null; planTraceRevision++;
    query = ''; search.value = ''; status = 'all'; statusSelect.value = 'all';
    error = ''; recoverableError = null;
  }
  function errorText(value) { return value instanceof Error ? value.message : String(value); }
  function render() {
    if (disposed) return;
    notice.replaceChildren();
    if (busy) {
      const message = el('div', 'pw-banner pw-banner-info', '正在读取宿主记录… 仅通过宿主提供的加载通道访问。');
      message.setAttribute('role', 'status'); notice.append(message);
    }
    if (error) {
      const message = el('div', 'pw-banner pw-banner-error', error);
      message.setAttribute('role', 'alert');
      if (recoverableError?.status === 413 && traceWindow !== 'recent' && currentSession && typeof loadTrace === 'function') {
        const recover = button('加载近期记录（非完整历史）', 'pw-button pw-button-dark pw-load-recent', () => { void fetchTrace(currentSession, { window: 'recent' }); });
        recover.disabled = busy;
        message.append(recover);
      }
      notice.append(message);
    }
    if (trace?.snapshot?.truncation?.history || trace?.snapshot?.window === 'recent') {
      const omitted = trace.snapshot.omittedEventCount;
      const count = Number.isSafeInteger(omitted) && omitted >= 0 ? `已省略 ${omitted} 条较早事件。` : '省略的较早事件数量未知。';
      const warning = el('div', 'pw-banner pw-banner-error pw-history-window', `近期记录 · 非完整历史。${count}执行过程仅代表近期窗口；证据按引用补取历史来源，不能视为完整会话记录。`);
      warning.setAttribute('role', 'status'); notice.append(warning);
    }
    if (trace?.origin === 'demo') notice.append(el('div', 'pw-banner pw-banner-demo', '示例数据 · 合成演示，非实时会话。没有实际读取文件或调用外部 API。'));
    title.textContent = trace?.title || '执行链路与证据溯源';
    originBadge.textContent = trace ? ({ demo: 'DEMO / 示例', import: 'IMPORT / 导入', harness: 'HOST / 宿主记录' }[trace.origin] || `来源：${trace.origin}`) : '等待数据';
    subtitle.textContent = trace ? `Trace ${trace.id} · 工具返回、来源定位与显式证据关系` : '导入已有 trace，或从宿主会话列表加载。';
    exportButton.disabled = !trace || busy;
    contentExport.disabled = !trace || busy;
    if (selectionNotice) notice.append(el('div', 'pw-banner pw-banner-info', selectionNotice));
    snapshotInfo.replaceChildren();
    if (trace?.snapshot) {
      const s = trace.snapshot;
      snapshotInfo.append(el('div', 'pw-snapshot', `手动快照 · ${s.capturedAt || '时间未知'} · seq ${s.firstSeq ?? '—'}–${s.lastSeq ?? '—'} · ${s.eventCount ?? '—'} 条事件 · ${s.coverage || 'unknown'} · 原始提交历史，非当前模型上下文`));
    }
    recordInfo.hidden = !trace;
    sessionSelect.hidden = !hostMode || embedded;
    refresh.hidden = typeof loadSessions !== 'function';
    sessionSelect.disabled = busy || !sessions.length || typeof loadTrace !== 'function';
    refresh.disabled = busy;
    statistics.replaceChildren();
    if (trace) statistics.append(el('div', 'pw-stat-scope', scopeMode === 'reply' ? '当前回复统计 · 含执行记录及显式引用来源' : trace.snapshot?.truncation?.history || trace.snapshot?.window === 'recent' ? '当前窗口及引用补取统计 · 非完整会话' : '当前快照统计 · 非单条回复'));
    const scopedTrace = scopeData();
    const choices = buildReplyPlans(trace ?? {id:'empty',nodes:[],sources:[],claims:[],evidence:[],replies:[]});
    globalReplySelect.replaceChildren();
    for(const item of choices) { const option=el('option','',`${item.label}${item.reply.turn!=null?` · Turn ${item.reply.turn} · Step ${item.reply.step??'—'}`:''}`);option.value=item.id;globalReplySelect.append(option); }
    globalReplySelect.value=selectedReply??''; scopeSelect.value=scopeMode; scopeBar.hidden=!trace;
    scopeSelect.options[0].disabled=!trace?.replies?.some(r=>r.id===selectedReply);
    const tools = scopedTrace?.nodes.filter(n => n.kind === 'tool') || [];
    const missing = scopedTrace?.claims.filter(c => !c.evidenceIds.length || c.evidenceIds.some(id => !scopedTrace.evidence.some(e => e.id === id))).length || 0;
    const evidenceUnavailable = trace?.capabilities?.evidenceRegistration === 'not-implemented';
    const metrics = [
      ['工具调用', tools.length, `${tools.filter(n => n.status === 'success').length} 已返回 · ${tools.filter(n => n.status === 'error').length} 失败`, 'blue'],
      ['来源快照', scopedTrace?.sources.length || 0, '保留当时工具返回，不重读外部资源', 'green'],
      ['显式证据', evidenceUnavailable ? '未接入' : scopedTrace?.evidence.length || 0, '结构化引用 · 均未语义核验', 'blue'],
      ['结论声明', evidenceUnavailable ? '未接入' : scopedTrace?.claims.length || 0, `${missing} 条缺少完整证据引用`, missing ? 'amber' : 'green']
    ];
    for (const [label, value, hint, color] of metrics) {
      const card = el('div', `pw-stat pw-stat-${color}`);
      card.append(el('div', 'pw-stat-label', label), el('div', 'pw-stat-value', trace ? value : '未加载'), el('div', 'pw-stat-hint', trace ? hint : '尚未加载有效记录，数量未知'));
      statistics.append(card);
    }
    boundary.replaceChildren();
    boundary.hidden = !trace;
    if (trace) {
      boundary.append(el('summary', '', `可观测边界与完整性提示 · ${trace.warnings.length} 条警告`));
      const items = el('ul');
      for (const text of [...trace.observability, ...trace.warnings]) items.append(el('li', '', text));
      if (!items.childElementCount) items.append(el('li', '', '未提供额外的可观测范围说明；不应视为完整执行记录。'));
      boundary.append(items);
    }
    renderContent();
  }
  function path() {
    const reply = activeTab === 'plan' || scopeMode === 'reply' ? trace?.replies?.find(item => item.id === selectedReply) : null;
    const claim = activeTab === 'plan' && !reply?.claimIds?.includes(selectedClaim) ? null : trace?.claims.find(c => c.id === selectedClaim);
    const evidence = trace?.evidence.filter(e => claim?.evidenceIds.includes(e.id)) || [];
    const sources = new Set(evidence.map(e => e.sourceId).filter(Boolean));
    const nodes = new Set(evidence.map(e => e.nodeId).filter(Boolean));
    trace?.sources.filter(s => sources.has(s.id)).forEach(s => nodes.add(s.nodeId));
    return { claim, evidence, sources, nodes };
  }
  function matches(value) { return !query || format(value).toLocaleLowerCase().includes(query); }
  function nodeMatches(node) {
    const relatedSources = scopeData().sources.filter(s => s.nodeId === node.id || node.sourceIds.includes(s.id));
    return (status === 'all' || node.status === status) && (matches(node) || relatedSources.some(matches));
  }
  function empty(message) {
    const block = el('div', 'pw-empty');
    block.append(el('div', 'pw-empty-icon', '◇'), el('h3', '', message), el('p', '', '未记录不等于未发生；不会补造工具调用或证据关系。'));
    return block;
  }
  function renderContent() {
    if (disposed) return;
    for (const [id, item] of tabButtons) {
      item.classList.toggle('is-active', activeTab === id);
      item.setAttribute('aria-selected', String(activeTab === id));
      item.tabIndex = activeTab === id ? 0 : -1;
    }
    list.id = `pw-panel-${activeTab}`;
    list.setAttribute('aria-labelledby', `pw-tab-${activeTab}`);
    if (activeTab === 'plan') drawer.append(detail);
    else { if (drawer.open) drawer.close(); workspace.append(detail); }
    list.replaceChildren(); detail.replaceChildren();
    workspace.classList.toggle('is-plan', activeTab === 'plan');
    statusSelect.disabled = activeTab === 'claims';
    if (!trace) {
      resultCount.textContent = '';
      list.append(empty(busy ? '正在加载执行记录' : '尚无可展示的记录'));
      detail.append(empty('选择一份 trace 开始检查'));
      return;
    }
    const selectedPath = path();
    if (selectedPath.claim) {
      const highlight = el('div', 'pw-path-banner');
      highlight.append(el('span', '', `已高亮结论的显式证据路径：${selectedPath.claim.text}`), button('清除', 'pw-text-button', () => { selectedClaim = null; renderContent(); }));
      list.append(highlight);
    }
    if (activeTab === 'claims') renderClaims();
    else if (activeTab === 'sources') renderSources();
    else if (activeTab === 'plan') renderPlans();
    else renderNodes();
  }
  function planReference(node) {
    if (node.nodeView) return node.nodeView.resultAvailableAtCut === false ? {...node.nodeView,resultSeq:null} : node.nodeView;
    const records = node.kind === 'source' ? trace.sources : node.kind === 'claim' ? trace.claims : node.kind === 'evidence' ? trace.evidence : node.kind === 'reply' ? (trace.replies || []) : trace.nodes;
    return records.find(record => record.id === node.refId);
  }
  function filterPlan(node) {
    // Filter the actual reference, not just the shortened label. Every matching
    // descendant retains its ancestors, even if a branch was manually collapsed.
    const children = (node.children || []).map(filterPlan).filter(Boolean);
    const reference = planReference(node);
    let tool = ['tool', 'step'].includes(node.kind) ? reference : null;
    if (node.kind === 'source') tool = trace.nodes.find(item => item.id === reference?.nodeId);
    if (node.kind === 'evidence') {
      const source = trace.sources.find(item => item.id === reference?.sourceId);
      tool = trace.nodes.find(item => item.id === (reference?.nodeId || source?.nodeId));
    }
    const textMatch = !query || matches(reference || {}) || matches({ label: node.label, subtitle: node.subtitle });
    const statusMatch = status === 'all' || (tool?.status || node.status) === status;
    if (!(textMatch && statusMatch) && !children.length) return null;
    return { ...node, children, directMatch: textMatch && statusMatch };
  }
  function walkPlan(node, visit) {
    visit(node);
    for (const child of node.children || []) walkPlan(child, visit);
  }
  function renderPlans() {
    const plans = buildReplyPlans(trace, { mode: planMode });
    if (!plans.length) {
      resultCount.textContent = '0 条回复';
      list.append(empty('没有可展示的回复计划'));
      detail.append(empty('尚无回复归属记录'));
      return;
    }
    let plan = plans.find(item => item.id === selectedReply);
    if (!plan) {
      plan = [...plans].reverse().find(item => item.reply.kind === 'assistant' && item.reply.text?.trim()) || plans[plans.length - 1];
      selectedReply = plan.id;
    }
    const chooser = el('div', 'pw-reply-bar');
    chooser.append(el('span','pw-muted',scopeMode === 'reply' ? '当前回复的关系图' : '快照范围下的单回复关系图 · 上方选择回复定位'));
    const modes = el('div', 'pw-plan-modes');
    modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '计划关系模式');
    for (const [mode, label] of [['execution', '执行过程'], ['evidence', '显式证据']]) {
      const control = button(label, `pw-plan-mode ${planMode === mode ? 'is-active' : ''}`, () => { planMode = mode; selectedPlanNode = null; renderContent(); });
      control.dataset.planMode = mode; control.setAttribute('aria-pressed', String(planMode === mode)); modes.append(control);
    }
    chooser.append(modes); list.append(chooser);
    if (planMode === 'evidence' && trace.capabilities?.evidenceRegistration === 'not-implemented') {
      list.append(el('div', 'pw-inline-info pw-evidence-unavailable', '当前宿主尚未接入结论／证据登记。本会话的读文件与网络返回只生成来源快照，不会自动生成显式引用；此处为空不表示读取失败。请切换“执行过程”查看已记录执行与来源。'));
    }
    const children = sessions.filter(session => session.parentSessionId === trace.id);
    const parentSessionId = sessions.find(session => session.id === trace.id)?.parentSessionId || trace.snapshot?.parentSessionId;
    if (parentSessionId || children.length) {
      const lineage = el('div', 'pw-plan-lineage');
      if (parentSessionId) lineage.append(button('← 返回父会话', 'pw-button pw-button-dark', () => { void fetchTrace(parentSessionId); }));
      for (const child of children) lineage.append(button(`子会话：${child.id}`, 'pw-button pw-button-dark', () => { void fetchTrace(child.id); }));
      lineage.append(el('span', 'pw-muted', '仅确认会话父子关系；子会话当前快照不等于父回复当时消费的内容。'));
      list.append(lineage);
    }
    const replySummary = el('details', 'pw-reply-summary');
    replySummary.open = replyExpanded;
    replySummary.addEventListener('toggle', () => { replyExpanded = replySummary.open; });
    const preview = plan.reply.text || (plan.reply.kind === 'pending' ? '本轮尚未记录 assistant 正文；工具不会挂到其他真实回复。' : '旧 trace 未记录回复，无法恢复真实的回复归属。');
    const plainPreview = preview.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`#>]/g, '').replace(/\s+/g, ' ').trim();
    replySummary.append(el('summary', '', `回复摘要 · ${plainPreview.slice(0, 150)}${plainPreview.length > 150 ? '…' : ''}`), el('div', 'pw-reply-text', preview));
    list.append(replySummary);
    if (planMode === 'evidence' && !plan.reply.claimIds?.length) {
      const message = el('div', 'pw-evidence-empty');
      const unavailable = trace.registrations?.some(r => r.status === 'source-unavailable' && (r.replyId === plan.reply.id || r.target?.replyId === plan.reply.id));
      if (unavailable) message.append(el('div', 'pw-inline-warning', '本回复存在登记，但来源已变化或不可用；当前不展示未解析的引用关系。'));
      message.append(el('h3', '', unavailable ? '本回复证据暂不可用' : '当前快照未找到本回复的证据绑定'), el('p', 'pw-muted', trace.snapshot?.truncation?.history ? trace.snapshot.evidenceScope === 'resolved-closure' ? '近期回复及按引用补取的历史来源中，未找到此回复的有效绑定；这不表示完整会话没有证据。' : '历史证据引用范围未完整加载；当前无法确认此回复是否登记过证据，请查看记录信息中的警告。' : '本快照未包含这条回复的证据绑定；未登记不等于记录损坏，也不表示回复没有执行工具。'));
      message.append(button('查看执行过程', 'pw-button pw-button-dark', () => { planMode = 'execution'; selectedPlanNode = null; renderContent(); }));
      list.append(message);
      resultCount.textContent = `${plans.length} 条回复 · ${unavailable ? '当前回复证据暂不可用' : '当前回复未登记证据'}`;
      detail.append(empty('未选择证据节点'));
      return;
    }
    if (plan.reply.kind === 'legacy') list.append(el('div', 'pw-inline-warning pw-legacy-notice', '旧 trace / legacy：未记录回复边界。此图仅汇总旧执行记录，不表示工具属于某条真实回复，也不推断证据因果。'));
    const controls = el('div', 'pw-plan-controls');
    const direction = el('div', 'pw-plan-direction', '← 数据向左汇入 · 结果在左，来源在右');
    const operations = el('div', 'pw-plan-operations');
    operations.append(
      button('全部展开', 'pw-button pw-plan-expand-all', () => { collapsedBranches.clear(); renderContent(); }),
      button('全部收起', 'pw-button pw-plan-collapse-all', () => { walkPlan(plan.root, node => { if (node.children?.length) collapsedBranches.add(node.id); }); renderContent(); })
    );
    const zoomControls = el('div', 'pw-plan-zoom');
    zoomControls.setAttribute('role', 'group'); zoomControls.setAttribute('aria-label', '画布缩放');
    const changeZoom = amount => { planZoom = Math.round(Math.max(.4, Math.min(1.8, planZoom + amount)) * 100) / 100; renderContent(); };
    const zoomOut = button('−', 'pw-button pw-plan-zoom-out', () => changeZoom(-.1));
    zoomOut.setAttribute('aria-label', '缩小计划'); zoomOut.disabled = planZoom <= .4;
    const zoomReset = button(`${Math.round(planZoom * 100)}%`, 'pw-button pw-plan-zoom-reset', () => { planZoom = 1; renderContent(); });
    zoomReset.setAttribute('aria-label', '重置缩放为 100%');
    const zoomIn = button('+', 'pw-button pw-plan-zoom-in', () => changeZoom(.1));
    zoomIn.setAttribute('aria-label', '放大计划'); zoomIn.disabled = planZoom >= 1.8;
    const fit = button('适应画布', 'pw-button pw-plan-fit', () => {
      const viewport = list.querySelector('.pw-plan-viewport'), canvas = list.querySelector('.pw-plan-canvas');
      if (!viewport || !canvas) return;
      planZoom = Math.max(.4, Math.min(1, (viewport.clientWidth - 24) / parseFloat(canvas.style.width), (viewport.clientHeight - 24) / parseFloat(canvas.style.height)));
      planViewportState = null; renderContent();
    });
    zoomControls.append(zoomOut, zoomReset, zoomIn); operations.append(zoomControls, fit);
    controls.append(direction, operations); list.append(controls);
    const legend = el('div', 'pw-plan-legend');
    for (const [edge, text] of [['execution', '同轮已记录执行 / 非证据因果'], ['evidence', '显式引用 / 未语义核验'], ['observed', '工具返回来源'], ['unassigned', '缺失 / 归属未记录']]) {
      const item = el('span', `pw-legend-item pw-legend-${edge}`);
      item.append(el('i', 'pw-legend-line'), el('span', '', text)); legend.append(item);
    }
    list.append(legend);
    const filtered = filterPlan(plan.root);
    let total = 0; let retained = 0;
    walkPlan(plan.root, () => total++);
    if (filtered) walkPlan(filtered, () => retained++);
    resultCount.textContent = `当前图 ${retained} / ${total} 个节点 · ${trace.snapshot?.window === 'recent' ? '当前窗口' : '当前快照'} ${plans.length} 条回复`;
    if (!filtered) list.append(empty('此回复中没有匹配路径；可切换回复查看'));
    else renderPlanCanvas(filtered, plan);
    const selected = selectedPlanNode ? findPlanNode(plan.root, selectedPlanNode) : null;
    renderPlanDetail(selected || plan.root, plan);
  }
  function findPlanNode(node, id) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findPlanNode(child, id);
      if (found) return found;
    }
    return null;
  }
  function renderPlanCanvas(tree, plan) {
    const filtering = !!query || status !== 'all';
    const CARD_WIDTH = 164, CARD_HEIGHT = 104, GAP_X = 56, GAP_Y = 18, PAD = 30;
    // Query-plan layout: output is on the left, each upstream input to its right.
    // Allocate vertical subtree spans so parallel branches never overlap.
    function measure(node) {
      const children = (!filtering && collapsedBranches.has(node.id) ? [] : node.children || []).map(measure);
      const span = Math.max(CARD_HEIGHT, children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, children.length - 1) * GAP_Y);
      return { node, children, span };
    }
    const measured = measure(tree);
    const positioned = []; const edges = []; let maxDepth = 0;
    function place(branch, top, depth) {
      const entry = { ...branch, x: PAD + depth * (CARD_WIDTH + GAP_X), y: top + (branch.span - CARD_HEIGHT) / 2 };
      positioned.push(entry); maxDepth = Math.max(maxDepth, depth);
      const childrenSpan = branch.children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, branch.children.length - 1) * GAP_Y;
      let next = top + (branch.span - childrenSpan) / 2;
      for (const child of branch.children) {
        const childEntry = place(child, next, depth + 1); edges.push({ parent: entry, child: childEntry }); next += child.span + GAP_Y;
      }
      return entry;
    }
    place(measured, PAD, 0);
    const width = PAD * 2 + CARD_WIDTH + maxDepth * (CARD_WIDTH + GAP_X);
    const height = measured.span + PAD * 2;
    const viewport = el('div', 'pw-plan-viewport');
    viewport.tabIndex = 0; viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', '回复树形执行计划画布，可横向和纵向滚动');
    const sizing = el('div', 'pw-plan-sizing');
    sizing.style.width = `${Math.ceil(width * planZoom)}px`; sizing.style.height = `${Math.ceil(height * planZoom)}px`;
    const canvas = el('div', 'pw-plan-canvas');
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; canvas.style.transform = `scale(${planZoom})`;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs) => { const item = document.createElementNS(svgNS, tag); for (const [name, value] of Object.entries(attrs)) item.setAttribute(name, String(value)); return item; };
    const connections = svg('svg', { class: 'pw-plan-connections', width, height, 'aria-hidden': 'true' });
    const defs = svg('defs', {});
    for (const edge of ['execution', 'evidence', 'observed', 'unassigned']) {
      const marker = svg('marker', { id: `${viewerId}-${edge}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' });
      marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: `pw-arrow-${edge}` })); defs.append(marker);
    }
    connections.append(defs);
    for (const { parent, child } of edges) {
      const edge = ['execution', 'evidence', 'observed', 'unassigned'].includes(child.node.edge) ? child.node.edge : 'execution';
      const fromX = child.x - 4, fromY = child.y + CARD_HEIGHT / 2;
      const toX = parent.x + CARD_WIDTH + 4, toY = parent.y + CARD_HEIGHT / 2;
      const middle = parent.x + CARD_WIDTH + GAP_X / 2;
      connections.append(svg('path', { class: `pw-plan-edge pw-edge-${edge}`, 'data-edge': edge, 'data-from': child.node.id, 'data-to': parent.node.id, d: `M ${fromX} ${fromY} H ${middle} V ${toY} H ${toX}`, 'marker-end': `url(#${viewerId}-${edge})` }));
    }
    canvas.append(connections);
    const kindLabels = { reply: '回复', step: '步骤汇总', tool: '工具调用', source: '来源快照', claim: '结论声明', evidence: '显式引用', missing: '记录缺失' };
    const highlight = path();
    for (const entry of positioned) {
      const node = entry.node;
      const selected = (selectedPlanNode || plan.root.id) === node.id;
      const card = el('div', `pw-plan-card pw-plan-${node.kind} ${selected ? 'is-selected' : ''} ${filtering && node.directMatch ? 'is-match' : ''} ${highlight.nodes.has(node.refId) || highlight.sources.has(node.refId) ? 'is-evidence' : ''}`);
      card.dataset.kind = node.kind; card.dataset.refId = node.refId || ''; card.dataset.planNodeId = node.id;
      card.style.left = `${entry.x}px`; card.style.top = `${entry.y}px`;
      const choose = button('', 'pw-plan-node-select', () => { selectedPlanNode = node.id; renderContent(); openDrawer(); });
      choose.setAttribute('aria-pressed', String(selected));
      const reference = planReference(node);
      const icon = el('span', 'pw-operator-icon'); icon.append(operatorIcon(node.kind, reference));
      const shortSubtitle = node.kind === 'reply' ? (plan.reply.turn == null ? 'Assistant output' : `Turn ${plan.reply.turn} · Step ${plan.reply.step ?? '—'}`)
        : node.kind === 'source' ? [reference?.uri?.split('/').filter(Boolean).at(-1) || '返回快照', reference?.returnedLocator].filter(Boolean).join(' · ')
        : node.kind === 'tool' ? (reference?.toolName || 'tool')
        : node.kind === 'step' ? `${node.children?.length ?? 0} 个执行分支` : (node.subtitle || kindLabels[node.kind]);
      choose.append(icon, el('strong', 'pw-plan-node-label', node.label), el('span', 'pw-plan-node-subtitle', shortSubtitle));
      const evidenceReuse = node.kind === 'evidence' ? trace.claims.filter(c=>(plan.reply.claimIds ?? []).includes(c.id) && c.evidenceIds.includes(node.refId)).length : 0;
      choose.title = `${node.label}\n${node.subtitle || ''}${evidenceReuse > 1 ? `\n由本回复 ${evidenceReuse} 条结论共享（同一证据，重复展开）` : ''}`;
      card.append(choose);
      const bottom = el('div', 'pw-plan-card-bottom');
      const nodeStatus = node.status || (node.kind === 'reply' ? plan.reply.status : null);
      if (nodeStatus) {
        const label = STATUS[nodeStatus] || ({ recorded: '已记录', pending: '等待回复', unassigned: '归属未记录' }[nodeStatus]) || nodeStatus;
        const dot = el('span', `pw-plan-status-dot pw-status-${nodeStatus}`); dot.title = label; dot.setAttribute('aria-label', label); bottom.append(dot);
      }
      bottom.append(el('span', `pw-plan-node-metric${evidenceReuse > 1 ? ' pw-evidence-shared' : ''}`, evidenceReuse > 1 ? `共享 · ${evidenceReuse} 条结论` : node.kind === 'tool' && reference ? duration(reference) : kindLabels[node.kind] || node.kind));
      if (node.children?.length) {
        const isOpen = filtering || !collapsedBranches.has(node.id);
        const toggle = button(`${isOpen ? '−' : '+'} ${node.children.length}`, 'pw-branch-toggle', () => {
          if (collapsedBranches.has(node.id)) collapsedBranches.delete(node.id); else collapsedBranches.add(node.id);
          renderContent();
        });
        toggle.setAttribute('aria-expanded', String(isOpen)); toggle.setAttribute('aria-label', `${isOpen ? '收起' : '展开'} ${node.label} 的上游分支`);
        toggle.disabled = filtering; if (filtering) toggle.title = '筛选期间自动展开所有匹配路径'; bottom.append(toggle);
      }
      card.append(bottom); canvas.append(card);
    }
    sizing.append(canvas); viewport.append(sizing); list.append(viewport);
    const viewportKey = `${planTraceRevision}:${plan.id}:${planMode}`;
    const saveViewport = () => {
      if (!viewport.isConnected) return;
      planViewportState = {
        key: viewportKey,
        centerX: (viewport.scrollLeft + viewport.clientWidth / 2) / planZoom,
        top: viewport.scrollTop / planZoom
      };
    };
    // Start at the output operator, vertically centered on its subtree.
    // Selection and zoom preserve the user's inspected canvas position.
    if (planViewportState?.key === viewportKey) {
      viewport.scrollLeft = planViewportState.centerX * planZoom - viewport.clientWidth / 2;
      viewport.scrollTop = planViewportState.top * planZoom;
    } else {
      viewport.scrollLeft = 0;
      viewport.scrollTop = (positioned[0].y + CARD_HEIGHT / 2) * planZoom - viewport.clientHeight / 2;
    }
    saveViewport();
    viewport.addEventListener('scroll', saveViewport, { passive: true });
    // Pointer capture keeps blank-canvas panning active outside its initial hit.
    // Native touch scrolling and all node/button interactions remain untouched.
    let drag = null;
    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('.pw-plan-card, button, a, input, select')) return;
      const rect = viewport.getBoundingClientRect();
      if (event.clientX >= rect.left + viewport.clientWidth || event.clientY >= rect.top + viewport.clientHeight) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning'); event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      viewport.scrollLeft = drag.left - (event.clientX - drag.x);
      viewport.scrollTop = drag.top - (event.clientY - drag.y);
      saveViewport();
    });
    const endDrag = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null; viewport.classList.remove('is-panning');
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(event, endDrag);
    if (filtering) list.append(el('p', 'pw-plan-filter-note', '筛选中：保留匹配节点及全部祖先，自动展开匹配路径；不会用折叠隐藏结果。'));
    else list.append(el('p', 'pw-plan-filter-note', '按住画布空白处拖动平移，或使用滚轮／滚动条；点击节点在右侧抽屉查看详情。'));
  }
  function renderPlanDetail(node, plan) {
    const reference = planReference(node);
    if (node.kind === 'tool' && reference) { renderNodeDetail(reference); return; }
    if (node.kind === 'source' && reference) { renderSourceDetail(reference); return; }
    if (node.kind === 'claim' && reference) { renderClaimDetail(reference); return; }
    detail.append(el('div', 'pw-eyebrow', 'PLAN NODE DETAILS'), el('h2', 'pw-detail-title', node.label));
    if (node.kind === 'reply') {
      const fields = el('dl', 'pw-fields');
      fields.append(field('回复 ID', plan.reply.id, true), field('记录状态', plan.reply.status), field('Turn / Step', `${plan.reply.turn ?? '未知'} / ${plan.reply.step ?? '未知'}`), field('记录时间', plan.reply.time), field('中断标记', plan.reply.interrupted ? '此条正文在中断时提交，并非完整答复' : '未记录中断标记'), field('轮次结束原因', plan.reply.turnEndReason || '未记录'), field('归属节点', (plan.reply.nodeIds || []).join('、')));
      detail.append(fields, section('完整回复正文', codeBlock(plan.reply.text || '未记录回复正文')),
        el('div', 'pw-inline-info', '执行归属只说明同一回复轮次中已记录的执行，不证明回复使用了所有工具返回。显式证据模式仅沿已登记的引用关系；不从时间先后推断因果。'));
      if (plan.reply.kind === 'legacy') detail.append(el('div', 'pw-inline-warning', '旧 trace 未记录 replies；此汇总不代表真实 assistant 回复。'));
    } else if (node.kind === 'step') {
      if (reference) {
        const fields = el('dl', 'pw-fields');
        fields.append(field('步骤 ID', reference.id, true), field('Turn / Step', `${reference.turn ?? '未知'} / ${reference.step ?? '未知'}`), field('已记录状态', STATUS[reference.status] || '未知'));
        detail.append(fields);
      }
      detail.append(section('步骤汇总说明', node.subtitle || '步骤将此回复内已记录的执行分组；下方为上游输入，不表示证据因果。'), el('div', 'pw-inline-info', `${node.children?.length || 0} 个直接输入分支。虚线仅表示执行归属，不代表串行执行、模型已读取或结论获得支持。`));
    } else if (node.kind === 'evidence' && reference) {
      const fields = el('dl', 'pw-fields');
      fields.append(field('证据 ID', reference.id, true), field('定位', reference.locator), field('来源 ID', reference.sourceId), field('工具节点', reference.nodeId), field('声明方式', reference.attribution));
      const shared = trace.claims.filter(c=>(plan.reply.claimIds ?? []).includes(c.id) && c.evidenceIds.includes(reference.id));
      if (shared.length > 1) detail.append(el('div', 'pw-inline-info', `共享 · ${shared.length} 条结论。同一证据在不同结论分支重复展开，不是重复登记。`));
      detail.append(fields, section('记录摘录', codeBlock(reference.excerpt)), el('div', 'pw-inline-info', '这是显式引用声明，未语义核验；引用存在不等于证据充分，也不保证结论正确。'));
    } else detail.append(el('div', 'pw-inline-warning', node.subtitle || '对应记录缺失或归属未记录，不补造上游事实。'));
  }
  function renderNodes() {
    const trace = scopeData();
    const nodes = trace.nodes.filter(nodeMatches);
    resultCount.textContent = `${nodes.length} / ${trace.nodes.length} 个节点`;
    if (!nodes.length) list.append(empty('没有匹配的执行节点'));
    const titleRow = el('div', 'pw-panel-heading');
    titleRow.append(el('h2', '', activeTab === 'timeline' ? '记录时间轴' : '执行分组'), el('span', 'pw-muted', activeTab === 'timeline' ? '同一时间尺度 · 并行不串行化' : '步骤 / 轮次，不表示数据依赖'));
    list.append(titleRow);
    const knownTimes = trace.nodes.flatMap(n => [n.start, n.end]).map(v => v ? Date.parse(v) : NaN).filter(Number.isFinite);
    const min = knownTimes.length ? Math.min(...knownTimes) : 0;
    const max = knownTimes.length ? Math.max(...knownTimes) : 1;
    const span = Math.max(1, max - min);
    if (activeTab === 'timeline' && knownTimes.length) list.append(el('div', 'pw-timeline-scale', `${time(new Date(min).toISOString())} — ${time(new Date(max).toISOString())} · 本地时间`));
    const highlight = path();
    for (const node of nodes) {
      const isStep = node.kind === 'step';
      const card = button('', `pw-node ${isStep ? 'pw-step' : ''} ${selectedNode === node.id ? 'is-selected' : ''} ${highlight.nodes.has(node.id) ? 'is-evidence' : ''}`, () => { selectedNode = node.id; renderContent(); });
      card.setAttribute('aria-pressed', String(selectedNode === node.id));
      const top = el('div', 'pw-node-top');
      top.append(el('span', `pw-node-icon pw-status-${node.status}`, isStep ? '▤' : node.status === 'error' ? '!' : '›_'));
      const labels = el('div', 'pw-node-labels');
      labels.append(el('strong', '', node.label || node.toolName || node.id), el('span', 'pw-node-meta', `${isStep ? '步骤' : node.toolName || '未知工具'}${node.step !== undefined ? ` · Step ${node.step}` : ''}${node.turn !== undefined ? ` · Turn ${node.turn}` : ''}${node.parentId ? ` · 父级 ${node.parentId}` : ''}`));
      top.append(labels, badge(STATUS[node.status] || '状态未知', `pw-status-${node.status}`));
      card.append(top);
      const summary = el('div', 'pw-node-bottom');
      summary.append(el('span', '', `${time(node.start)} · ${duration(node)}`), el('span', '', highlight.nodes.has(node.id) ? '● 显式证据路径' : `${node.sourceIds.length} 个来源`));
      card.append(summary);
      if (activeTab === 'timeline') {
        const track = el('div', 'pw-timeline-track');
        const bar = el('span', `pw-timeline-bar pw-status-${node.status}`);
        if (node.start && Number.isFinite(Date.parse(node.start))) {
          const left = Math.max(0, Math.min(100, (Date.parse(node.start) - min) / span * 100));
          const width = node.end && Number.isFinite(Date.parse(node.end)) ? Math.max(0.8, (Date.parse(node.end) - Date.parse(node.start)) / span * 100) : 1;
          bar.style.left = `${Math.min(left, 99)}%`;
          bar.style.width = `${Math.min(width, 100 - Math.min(left, 99))}%`;
          if (!node.end) bar.classList.add('is-open');
          track.append(bar);
          track.title = `${node.start} → ${node.end || '结束未记录（不推定持续至今）'}`;
        } else track.append(el('span', 'pw-muted', '开始时间未记录'));
        card.append(track);
      }
      list.append(card);
    }
    const node = trace.nodes.find(n => n.id === selectedNode);
    if (node) renderNodeDetail(node); else detail.append(empty('选择一个节点查看详情'));
  }
  function renderNodeDetail(node) {
    const head = el('div', 'pw-detail-heading');
    head.append(el('div', 'pw-eyebrow', 'NODE DETAILS'), el('h2', '', node.label || node.toolName || node.id), badge(STATUS[node.status] || '状态未知', `pw-status-${node.status}`));
    detail.append(head);
    const fields = el('dl', 'pw-fields');
    fields.append(field('节点 ID', node.id, true), field('工具', node.toolName || '步骤分组'), field('开始', node.start), field('结束', node.end), field('记录耗时', duration(node)), field('已提供给模型', '未知；不从工具返回自动推断'));
    fields.append(field('返回完整性', ({returned:'已记录返回',error:'已记录错误返回','missing-start':'缺失开始','missing-result':'未记录返回'}[node.resultState]) || '旧记录未区分'), field('运行活性', node.activityState === 'running' ? '有明确活跃记录' : node.activityState === 'stopped' ? '已记录停止' : '未知，不根据返回缺失推断'));
    if (node.cutSeq != null) fields.append(field('回复提交截面', String(node.cutSeq)), field('截面内返回', node.resultAvailableAtCut ? '可用' : '当时无返回；后续结果不在此处展示'));
    detail.append(fields);
    if (node.parentId) {
      const parent = scopeData().nodes.find(candidate => candidate.id === node.parentId);
      detail.append(section('执行父级 · 非证据依赖', parent ? button(parent.label || parent.toolName || parent.id, 'pw-source-link', () => { selectTool(parent); }) : `父级 ${node.parentId} 未记录在当前历史窗口中。`));
    }
    if (!node.end) detail.append(el('div', 'pw-inline-warning', '结束时间未记录。缺少结果时，不代表工具仍在运行或已成功。'));
    detail.append(section('请求输入 · 不证明访问成功', codeBlock(node.input)), section('已记录的工具返回', codeBlock(node.output)));
    const sources = scopeData().sources.filter(s => node.resultAvailableAtCut === false ? false : (s.nodeId === node.id || node.sourceIds.includes(s.id)));
    const block = section(`来源定位 · ${sources.length}`);
    if (!sources.length) block.append(el('p', 'pw-muted', '此节点没有已记录的来源快照。'));
    for (const source of sources) block.append(sourceSummary(source));
    detail.append(block);
    const relatedEvidence = scopeData().evidence.filter(e => e.nodeId === node.id || sources.some(s => s.id === e.sourceId));
    if (relatedEvidence.length && node.resultAvailableAtCut !== false) {
      const evidenceBlock = section('显式绑定的证据 · 未语义核验');
      for (const evidence of relatedEvidence) evidenceBlock.append(el('p', 'pw-evidence-ref', `${evidence.id} · ${evidence.locator || '未记录定位'}`));
      detail.append(evidenceBlock);
    }
  }
  function selectTool(node) {
    selectedNode = node.id;
    if (activeTab === 'plan') {
      const reply = trace.replies?.find(item => item.id === selectedReply);
      const projected = reply && getReplyNodeView(trace, reply, node.id);
      if (!projected) { detail.replaceChildren(empty('此执行不在当前回复截面中；请切换时间线查看完整生命周期')); return; }
      node = projected;
      const plans = buildReplyPlans(trace, { mode: planMode });
      const current = plans.find(plan => plan.id === selectedReply);
      const ordered = current ? [current, ...plans.filter(plan => plan !== current)] : plans;
      for (const plan of ordered) {
        let found = null;
        walkPlan(plan.root, item => { if (!found && ['tool', 'step'].includes(item.kind) && item.refId === node.id) found = item; });
        if (found) { selectedReply = plan.id; selectedPlanNode = found.id; renderContent(); openDrawer(); return; }
      }
      detail.replaceChildren(); renderNodeDetail(node);
    } else renderContent();
  }
  function sourceSummary(source) {
    const card = button('', `pw-source-link ${path().sources.has(source.id) ? 'is-evidence' : ''}`, () => {
      selectedSource = source.id;
      if (activeTab === 'plan') { detail.replaceChildren(); renderSourceDetail(source); }
      else { activeTab = 'sources'; renderContent(); }
    });
    card.append(el('strong', '', source.kind === 'file' ? '▤ 文件快照' : source.kind === 'http' ? '↗ 网络工具返回' : '◇ 其他来源'), el('span', 'pw-mono', source.uri), el('span', 'pw-muted', source.returnedLocator || '返回定位未知'));
    return card;
  }
  function sourceMatches(source) {
    const node = scopeData().nodes.find(n => n.id === source.nodeId);
    return matches(source) && (status === 'all' || node?.status === status);
  }
  function renderSources() {
    const trace = scopeData();
    const sources = trace.sources.filter(sourceMatches);
    resultCount.textContent = `${sources.length} / ${trace.sources.length} 个来源`;
    list.append(el('h2', 'pw-list-title', '历史来源快照'));
    if (!sources.length) list.append(empty('没有匹配的来源快照'));
    for (const source of sources) {
      const card = sourceSummary(source);
      card.classList.add('pw-source-card');
      card.classList.toggle('is-selected', selectedSource === source.id);
      card.setAttribute('aria-pressed', String(selectedSource === source.id));
      card.append(badge(source.truncated ? '已截断' : '未标记截断', source.truncated ? 'pw-warning' : ''), el('span', 'pw-muted', source.snapshotKind));
      list.append(card);
    }
    const source = trace.sources.find(s => s.id === selectedSource);
    if (!source) { detail.append(empty('选择一个来源查看快照')); return; }
    renderSourceDetail(source);
  }
  function renderSourceDetail(source) {
    detail.append(el('div', 'pw-eyebrow', 'SOURCE SNAPSHOT'), el('h2', 'pw-detail-title', source.kind === 'file' ? '文件读取记录' : source.kind === 'http' ? '网络来源记录' : '来源记录'));
    const fields = el('dl', 'pw-fields');
    fields.append(field('来源 ID', source.id, true), field('资源标识', source.uri, true), field('请求定位', source.locator), field('返回定位', source.returnedLocator), field('快照类型', source.snapshotKind), field('截断标记', source.truncated ? '是 · 不代表全文' : '未标记截断 · 不保证为全文'), field('采集说明', source.observation));
    detail.append(fields);
    const link = safeLink(source.uri);
    if (link) detail.append(link, el('p', 'pw-muted pw-small', '手动打开将访问当前外部地址，不是历史重放。'));
    detail.append(section('当时工具返回的快照', codeBlock(source.snapshot)), el('div', 'pw-inline-info', '不重新读取文件或重新请求 URL。快照内容不代表原文件全文或原始 HTTP 响应；实际访问范围以明确记录为限。'));
    const node = scopeData().nodes.find(n => n.id === source.nodeId);
    if (node) detail.append(section('来自工具节点', button(node.label || node.toolName || node.id, 'pw-source-link', () => { if (activeTab !== 'plan') activeTab = 'timeline'; selectTool(node); })));
    else detail.append(el('div', 'pw-inline-warning', `来源节点 ${source.nodeId || '（未记录）'} 不存在。`));
  }
  function claimProblem(claim) {
    const trace=scopeData();
    return !claim.evidenceIds.length || claim.evidenceIds.some(id => {
      const evidence = trace.evidence.find(e => e.id === id);
      return !evidence || (evidence.sourceId && !trace.sources.some(s => s.id === evidence.sourceId)) || (evidence.nodeId && !trace.nodes.some(n => n.id === evidence.nodeId && n.resultAvailableAtCut !== false)) || (!evidence.sourceId && !evidence.nodeId);
    });
  }
  function renderClaims() {
    const trace = scopeData();
    const claims = trace.claims.filter(matches);
    resultCount.textContent = `${claims.length} / ${trace.claims.length} 条结论`;
    list.append(el('h2', 'pw-list-title', '结构化结论声明'), el('p', 'pw-list-description', '仅跟随 evidence ID 显式关系；不把执行先后当作证据依赖。'));
    if (!claims.length) list.append(empty(trace.claims.length ? '没有匹配的结论' : '未记录结论绑定'));
    for (const claim of claims) {
      const card = button('', `pw-claim-card ${selectedClaim === claim.id ? 'is-selected' : ''}`, () => { selectedClaim = claim.id; renderContent(); });
      card.setAttribute('aria-pressed', String(selectedClaim === claim.id));
      card.append(badge(claimProblem(claim) ? '证据缺失 / 不完整' : '存在显式引用', claimProblem(claim) ? 'pw-warning' : 'pw-positive'), el('h3', '', claim.text), el('p', 'pw-muted', `${claim.evidenceIds.length} 个证据引用 · 显式声明，未语义核验`));
      list.append(card);
    }
    const claim = trace.claims.find(c => c.id === selectedClaim);
    if (!claim) { detail.append(empty('选择结论，沿显式路径检查依据')); return; }
    renderClaimDetail(claim);
  }
  function renderClaimDetail(claim) {
    const reply = activeTab === 'plan' || scopeMode === 'reply' ? trace.replies?.find(item => item.id === selectedReply) : null;
    detail.append(el('div', 'pw-eyebrow', 'EXPLICIT EVIDENCE PATH'), el('h2', 'pw-detail-title', claim.text), badge('声明未语义核验', 'pw-warning'));
    detail.append(el('p', 'pw-detail-note', '结论 → 证据 ID → 来源 / 工具。以下仅说明引用关系存在，不证明来源可靠或结论正确。'));
    if (!claim.evidenceIds.length) detail.append(el('div', 'pw-inline-warning', '此结论未绑定任何证据，不自动推断上游依据。'));
    for (const id of claim.evidenceIds) {
      const evidence = trace.evidence.find(e => e.id === id);
      const block = el('section', `pw-evidence-card ${evidence ? '' : 'is-missing'}`);
      block.append(el('h3', '', `↳ ${id}`));
      if (!evidence) { block.append(el('p', 'pw-warning-text', '证据缺失：trace 中没有对应记录。')); detail.append(block); continue; }
      if (reply?.cutSeq != null) {
        const source = trace.sources.find(s => s.id === evidence.sourceId);
        const node = getReplyNodeView(trace, reply, evidence.nodeId || source?.nodeId);
        if (!node || node.resultAvailableAtCut !== true || (source && !node.sourceIds.includes(source.id))) {
          block.append(el('p', 'pw-warning-text', '证据在此回复截面不可用；不展示后续摘录、来源或工具返回。'));
          detail.append(block); continue;
        }
      }
      block.append(badge(evidence.attribution === 'imported' ? '导入的声明关系' : '显式声明关系'), el('p', 'pw-muted', '未语义核验'), field('定位', evidence.locator));
      if (evidence.excerpt) block.append(codeBlock(evidence.excerpt));
      const source = trace.sources.find(s => s.id === evidence.sourceId);
      if (source) block.append(sourceSummary(source));
      else if (evidence.sourceId) block.append(el('p', 'pw-warning-text', `来源缺失：${evidence.sourceId}`));
      const nodeId = evidence.nodeId || source?.nodeId;
      const node = trace.nodes.find(n => n.id === nodeId);
      if (node) block.append(button(`→ 工具：${node.label || node.toolName || node.id}`, 'pw-path-node', () => { if (activeTab !== 'plan') activeTab = 'timeline'; selectTool(node); }));
      else if (nodeId) block.append(el('p', 'pw-warning-text', `节点缺失：${nodeId}`));
      if (!source && !node) block.append(el('p', 'pw-warning-text', '证据无法定位到现有来源或执行节点。'));
      detail.append(block);
    }
    const limitations = el('ul', 'pw-limitations');
    for (const item of claim.limitations) limitations.append(el('li', '', item));
    if (!claim.limitations.length) limitations.append(el('li', '', '未登记限制条件，不表示不存在限制。'));
    detail.append(section('限制与未核验事项', limitations));
  }
  function updateSessions() {
    sessionSelect.replaceChildren();
    const placeholder = el('option', '', sessions.length ? '选择宿主会话…' : '没有可用会话');
    placeholder.value = ''; placeholder.disabled = true; sessionSelect.append(placeholder);
    for (const session of sessions) {
      const option = el('option', '', `${session.live ? '在线' : '历史'} · ${session.title || session.id}`); option.value = session.id; sessionSelect.append(option);
    }
    sessionSelect.value = currentSession;
  }
  async function fetchSessions(reloadCurrent = false) {
    if (typeof loadSessions !== 'function' || disposed) return;
    const request = ++revision;
    busy = true; error = ''; recoverableError = null; render();
    try {
      const result = await loadSessions();
      if (disposed || request !== revision) return;
      if (!Array.isArray(result) || result.some(s => !s || typeof s.id !== 'string' || (s.title != null && typeof s.title !== 'string'))) throw new Error('宿主返回的会话列表格式无效');
      sessions = result; updateSessions();
      busy = false;
      if (sessions.length && typeof loadTrace === 'function' && (!trace || (reloadCurrent && currentSession))) {
        const nextSession = sessions.some(session => session.id === currentSession) ? currentSession : sessions[0].id;
        await fetchTrace(nextSession); return;
      }
      if (!sessions.length && !trace) error = '宿主暂无可用会话。可导入 trace；不会自动切换为示例。';
    } catch (cause) {
      if (disposed || request !== revision) return;
      error = `宿主会话列表加载失败：${errorText(cause)}。未切换为示例。`;
      busy = false;
    }
    if (!disposed && request === revision) { busy = false; render(); }
  }
  async function fetchTrace(id, options = {}) {
    if (!id || typeof loadTrace !== 'function' || disposed) return;
    const request = ++revision;
    const sameSession = currentSession === id;
    if (!sameSession) { planMode = 'execution'; selectedReply = null; preferredReply = id === initialSessionId ? initialReplyId : ''; traceWindow = 'full'; }
    if (options.window === 'recent') traceWindow = 'recent';
    currentSession = id;
    updateSessions();
    busy = true; error = ''; recoverableError = null;
    // Clear the previous session to avoid showing it under the newly selected ID.
    trace = null; render();
    try {
      let value;
      try {
        value = await (traceWindow === 'recent' ? loadTrace(id, { window: 'recent' }) : loadTrace(id));
      } catch (cause) {
        if (disposed || request !== revision) return;
        const sizeCodes = ['HISTORY_TOO_LARGE', 'TRACE_TOO_LARGE'];
        if (traceWindow === 'recent' || cause?.status !== 413 || !sizeCodes.includes(cause.code)) throw cause;
        traceWindow = 'recent';
        value = await loadTrace(id, { window: 'recent' });
      }
      if (disposed || request !== revision) return;
      setTrace(value);
    } catch (cause) {
      if (disposed || request !== revision) return;
      recoverableError = cause?.status === 413 ? { status: 413, code: cause.code } : null;
      error = recoverableError
        ? `宿主会话加载失败：${errorText(cause)}。${traceWindow === 'recent' ? '近期记录也超过安全加载上限，未加载任何记录；可导入较小的 trace。' : '未加载任何记录；未识别为可自动恢复的历史大小错误。'}`
        : `宿主会话加载失败：${errorText(cause)}。未切换为示例，请重试或导入 trace。`;
    }
    if (!disposed && request === revision) { busy = false; render(); }
  }
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const request = ++revision;
    busy = false;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('文件超过 8 MiB 导入上限');
      const text = await file.text();
      if (disposed || request !== revision) return;
      // The core marks imported records as import, never as a live host session.
      const value = importTrace(text);
      setTrace(value);
      currentSession = ''; updateSessions();
    } catch (cause) {
      if (disposed || request !== revision) return;
      error = `导入失败：${errorText(cause)}。${trace ? '仍显示上一份有效记录。' : '未载入任何记录。'}`;
    }
    if (!disposed && request === revision) { input.value = ''; render(); }
  });
  function confirmExport() {
    if (!trace || disposed) return;
    try {
      const exportClaim = activeTab === 'plan' ? path().claim?.id : selectedClaim;
      pendingExport = selectedTrace(trace, exportClaim ? { claimId: exportClaim, ...((activeTab === 'plan' || scopeMode === 'reply') && selectedReply ? { replyId: selectedReply } : {}) } : { replyId: selectedReply });
      exportSummary.textContent = `仅导出当前${selectedClaim ? '结论' : '回复'}子图：${pendingExport.nodes.length} 个工具、${pendingExport.sources.length} 个来源、${pendingExport.claims.length} 条结论。无关会话正文不包含在内；缺失引用会保留提示。`;
      exportDialog.showModal();
    } catch (cause) { pendingExport = null; error = `选中内容不可导出：${errorText(cause)}`; render(); }
  }
  function download(value, kind = 'structure') {
    if (!value || disposed) return;
    try {
      const json = exportTrace(value);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
      urls.add(url);
      const link = el('a');
      link.href = url;
      link.download = `pathway-${kind}-${trace.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'trace'}.json`;
      root.append(link); link.click(); link.remove();
      // Keep the object URL until the next event-loop turn, then release it.
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
    } catch (cause) { error = `脱敏导出失败：${errorText(cause)}`; render(); }
  }
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = TABS.map(([id]) => id);
    const index = ids.indexOf(activeTab);
    activeTab = ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    renderContent(); tabButtons.get(activeTab).focus();
  });
  try {
    if (!hostMode && !preferredReply) preferredReply = new URL(window.location.href).searchParams.get('pathwayReply') || '';
    if (initialTrace !== undefined && initialTrace !== null) setTrace(initialTrace);
    else if (!hostMode) setTrace(createDemoTrace());
    else if (typeof loadSessions !== 'function') error = '宿主模式未提供会话列表；请传入 trace 或 loadSessions。不会自动切换为示例。';
  } catch (cause) { error = `Trace 校验失败：${errorText(cause)}。未切换为示例。`; }
  updateSessions(); render();
  if (typeof loadSessions === 'function') void fetchSessions();
  return function dispose() {
    if (disposed) return;
    disposed = true; revision++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); root.remove();
  };
}

export default mountViewer;
