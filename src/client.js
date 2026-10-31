import React from 'react';
import { mountViewer } from './viewer.js';

export const inject = ['slots', 'layout'];
export function apply(ctx) {
  const h = React.createElement;
  function Panel({ pathwaySessionId = '' } = {}) {
    const ref = React.useRef(null);
    React.useEffect(() => {
      const controller = new AbortController();
      async function get(url) {
        // The existing GUI's authenticated same-origin carrier owns admission.
        const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) {
          if (response.status === 413) {
            // Error bodies are untrusted: retain only bounded diagnostic codes
            // and numeric limits, never render arbitrary server text or HTML.
            let body;
            try { body = await response.json(); } catch { body = null; }
            const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.:\-]{1,120}$/.test(value) ? value : undefined;
            const code = safeCode(body?.error) || 'HTTP_413';
            const reason = safeCode(body?.reason);
            const limits = {};
            if (body?.limits && typeof body.limits === 'object' && !Array.isArray(body.limits)) {
              for (const [key, value] of Object.entries(body.limits).slice(0, 20)) {
                if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[key] = value;
              }
            }
            const diagnostics = [reason && `原因：${reason}`, Object.keys(limits).length && `限制：${JSON.stringify(limits)}`].filter(Boolean).join('；');
            const error = new Error(`宿主记录超过安全加载上限（413），未加载完整历史。${diagnostics ? `（${diagnostics}）` : ''}近期窗口若也超限，将保留失败状态，不会循环重试。`);
            Object.assign(error, { status: response.status, code, reason, limits });
            throw error;
          }
          const error = new Error(`宿主接口 ${response.status}：请检查登录、插件启用状态与会话 ID`);
          Object.assign(error, { status: response.status, code: `HTTP_${response.status}` });
          throw error;
        }
        return response.json();
      }
      // Optional deep-link parameters do not alter the host router or profile.
      const params = new URL(window.location.href).searchParams;
      const dispose = mountViewer(ref.current, {
        embedded: Boolean(pathwaySessionId),
        sessionId: pathwaySessionId || params.get('pathwaySession') || '',
        replyId: params.get('pathwayReply') || '',
        loadSessions: async () => {
          const sessions = (await get('api/pathway/sessions')).sessions;
          // The conversation tab is scoped to its own session, including a cold
          // session outside the capped list. Never silently open another one.
          return pathwaySessionId ? [sessions.find(item => item.id === pathwaySessionId) || { id: pathwaySessionId }] : sessions;
        },
        loadTrace: (id, { window: traceWindow } = {}) => get(`api/pathway/trace?sessionId=${encodeURIComponent(id)}${traceWindow === 'recent' ? '&window=recent' : ''}`)
      });
      return () => { controller.abort(); dispose(); };
    }, [pathwaySessionId]);
    return h('div', { ref, style: { height: '100%', minHeight: 0, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', overscrollBehaviorY: 'auto', paddingTop: pathwaySessionId ? 0 : 'var(--dsh-frame-top-clearance, 0px)', boxSizing: 'border-box' } });
  }
  function Icon() {
    return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block', flexShrink: 0 } },
      h('path', { d: 'M7 7v4a4 4 0 0 0 4 4h6M7 11h6a4 4 0 0 0 4-4' }),
      ...[[7,4],[17,4],[17,18]].map(([x,y]) => h('rect', { key: `${x}:${y}`, x: x-2.3, y: y-2.3, width: 4.6, height: 4.6, rx: 1, fill: 'none' })));
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'pathway', order: 25, label: '执行链路',
    inject: sessionId => ({ pathwaySessionId: sessionId }),
  }, Panel));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'pathway' }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'pathway', order: 35, label: '执行链路' }, Icon));
}
