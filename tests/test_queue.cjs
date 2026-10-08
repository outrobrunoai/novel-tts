const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
require(path.join(root,'queue.js'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('single worker, priority and deduplication',async()=>{
  const calls=[]; const resolvers=[];
  const q=new SynthesisQueue(payload=>new Promise(resolve=>{calls.push(payload);resolvers.push(resolve);}));
  const a=q.enqueue('tab','s',{text:'a'},0);
  const b=q.enqueue('tab','s',{text:'b'},-1);
  const c=q.enqueue('tab','s',{text:'c'},1);
  assert.equal(q.enqueue('tab','s',{text:'b'},-1),b);
  assert.equal(calls.length,1);
  resolvers.shift()('a');await tick();
  assert.deepEqual(calls[1],{text:'c'});
  resolvers.shift()('c');await tick();resolvers.shift()('b');
  await Promise.all([a,b,c]);
  assert.equal(calls.length,3);
});
test('cancellation aborts active request and rejects pending and stale requests',async()=>{
  let signal;
  const q=new SynthesisQueue((_,s)=>new Promise((resolve,reject)=>{
    signal=s;s.addEventListener('abort',()=>reject(new Error('aborted')));
  }));
  const a=q.enqueue('tab','s',{text:'a'}).catch(e=>e.message);
  const b=q.enqueue('tab','s',{text:'b'}).catch(e=>e.message);
  q.cancel('tab','s');
  assert.equal(signal.aborted,true);
  assert.match(await a,/cancelada/);assert.match(await b,/cancelada/);
  await assert.rejects(q.enqueue('tab','s',{text:'c'}),/cancelada/);
});
test('bounded queue and independent tabs',async()=>{
  let finish;
  const q=new SynthesisQueue(()=>new Promise(r=>finish=r),1);
  const a=q.enqueue('a','s',{}).catch(()=>{});
  const b=q.enqueue('b','s',{}).catch(()=>{});
  await assert.rejects(q.enqueue('c','s',{}),/cheia/);
  q.cancel('b'); assert.equal(q.pending.length,0);
  finish('ok'); await Promise.all([a,b]);
});
test('worker failure does not block the next request',async()=>{
  let count=0;const q=new SynthesisQueue(async()=>{if(++count===1)throw new Error('offline');return 'ok';});
  const a=q.enqueue('t','s',{n:1}).catch(e=>e.message);
  const b=q.enqueue('t','s',{n:2});
  assert.equal(await a,'offline');assert.equal(await b,'ok');
});
test('panel IDs, themes, tab controls and manifest assets are consistent',()=>{
  const content=fs.readFileSync(path.join(root,'content-panel.js'),'utf8');
  const ids=[...content.matchAll(/id="(nlr-[\w-]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
  const selectors=[...content.matchAll(/query\(["']#(nlr-[\w-]+)["']\)/g)].map(m=>m[1]);
  for(const id of selectors)assert.ok(ids.includes(id),id);
  assert.equal([...content.matchAll(/data-theme-choice="/g)].length,6);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
  const declared=[...manifest.background.scripts,...manifest.web_accessible_resources[0].resources,
    ...Object.values(manifest.icons),manifest.action.default_icon,manifest.options_ui.page,
    'content-panel.js','content.js','page-overlay.css'];
  for(const file of declared)assert.ok(fs.existsSync(path.join(root,file)),file);
});
test('no blanket content script; broad host access is optional only',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
  assert.equal(manifest.content_scripts,undefined);
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1:8081/*']);
  assert.deepEqual(manifest.optional_host_permissions,['http://*/*','https://*/*']);
  const background=fs.readFileSync(path.join(root,'background.js'),'utf8');
  assert.match(background,/registerContentScripts/);
  assert.match(background,/permissions\.getAll/);
});
test('the panel is isolated in a shadow root and only the highlight touches the page',()=>{
  const content=fs.readFileSync(path.join(root,'content-panel.js'),'utf8');
  assert.match(content,/attachShadow\(\{mode: 'closed'\}\)/);
  assert.ok(!/document\.documentElement\.appendChild\(element\)/.test(content));
  const overlay=fs.readFileSync(path.join(root,'page-overlay.css'),'utf8');
  assert.match(overlay,/nlr-reading-paragraph/);
  const panelCss=fs.readFileSync(path.join(root,'content.css'),'utf8');
  assert.ok(!/^\.nlr-reading-paragraph/m.test(panelCss));
});
