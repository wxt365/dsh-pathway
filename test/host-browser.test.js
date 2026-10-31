import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { normalizeHarnessEvents } from '../src/core.js';
import { readFile } from 'node:fs/promises';

// Real Chrome/native viewer, mocked loaders: not a claim of authenticated GUI E2E.
test('known size failures automatically load recent once, recent refresh persists, switching resets and partial history stays visible', async()=>{
  const bundle=await build({entryPoints:['src/viewer.js'],bundle:true,write:false,format:'iife',globalName:'Pathway'});
  const browser=await chromium.launch({executablePath:process.env.PATHWAY_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<div id="app"></div>');
    await page.addStyleTag({content:await readFile('src/viewer.css','utf8')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const trace=normalizeHarnessEvents([{seq:0,type:'assistant/message',data:{turn:1,message:{id:'r',content:[{type:'text',text:'ordinary reply without registration'}]}}}],{sessionId:'large'});
    await page.evaluate(trace=>{
      window.loads=[];
      Pathway.mountViewer(document.querySelector('#app'),{
        embedded:true,sessionId:'large',
        loadSessions:async()=>[{id:'large'},{id:'other'}],
        loadTrace:async(id,options)=>{
          window.loads.push([id,options??null]);
          if(id==='large' && options?.window!=='recent') throw Object.assign(new Error('记录超过安全加载上限（413）'),{status:413,code:'HISTORY_TOO_LARGE'});
          return {...trace,id,snapshot:options?.window==='recent'?{window:'recent',omittedEventCount:1200,truncation:{history:true}}:{window:'full'}};
        }
      });
    },trace);
    const recovery=page.getByRole('button',{name:'加载近期记录（非完整历史）',exact:true});
    await page.locator('.pw-history-window').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.loads),[['large',null],['large',{window:'recent'}]]);
    assert.equal(await recovery.count(),0);
    await page.locator('.pw-history-window').waitFor();
    assert.match(await page.locator('.pw-history-window').textContent(),/非完整历史.*1200/);
    assert.equal(await page.locator('.pw-record-info').getAttribute('open'),null);
    assert.equal(await page.locator('.pw-history-window').isVisible(),true);
    assert.match(await page.locator('.pw-stat-scope').textContent(),/当前回复统计/);
    await page.locator('.pw-scope-select').selectOption('snapshot');
    assert.match(await page.locator('.pw-stat-scope').textContent(),/当前窗口及引用补取统计/);
    await page.locator('.pw-scope-select').selectOption('reply');
    assert.match(await page.locator('.pw-reply-select option:checked').textContent(),/近期回复 1 · Turn 1/);
    assert.match(await page.locator('.pw-result-count').textContent(),/当前图.*当前窗口/);
    assert.equal(await page.getByRole('button',{name:'执行过程',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'显式证据',exact:true}).click();
    assert.equal(await page.locator('.pw-evidence-empty').isVisible(),true);
    assert.equal(await page.locator('.pw-plan-card[data-kind="missing"]').count(),0);
    assert.match(await page.locator('.pw-evidence-empty').textContent(),/引用范围未完整加载/);
    await page.getByRole('button',{name:'查看执行过程',exact:true}).click();
    assert.equal(await page.locator('.pw-evidence-empty').count(),0);
    await page.getByRole('button',{name:'显式证据',exact:true}).click();
    await page.getByRole('button',{name:'↻ 刷新会话',exact:true}).click();
    await page.waitForFunction(()=>window.loads.length===3);
    // Exercise the same change handler used by the standalone session chooser.
    await page.locator('.pw-session-select').evaluate(select=>{select.value='other';select.dispatchEvent(new Event('change'));});
    await page.waitForFunction(()=>window.loads.length===4);
    assert.deepEqual(await page.evaluate(()=>window.loads),[['large',null],['large',{window:'recent'}],['large',{window:'recent'}],['other',null]]);
    assert.equal(await page.locator('.pw-history-window').count(),0);
    assert.equal(await page.getByRole('button',{name:'执行过程',exact:true}).getAttribute('aria-pressed'),'true');
    await page.locator('.pw-session-select').evaluate(select=>{select.value='large';select.dispatchEvent(new Event('change'));});
    await page.locator('.pw-history-window').waitFor();
    await page.waitForFunction(()=>window.loads.length===6);
    // A failed recent request remains a failure, without another recovery loop.
    await page.evaluate(()=>{
      document.querySelector('#app').replaceChildren();
      Pathway.mountViewer(document.querySelector('#app'),{
        sessionId:'oversized',loadSessions:async()=>[{id:'oversized'}],
        loadTrace:async(_id,options)=>{throw Object.assign(new Error('记录超过安全上限'),{status:413,code:options?.window==='recent'?'RECENT_EVENT_TOO_LARGE':'HISTORY_TOO_LARGE'});}
      });
    });
    await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('近期记录也超过安全加载上限'));
    assert.equal(await recovery.count(),0);
    assert.deepEqual(await page.locator('.pw-stat-value').allTextContents(),Array(4).fill('未加载'));
    // Only 413 offers recovery; ordinary errors never do.
    await page.evaluate(()=>{
      document.querySelector('#app').replaceChildren();
      Pathway.mountViewer(document.querySelector('#app'),{
        loadSessions:async()=>[{id:'unauthorized'}],
        loadTrace:async()=>{throw Object.assign(new Error('unauthorized'),{status:401,code:'HTTP_401'});}
      });
    });
    await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent.includes('unauthorized'));
    assert.equal(await recovery.count(),0);
  } finally { await browser.close(); }
});

