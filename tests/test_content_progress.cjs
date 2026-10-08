const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function harness(){
  const timers=[]; const saved={nlrProgress:{}}; const writes=[];
  const storage={get:async key=>key==='nlrProgress'?{nlrProgress:saved.nlrProgress}:saved,set:async value=>{writes.push(value);Object.assign(saved,value);}};
  const scheduler={setInterval(fn){const id={fn};timers.push(id);return id;},clearInterval(id){const i=timers.indexOf(id);if(i>=0)timers.splice(i,1);}};
  const context={globalThis:null,setInterval:scheduler.setInterval,clearInterval:scheduler.clearInterval,Date,console};context.globalThis=context;
  vm.createContext(context);vm.runInContext(fs.readFileSync('content-progress.js','utf8'),context);
  return {create:context.NovelLocalReader.contentProgress.create,storage,scheduler,timers,writes};
}
const snapshot=Object.freeze({entries:Object.freeze([{text:'one',element:{id:1}},{text:'two',element:{id:2}}]),length:2});

test('progress activates valid indices and rejects stale or invalid ones',()=>{
  const h=harness();let events=[];const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:t=>t==='a',callbacks:{onActivate:e=>events.push(e)}});
  p.setDocument(snapshot,{},'a');assert.equal(p.activate(0,'a'),true);assert.equal(p.activate(9,'a'),false);assert.equal(p.activate(1,'b'),false);assert.equal(events.length,1);p.dispose();
});
test('timer is unique, brand-safe and idempotently stopped',()=>{
  const h=harness();const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true});p.setDocument(snapshot,{},'a');p.start('a');p.start('a');assert.equal(h.timers.length,1);p.stop();p.stop();assert.equal(h.timers.length,0);p.dispose();
});
test('writes are serialized and preserve latest progress',async()=>{
  const h=harness();const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true,context:{url:'x'}});p.setDocument(snapshot,{},'a');p.activate(0,'a');const first=p.save(true);p.activate(1,'a');await Promise.all([first,p.save(true)]);assert.equal(h.writes.length,2);assert.equal(p.currentIndex(),1);p.dispose();
});
test('dispose prevents later updates and snapshots remain private',()=>{
  const h=harness();const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true});p.setDocument(snapshot,{},'a');p.dispose();assert.equal(p.activate(0,'a'),false);assert.equal(p.inspect().disposed,true);
});
test('independent instances keep independent indices',()=>{const h=harness();const a=h.create({storage:h.storage,pageKey:()=> 'a',sessionValid:()=>true});const b=h.create({storage:h.storage,pageKey:()=> 'b',sessionValid:()=>true});a.setDocument(snapshot,{},'a');b.setDocument(snapshot,{},'b');a.activate(0,'a');b.activate(1,'b');assert.equal(a.currentIndex(),0);assert.equal(b.currentIndex(),1);});

test('visual callbacks run clear, apply, scroll and progress in order',()=>{
  const h=harness();const order=[];
  const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true,callbacks:{
    onClearHighlight:()=>order.push('clear'),onApplyHighlight:()=>order.push('apply'),
    onScroll:()=>order.push('scroll'),onProgress:()=>order.push('progress')}});
  p.setDocument(snapshot,{},'a');order.length=0;p.activate(0,'a');
  assert.deepEqual(order,['clear','apply','scroll','progress']);
  order.length=0;p.activate(0,'a');
  assert.deepEqual(order,['clear','apply','scroll','progress']);
});

test('empty snapshots, negative and out-of-range indices stay inactive',()=>{
  const h=harness();const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true});
  p.setDocument({entries:[]}, {}, 'a');assert.equal(p.currentIndex(),-1);
  assert.equal(p.activate(-1,'a'),false);assert.equal(p.activate(0,'a'),false);assert.equal(p.currentIndex(),-1);
});

