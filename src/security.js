/** Best-effort credential redaction. Not a general PII detector. */
const SECRET_KEY = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:x[-_]?)?api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|passwd|secret|client[-_]?secret|signature|credential)$/i;
export const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, events: 20000, nodes: 5000, text: 100000, depth: 32 });
export function redactText(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|key|secret|password|signature|sig)=)[^&#\s"'<>]*/gi, '$1[REDACTED]')
    .replace(/((?:["']?)(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|secret)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, '$1[REDACTED]');
}
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (depth > LIMITS.depth) throw new Error('数据嵌套层级超限');
  if (typeof value === 'string') {
    // Keep serialized tool arguments valid JSON while redacting structured secret fields.
    if (/^\s*[\[{]/.test(value)) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { /* ordinary text */ }
      if (parsed && typeof parsed === 'object') {
        const clean = JSON.stringify(redact(parsed, depth + 1, seen));
        return clean.length > LIMITS.text ? clean.slice(0, LIMITS.text) + '\n[Pathway 截断：内容过长]' : clean;
      }
    }
    const clean = redactText(value);
    return clean.length > LIMITS.text ? clean.slice(0, LIMITS.text) + '\n[Pathway 截断：内容过长]' : clean;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value === undefined) return null;
  if (typeof value !== 'object') throw new Error('只支持 JSON 数据');
  if (seen.has(value)) throw new Error('数据包含循环引用');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > LIMITS.events) throw new Error('数组条目过多');
    result = value.map(v => redact(v, depth + 1, seen));
  } else {
    result = Object.create(null);
    for (const [key, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(v, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}
export function boundedJson(value) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > LIMITS.bytes) throw new Error('数据超过 8 MiB 限制');
  return text;
}
