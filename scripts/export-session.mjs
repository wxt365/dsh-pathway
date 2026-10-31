import { readFile, writeFile } from 'node:fs/promises';
import { normalizeHarnessEvents, exportTrace } from '../src/core.js';
import { LIMITS } from '../src/security.js';
const [input, output, sessionId = 'imported-session'] = process.argv.slice(2);
if (!input || !output || input === output) {
  console.error('Usage: node scripts/export-session.mjs <events.json|session.jsonl> <new-trace.json> [sessionId]');
  process.exitCode = 1;
} else {
  try {
    const buffer = await readFile(input);
    if (buffer.byteLength > LIMITS.bytes) throw new Error('输入超过 8 MiB');
    const text = buffer.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
    const events = Array.isArray(parsed) ? parsed : parsed.events;
    const trace = normalizeHarnessEvents(events, { sessionId, title: sessionId, origin: 'import' });
    // Exclusive create avoids replacing existing user data.
    await writeFile(output, exportTrace(trace), { flag: 'wx' });
    console.log(`Converted ${trace.nodes.length} tool calls. Review redaction before sharing.`);
  } catch (error) {
    console.error(`转换失败：${error.code === 'EEXIST' ? '输出已存在，请换一个新文件名' : error.message}`);
    process.exitCode = 1;
  }
}
