import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const cordisFile = new URL('../.harness-reference-current/cordis/lib/index.js', import.meta.url);
const cosmokitFile = new URL('../.harness-reference-current/cosmokit/lib/index.js', import.meta.url);
const bundleFile = new URL('../dist/client.js', import.meta.url);
const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;

async function actualCordis(t) {
  try { await Promise.all([access(cordisFile), access(cosmokitFile)]); }
  catch { t.skip('Local extracted Harness runtime is unavailable; no substitute mock runtime is used.'); return; }
  const cosmokit = dataModule(await readFile(cosmokitFile, 'utf8'));
  const cordis = (await readFile(cordisFile, 'utf8')).replace('"@deepseek-ai/cosmokit"', JSON.stringify(cosmokit));
  return import(dataModule(cordis));
}

async function clientFactory(t, document) {
  try { await access(bundleFile); }
  catch { t.skip('Build dist/client.js before running the local integration checks.'); return; }
  let registration;
  vm.runInNewContext(await readFile(bundleFile, 'utf8'), {
    window: { __ModuleLoader__: { load(row) { registration = row; } } },
    document,
  });
  assert.equal(registration.id, 'dsh-pathway');
  return registration;
}

test('actual Cordis waits for client services and accepts the built object plugin and slot metadata', async t => {
  const runtime = await actualCordis(t);
  if (!runtime) return;
  const registration = await clientFactory(t, {
    createElement() { return { textContent: '', remove() {} }; },
    head: { append() {} },
  });
  if (!registration) return;
  const plugin = registration.factory(id => {
    assert.equal(id, 'react');
    return { createElement(tag, props) { return { tag, props }; }, useRef() { return { current: null }; }, useEffect() {} }; // Effects remain fixtures.
  });
  const ctx = new runtime.Context();
  const contributions = [];
  const waits = [];
  // A declaration fixture, not the real renderer: lifecycle is real Cordis,
  // while exact slot metadata is independently checked against shipped sources.
  ctx.provide('slots', {
    inject(slot, callback) { waits.push(slot); return callback(); },
    register(options, component) { contributions.push({ options, component }); return () => {}; },
  });
  const fiber = ctx.plugin(plugin);
  await fiber.await();
  assert.equal(contributions.length, 0, 'missing layout service keeps the real fiber pending');
  ctx.provide('layout', {});
  await fiber.await();
  assert.equal(fiber.state, 2, 'real Cordis FiberState.ACTIVE');
  assert.deepEqual(waits, ['conversation.view', 'main', 'sidebar.panellist']);
  assert.deepEqual(JSON.parse(JSON.stringify(contributions.map(row => row.options))), [
    { name: 'conversation.view', id: 'pathway', order: 25, label: '执行链路' },
    { name: 'main', key: 'pathway' },
    { name: 'sidebar.panellist', id: 'pathway', order: 35, label: '执行链路' },
  ]);
  assert.equal(contributions[0].options.inject('current-session').pathwaySessionId, 'current-session');
  const icon = contributions[2].component();
  assert.equal(icon.tag, 'svg');
  assert.equal(icon.props.width, 20);
  assert.equal(icon.props.stroke, 'currentColor');
  assert.equal(icon.props.fill, 'none');
  const panel = contributions[1].component();
  assert.equal(panel.props.style.overflowY, 'auto', 'host shell hides overflow; panel must own page scrolling');
  assert.equal(panel.props.style.height, '100%');
  fiber.dispose();
  await fiber.await();
  assert.notEqual(fiber.state, 2);
});

test('built lazy client installs and disposes CSS through an actual Cordis effect', async t => {
  const runtime = await actualCordis(t);
  if (!runtime) return;
  const styles = new Set();
  const document = {
    createElement(tag) {
      assert.equal(tag, 'style');
      return { textContent: '', remove() { styles.delete(this); } };
    },
    head: { append(style) { styles.add(style); } },
  };
  const registration = await clientFactory(t, document);
  if (!registration) return;
  assert.equal(styles.size, 0, 'lazy factory registration must not inject CSS');
  const plugin = registration.factory(id => {
    assert.equal(id, 'react');
    return { createElement() {} };
  });
  assert.equal(styles.size, 0, 'materialization must not inject effect-owned CSS');
  const ctx = new runtime.Context();
  ctx.provide('slots', { inject() {} });
  ctx.provide('layout', {});
  const fiber = ctx.plugin(plugin);
  try {
    await fiber.await();
    assert.equal(styles.size, 1, 'apply must install CSS (getter-only exports cannot be reassigned)');
    assert.ok([...styles][0].textContent.includes('.pw-'));
  } finally {
    fiber.dispose();
    await fiber.await();
  }
  assert.equal(styles.size, 0, 'real fiber disposal removes the CSS');
});
