const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const modules=['content-runtime.js']
  .map(name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8')).join('\n');

function harness() {
  const context={crypto:{randomUUID:()=>`id-${Math.random()}`},AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console};
  context.globalThis=context; vm.createContext(context); vm.runInContext(modules,context);
  return context;
}

test('lifecycle cancels resources in order and is idempotent',()=>{
  const h=harness(); const runtime=h.NovelLocalReader.runtime.create(); const session=runtime.session; const life=runtime;
  const events=[]; life.register({dispose:()=>events.push('resource')});
  assert.equal(session.phase,'initializing'); session.activate(); assert.equal(session.phase,'active');
  assert.equal(life.dispose(),true); assert.equal(life.dispose(),false); assert.deepEqual(events,['resource']);
  assert.equal(session.beginDispose(),false); assert.equal(session.phase,'disposed');
});

test('resources registered after dispose are cleaned immediately',()=>{
  const h=harness(); const life=h.NovelLocalReader.runtime.create(); life.dispose();
  let cleaned=0; assert.equal(life.register({dispose:()=>cleaned++}),false); assert.equal(cleaned,1);
});

test('state cleanup continues after an exception and ends disposed',()=>{
  const h=harness(); const runtime=h.NovelLocalReader.runtime.create(); const session=runtime.session; session.activate();
  const events=[];
  session.register({dispose:()=>{events.push('bad'); throw new Error('private detail');}});
  session.register({dispose:()=>events.push('good')});
  session.beginDispose(); session.disposeResources();
  assert.deepEqual(events,['bad','good']); assert.equal(session.phase,'disposed');
  assert.equal(session.disposed,true);
});

test('namespace collision fails before partial module state',()=>{
  const context={NovelLocalReader:'occupied',crypto:{randomUUID:()=> 'x'},AbortController,console};
  vm.createContext(context);
  assert.throws(()=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..','content-runtime.js'),'utf8'),context),/ocupado/);
  assert.equal(typeof context.NovelLocalReader,'string');
});

test('lifecycle cleanup continues after an exception',()=>{
  const h=harness(); const life=h.NovelLocalReader.runtime.create(); const events=[];
  life.register({dispose:()=>{events.push('bad'); throw new Error('x');}});
  life.register({dispose:()=>events.push('good')});
  assert.doesNotThrow(()=>life.dispose()); assert.deepEqual(events,['bad','good']);
});

test('timeout and interval preserve the Window receiver for schedule and cancellation',()=>{
  const calls=[];const brand={};let next=0;
  const context={timerBrand:brand,crypto:{randomUUID:()=> 'timer'},AbortController,console,
    setTimeout(fn,ms){if(this.timerBrand!==brand)throw new TypeError('bad timeout receiver');calls.push(['setTimeout',ms]);return ++next;},
    setInterval(fn,ms){if(this.timerBrand!==brand)throw new TypeError('bad interval receiver');calls.push(['setInterval',ms]);return ++next;},
    clearTimeout(id){if(this.timerBrand!==brand)throw new TypeError('bad clearTimeout receiver');calls.push(['clearTimeout',id]);},
    clearInterval(id){if(this.timerBrand!==brand)throw new TypeError('bad clearInterval receiver');calls.push(['clearInterval',id]);}}
  context.globalThis=context;vm.createContext(context);vm.runInContext(modules,context);
  const runtime=context.NovelLocalReader.runtime.create();
  assert.equal(runtime.timer('timeout',()=>{},100),1);assert.equal(runtime.timer('interval',()=>{},200),2);
  runtime.dispose();assert.deepEqual(calls,[['setTimeout',100],['setInterval',200],['clearTimeout',1],['clearInterval',2]]);
});

test('messaging rejects after dispose and never exposes session state',async()=>{
  const h=harness(); let calls=0; const runtime=h.NovelLocalReader.runtime.create({browser:{runtime:{sendMessage:async m=>{calls++; return {ok:true,scope:m.scope};}}}});
  const result=await runtime.send({type:'health'}); assert.equal(result.ok,true); assert.equal(calls,1);
  runtime.dispose(); await assert.rejects(runtime.send({type:'health'})); assert.equal(calls,1);
});

test('messaging does not retry non-transient failures',async()=>{
  const h=harness(); let calls=0; let reconnects=0; const runtime=h.NovelLocalReader.runtime.create({onReconnect:()=>reconnects++,browser:{runtime:{sendMessage:async()=>{calls++; throw new Error('bad request');}}}});
  await assert.rejects(runtime.send({type:'unknown'}),/bad request/); assert.equal(calls,1); assert.equal(reconnects,0); runtime.dispose();
});

test('authentication/configuration failures do not show a reconnect notice',async()=>{
  const h=harness(); let reconnects=0; const runtime=h.NovelLocalReader.runtime.create({onReconnect:()=>reconnects++,browser:{runtime:{sendMessage:async()=>{throw new Error('token ausente');}}}});
  await assert.rejects(runtime.send({type:'health'}),/token ausente/); assert.equal(reconnects,0); runtime.dispose();
});

test('invalidated extension context notifies exactly once without retry',async()=>{
  const h=harness(); let calls=0; let reconnects=0; const runtime=h.NovelLocalReader.runtime.create({onReconnect:()=>reconnects++,browser:{runtime:{sendMessage:async()=>{calls++; throw new Error('Extension context invalidated.');}}}});
  await assert.rejects(runtime.send({type:'health'}),/invalidated/); assert.equal(calls,1); assert.equal(reconnects,1); runtime.dispose();
});

test('missing receiver retries and reconnects only after exhaustion',async()=>{
  const h=harness(); let calls=0; let reconnects=0; const runtime=h.NovelLocalReader.runtime.create({onReconnect:()=>reconnects++,browser:{runtime:{sendMessage:async()=>{calls++; throw new Error('Receiving end does not exist');}}}});
  await assert.rejects(runtime.send({type:'health'}),/Receiving end/); assert.equal(calls,3); assert.equal(reconnects,1); runtime.dispose();
});

test('missing receiver followed by success does not reconnect',async()=>{
  const h=harness(); let calls=0; let reconnects=0; const runtime=h.NovelLocalReader.runtime.create({onReconnect:()=>reconnects++,browser:{runtime:{sendMessage:async()=>{calls++; if(calls===1) throw new Error('message port closed'); return {ok:true};}}}});
  assert.deepEqual(await runtime.send({type:'health'}),{ok:true}); assert.equal(calls,2); assert.equal(reconnects,0); runtime.dispose();
});

test('dispose during transport retry cancels the delay without reconnect notice',async()=>{
  const h=harness(); let reconnects=0; const runtime=h.NovelLocalReader.runtime.create({onReconnect:()=>reconnects++,browser:{runtime:{sendMessage:async()=>{throw new Error('Receiving end does not exist');}}}});
  const pending=runtime.send({type:'health'}); runtime.dispose(); await assert.rejects(pending,/Sessão encerrada/); assert.equal(reconnects,0); runtime.dispose();
});