test('client opts in to recent query and safely reports 413 diagnostics without login hints', async()=>{
  const bundle=await build({entryPoints:['src/client.js'],bundle:true,write:false,format:'iife',globalName:'Client',plugins:[{
    name:'react-test-stub',setup(build){
      build.onResolve({filter:/^react$/},()=>({path:'react',namespace:'stub'}));
      build.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export default {createElement(){},useRef(){return {current:document.querySelector("#app")}},useEffect(fn){fn()}}'}));
    }
  }]});
  const browser=await chromium.launch({executablePath:process.env.PATHWAY_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try {
    const page=await browser.newPage();
    const trace=normalizeHarnessEvents([{seq:0,type:'assistant/message',data:{turn:1,message:{id:'r',content:[{type:'text',text:'ordinary reply without registration'}]}}}],{sessionId:'large'});
    await page.route('http://pathway.test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="app"></div>'}));
    await page.goto('http://pathway.test/');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(trace=>{
      window.requests=[];
      window.fetch=async(url,options)=>{
        window.requests.push([url,options.credentials]);
        if(url==='api/pathway/sessions') return new Response(JSON.stringify({sessions:[{id:'large'}]}));
        if(url.includes('window=recent')) return new Response(JSON.stringify({...trace,snapshot:{window:'recent',omittedEventCount:42}}));
        return new Response(JSON.stringify({error:'HISTORY_TOO_LARGE',reason:'history-bytes',limits:{historyBytes:8388608,unsafe:'<script>alert(1)</script>'}}),{status:413});
      };
      Client.apply({slots:{inject(name,fn){fn()},register(options,component){if(options.key==='pathway') component()}},layout:{}});
    },trace);
    const recovery=page.getByRole('button',{name:'加载近期记录（非完整历史）',exact:true});
    await page.locator('.pw-history-window').waitFor();
    assert.equal(await recovery.count(),0);
    assert.equal(await page.getByRole('alert').count(),0);
    assert.deepEqual(await page.evaluate(()=>window.requests),[['api/pathway/sessions','same-origin'],['api/pathway/trace?sessionId=large','same-origin'],['api/pathway/trace?sessionId=large&window=recent','same-origin']]);
    await page.locator('.pw-history-window').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.requests.at(-1)),['api/pathway/trace?sessionId=large&window=recent','same-origin']);
    await page.getByRole('button',{name:'↻ 刷新会话',exact:true}).click();
    await page.waitForFunction(()=>window.requests.length===5);
    assert.equal(await page.evaluate(()=>window.requests.at(-1)[0]),'api/pathway/trace?sessionId=large&window=recent');
  } finally { await browser.close(); }
});