test('document replacement clears the old visual and rejects the old token',()=>{
  const h=harness();const cleared=[];let current='a';
  const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:t=>t===current,
    callbacks:{onClearHighlight:entry=>cleared.push(entry?.text||null)}});
  p.setDocument(snapshot,{},'a');p.activate(1,'a');current='b';p.setDocument(snapshot,{},'b');
  assert.equal(cleared.at(-1),'two');assert.equal(p.currentIndex(),-1);assert.equal(p.activate(0,'a'),false);
});

test('visual callback failures do not corrupt the selected index',()=>{
  const h=harness();let errors=0;
  const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true,callbacks:{
    onClearHighlight(){throw new Error('visual');},onApplyHighlight(){throw new Error('visual');},
    onScroll(){throw new Error('visual');},onProgress(){throw new Error('visual');},onError(){errors+=1;}}});
  p.setDocument(snapshot,{},'a');assert.equal(p.activate(1,'a'),true);assert.equal(p.currentIndex(),1);assert.ok(errors>=4);
  p.dispose();p.dispose();assert.equal(p.activate(0,'a'),false);
});

test('restore selects the canonical record before aliases and migrates a valid alias',async()=>{
  const h=harness();
  h.storage.get=async()=>({nlrProgress:{legacy:{index:2,text:'legacy'},current:{index:1,text:'current'}}});
  h.storage.set=async value=>{h.writes.push(value);};
  const p=h.create({storage:h.storage,pageKey:()=> 'current',sessionValid:()=>true});
  p.setDocument(snapshot,{pageKey:'current',aliases:['legacy']},'a');
  const restored=await p.restore('a');
  assert.equal(restored.text,'current');assert.equal(h.writes.length,0);
});

test('a fresh controller can restore before its first document is installed',async()=>{
  const h=harness();h.storage.get=async()=>({nlrProgress:{page:{index:4,text:'five',currentTime:1.25}}});
  const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:t=>t===0});
  const restored=await p.restore(0,{pageKey:'page',aliases:[]});
  assert.equal(restored.index,4);assert.equal(p.resumeSnapshot().index,4);assert.equal(p.resumeSnapshot().currentTime,1.25);
  p.setDocument(snapshot,{pageKey:'page'},1);assert.equal(p.resumeSnapshot(),null);
});

test('restore migrates an alias only after successful storage write',async()=>{
  const h=harness();
  h.storage.get=async()=>({nlrProgress:{legacy:{index:0,text:'legacy'}}});
  h.storage.set=async value=>{h.writes.push(value);};
  const p=h.create({storage:h.storage,pageKey:()=> 'current',sessionValid:()=>true});
  p.setDocument(snapshot,{pageKey:'current',aliases:['legacy']},'a');
  const restored=await p.restore('a');
  assert.equal(restored.text,'legacy');assert.equal(h.writes.length,1);assert.ok(h.writes[0].nlrProgress.current);
});

test('malformed restore, stale token and dispose do not expose resume state',async()=>{
  const h=harness();h.storage.get=async()=>({nlrProgress:{current:{index:'bad',text:4}}});
  const p=h.create({storage:h.storage,pageKey:()=> 'current',sessionValid:t=>t==='a'});p.setDocument(snapshot,{pageKey:'current'},'a');
  assert.equal(await p.restore('b'),null);assert.equal(await p.restore('a'),null);p.dispose();assert.equal(await p.restore('a'),null);
});

test('complete serializes after pending saves, removes progress and records history',async()=>{
  const h=harness();
  let now=100;
  h.storage.get=async key=>key==='nlrProgress'?{nlrProgress:{current:{index:0,text:'old'},other:{index:1,text:'keep'}}}:{nlrHistory:[]};
  h.storage.set=async value=>{h.writes.push(value);};
  const p=h.create({storage:h.storage,clock:{now:()=>now++},pageKey:()=> 'current',sessionValid:()=>true,
    callbacks:{createHistory:meta=>({url:'current',completed:meta.completed,updatedAt:meta.updatedAt}),historyKey:entry=>entry.url}});
  p.setDocument(snapshot,{pageKey:'current',aliases:['legacy']},'a');p.activate(0,'a');await p.save(true);
  assert.equal(await p.complete('a'),true);assert.equal(h.writes.length,3);
  assert.equal(await p.complete('a'),true);
});

