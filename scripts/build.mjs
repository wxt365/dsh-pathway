import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const css = await readFile('src/viewer.css', 'utf8');
const result = await build({ entryPoints: ['src/client.js'], bundle: true, write: false, format: 'cjs', platform: 'browser', external: ['react'], target: 'es2022' });
// Same lazy factory protocol as the installed Harness client plugins. CSS is fiber-owned.
const factory = `window.__ModuleLoader__.load({id:"dsh-pathway",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nconst applyBody=module.exports.apply;return {...module.exports,apply(ctx){ctx.effect(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);return()=>style.remove();},'pathway: styles');return applyBody(ctx);}};}});\n`;
await writeFile('dist/client.js', factory);
const offline = await build({ stdin: { contents: "import {mountViewer} from './src/viewer.js'; mountViewer(document.getElementById('app'));", resolveDir: process.cwd(), sourcefile: 'offline.js' }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
await writeFile('dist/pathway.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Pathway · 执行链路与证据溯源</title><style>html,body,#app{margin:0;height:100%;}*{box-sizing:border-box}${css}</style><div id="app"></div><script>${offline.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></html>`);
console.log('Built dist/client.js and self-contained dist/pathway.html');