test('host viewer accepts cold metadata-only session rows, lineage, reply location and refresh', async()=>{
  const bundle=await build({entryPoints:['src/viewer.js'],bundle:true,write:false,format:'iife',globalName:'Pathway'});
  const browser=await chromium.launch({executablePath:process.env.PATHWAY_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  try{
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    // Match the host's constrained main slot, not an unconstrained document.
    await page.setContent('<style>html,body{height:100%;margin:0;overflow:hidden}#shell{height:100%;overflow:hidden}#app{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden}</style><div id="shell"><div id="app"></div></div>');
    await page.addStyleTag({content:await readFile('src/viewer.css','utf8')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const trace=normalizeHarnessEvents([
      {seq:0,type:'turn/start',data:{turn:1}},
      {seq:1,type:'assistant/message',data:{turn:1,message:{id:'a',content:[{type:'text',text:'first'}]}}},
      {seq:2,type:'assistant/message',data:{turn:1,message:{id:'b',content:[{type:'text',text:'second'}]}}}
    ],{sessionId:'parent'});
    await page.evaluate(trace=>{
      window.loads=[];
      window.dispose=Pathway.mountViewer(document.querySelector('#app'),{
        sessionId:'parent',replyId:'parent:reply:a',
        loadSessions:async()=>[{id:'parent',live:false,persisted:true},{id:'child',live:false,persisted:true,parentSessionId:'parent',origin:'subagent'}],
        loadTrace:async id=>{window.loads.push(id);return {...trace,id,snapshot:{capturedAt:'2026-10-31T00:00:00Z',eventCount:3,firstSeq:0,lastSeq:2,coverage:'read-complete',...(id==='child'?{parentSessionId:'parent'}:{})}};}
      });
    },trace);
    await page.locator('.pw-reply-select').waitFor();
    assert.equal(await page.locator('.pw-reply-select').inputValue(),'parent:reply:a');
    const app=page.locator('#app');
    assert.equal(await app.evaluate(v=>v.scrollHeight>v.clientHeight),true);
    await app.evaluate(v=>v.scrollTop=v.scrollHeight);
    assert.ok(await app.evaluate(v=>v.scrollTop)>0);
    assert.equal(await page.locator('.pw-footer').evaluate(v=>{const r=v.getBoundingClientRect();return r.bottom<=innerHeight+1&&r.top>=0;}),true);
    await app.evaluate(v=>v.scrollTop=0);
    await page.mouse.move(20,200); await page.mouse.wheel(0,500);
    await page.waitForFunction(()=>document.querySelector('#app').scrollTop>0);
    await app.evaluate(v=>v.scrollTop=0);
    await page.getByRole('button',{name:'↻ 刷新会话',exact:true}).click();
    assert.equal(await page.locator('.pw-reply-select').inputValue(),'parent:reply:a');
    assert.equal(await page.locator('.pw-snapshot').count(),1);
    await page.getByRole('button',{name:'子会话：child',exact:true}).click();
    await page.getByRole('button',{name:'← 返回父会话',exact:true}).waitFor();
    assert.equal(await page.locator('.pw-session-select').inputValue(),'child');
    await page.getByRole('button',{name:'← 返回父会话',exact:true}).click();
    await page.getByRole('button',{name:'子会话：child',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.loads),['parent','parent','child','parent']);
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.dispose());
    await page.evaluate(trace=>{
      Pathway.mountViewer(document.querySelector('#app'), {
        embedded:true, sessionId:'parent',
        loadSessions:async()=>[{id:'parent'}],
        loadTrace:async()=>({...trace,snapshot:{capturedAt:'2026-10-31T00:00:00Z',eventCount:3,coverage:'read-complete'}})
      });
    },trace);
    await page.locator('.pw-plan-viewport').waitFor();
    assert.equal(await page.locator('.pw-intro').isVisible(),false);
    assert.equal(await page.locator('.pw-identity').isVisible(),true);
    assert.equal(await page.locator('.pw-logo').isVisible(),true);
    assert.equal(await page.locator('.pw-session-select').isVisible(),false);
    assert.equal(await page.locator('.pw-snapshot').isVisible(),false);
    const layout=await page.locator('.pw-scope-bar').evaluate(bar=>{
      const label=bar.children[0].getBoundingClientRect(),scope=bar.children[1].getBoundingClientRect(),reply=bar.children[2].getBoundingClientRect();
      const stats=bar.parentElement.querySelector('.pw-stats');
      return {gap:scope.left-label.right,scopeWidth:scope.width,replyGap:reply.left-scope.right,statsHeight:stats.getBoundingClientRect().height,statBorder:getComputedStyle(stats.querySelector('.pw-stat')).borderTopWidth};
    });
    assert.ok(layout.gap<20 && layout.replyGap<20);
    assert.ok(layout.scopeWidth<=200);
    assert.ok(layout.statsHeight<60);
    assert.equal(layout.statBorder,'0px');
    await page.screenshot({path:'artifacts/pathway-embedded-toolbar.png',fullPage:true});
    const top=await page.locator('.pw-plan-viewport').evaluate(v=>v.getBoundingClientRect().top);
    assert.ok(top<420, `embedded graph starts too low: ${top}px`);
    await page.locator('.pw-record-info > summary').click();
    assert.equal(await page.locator('.pw-snapshot').isVisible(),true);
    await page.locator('.pw-boundary > summary').click();
    assert.equal(await page.locator('.pw-boundary ul').isVisible(),true);
  }finally{await browser.close();}
});