test('complete keeps unrelated pages and recovers after a storage failure',async()=>{
  const h=harness();let fail=true;
  h.storage.get=async key=>key==='nlrProgress'?{nlrProgress:{current:{index:0,text:'x'},other:{index:1,text:'y'}}}:{nlrHistory:[]};
  h.storage.set=async value=>{if(fail){fail=false;throw new Error('storage');}h.writes.push(value);};
  const p=h.create({storage:h.storage,pageKey:()=> 'current',sessionValid:()=>true,
    callbacks:{createHistory:meta=>({url:'current',completed:meta.completed}),historyKey:entry=>entry.url}});
  p.setDocument(snapshot,{pageKey:'current'},'a');p.activate(0,'a');await assert.rejects(p.complete('a'));
  assert.equal(await p.complete('a'),true);
});

test('complete enforces the private 500-entry history limit',async()=>{
  const h=harness();const oldHistory=Array.from({length:500},(_,index)=>({url:`old-${index}`,updatedAt:index}));
  let history=oldHistory;let phase=0;
  h.storage.get=async key=>key==='nlrProgress'?{nlrProgress:{}}:{nlrHistory:history};
  h.storage.set=async value=>{if(value.nlrHistory){history=value.nlrHistory;phase+=1;}};
  const p=h.create({storage:h.storage,pageKey:()=> 'current',sessionValid:()=>true,
    callbacks:{createHistory:meta=>({url:'new',completed:meta.completed,updatedAt:999}),historyKey:entry=>entry.url}});
  p.setDocument(snapshot,{pageKey:'current'},'a');await p.complete('a',{historyLimit:1});
  assert.equal(history.length,500);assert.equal(history[0].url,'new');assert.equal(history.at(-1).url,'old-498');
  assert.equal(phase,1);assert.equal(await p.complete('a'),true);assert.equal(phase,1);
});

test('complete uses local-document identity, rejects stale sessions, and preserves other history',async()=>{
  const h=harness();let current='a';let history=[{url:'local-document:other',completed:true}];
  h.storage.get=async key=>key==='nlrProgress'?{nlrProgress:{'local-document:book':{index:1}}}:{nlrHistory:history};
  h.storage.set=async value=>{h.writes.push(value);if(value.nlrHistory) history=value.nlrHistory;};
  const p=h.create({storage:h.storage,pageKey:()=> 'local-document:book',sessionValid:t=>t===current,
    callbacks:{createHistory:()=>({url:'local-document:book',completed:true}),historyKey:e=>e.url}});
  p.setDocument(snapshot,{pageKey:'local-document:book'},'a');current='b';
  assert.equal(await p.complete('a'),false);assert.equal(h.writes.length,0);
  p.setDocument(snapshot,{pageKey:'local-document:book'},'b');
  assert.equal(await p.complete('b'),true);assert.equal(history.length,2);
  assert.equal(history[0].url,'local-document:book');assert.equal(history[1].url,'local-document:other');
});

test('saved progress keeps only the 1000 most recent pages',async()=>{
  const h=harness();const old={};
  for(let i=0;i<1005;i+=1)old[`https://x.test/${i}`]={index:0,text:'t',updatedAt:i};
  await h.storage.set({nlrProgress:old});
  const p=h.create({storage:h.storage,pageKey:()=> 'page',sessionValid:()=>true,clock:{now:()=>5000}});
  p.setDocument(snapshot,{},'a');p.activate(0,'a');await p.save(true);
  const saved=(await h.storage.get('nlrProgress')).nlrProgress;
  assert.equal(Object.keys(saved).length,1000);
  assert.ok(saved.page);assert.equal(saved['https://x.test/5'],undefined);assert.ok(saved['https://x.test/6']);
  p.dispose();
});
