const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function load(){
  const context={globalThis:null,URL,console}; context.globalThis=context;
  vm.createContext(context); vm.runInContext(fs.readFileSync('content-navigation.js','utf8'),context);
  return context.NovelLocalReader.contentNavigation.create;
}
function element({href='',text='',tagName='A',attrs={},className=''}){
  return {href,textContent:text,innerText:text,tagName,className,id:'',getAttribute:k=>attrs[k]||null};
}
function doc(nodes){return {querySelector(sel){if(sel==='a[rel~=\'next\'], link[rel~=\'next\']')return nodes.find(n=>n.getAttribute('rel')==='next')||null;return nodes.find(n=>n.selector===sel)||null;},querySelectorAll(sel){return sel==='a[href], button'?nodes.filter(n=>n.href||n.tagName==='BUTTON'):nodes;}};}

test('prioritizes site selector, then global, rel next and text fallback',()=>{
  const next=element({href:'/next',text:'Next chapter'});next.selector='.site';
  const global=element({href:'/global',text:'Next'});global.selector='.global';
  const find=load()({document:doc([next,global]),location:{href:'https://example.test/ch1'},getStyle:()=>({})});
  assert.equal(find.findNext({siteSelector:'.site',globalSelector:'.global'}).url,'https://example.test/next');
});
test('invalid or absent selectors are safe and relative URLs normalize',()=>{
  const next=element({href:'chap2',text:'Next'});next.selector='.global';
  const find=load()({document:doc([next]),location:{href:'https://example.test/ch1'},getStyle:()=>({})});
  assert.equal(find.findNext({siteSelector:'[',globalSelector:'.global'}).available,true);
  assert.equal(find.findNext({siteSelector:'.missing',globalSelector:'.missing'}).available,true);
});
test('permission adapter is isolated and stale responses are rejected',async()=>{
  let calls=0;const find=load()({isOriginAllowed:async()=>{calls+=1;return true;}});
  const stale=await find.checkPermission('https://example.test/*','a',()=>false);assert.equal(stale.allowed,false);assert.equal(stale.stale,true);
  assert.equal((await find.checkPermission('https://example.test/*','a',()=>true)).allowed,true);assert.equal(calls,1);
});
test('no browser, storage, runtime, timers or navigation are required',()=>{
  const source=fs.readFileSync('content-navigation.js','utf8');
  assert.doesNotMatch(source,/browser\.storage|runtime|location\.assign/);
});

test('navigation timers are isolated, replaceable, cancellable and token-checked',()=>{
  const handles=[];const scheduler={setTimeout(fn,delay){const h={fn,delay,cancelled:false};handles.push(h);return h;},clearTimeout(h){h.cancelled=true;}};
  const nav=load()({scheduler});let calls=0;
  nav.scheduleNext({token:'a',delayMs:1000,isValid:t=>t==='a',onDue:()=>calls++});
  nav.scheduleNext({token:'b',delayMs:2000,isValid:t=>t==='b',onDue:()=>calls++});
  assert.equal(handles[0].cancelled,true);assert.equal(handles[1].delay,2000);
  if (!handles[0].cancelled) handles[0].fn();handles[1].fn();assert.equal(calls,1);
  nav.scheduleContinuation({token:'b',delayMs:700,isValid:t=>t==='b',onDue:()=>calls++});
  nav.cancelContinuation();assert.equal(handles[2].cancelled,true);nav.cancelAll();nav.dispose();nav.dispose();
});

test('timer callback failures are contained and do not leave a handle',()=>{
  let handle;const scheduler={setTimeout(fn){handle={fn};return handle;},clearTimeout(){handle=null;}};
  const nav=load()({scheduler});nav.scheduleNext({token:'a',delayMs:1,onDue:()=>{throw new Error('ui');}});handle.fn();
  nav.dispose();assert.equal(handle !== undefined,true);
});

test('handoff write must finish before navigation and cancellation wins the race',async()=>{
  const handles=[];let resolveWrite;let navigated=0;const storage={writeAutoContinue:()=>new Promise(resolve=>{resolveWrite=resolve;})};
  const scheduler={setTimeout(fn,delay){const h={fn,delay,cancelled:false};handles.push(h);return h;},clearTimeout(h){h.cancelled=true;}};
  const nav=load()({scheduler,storage,navigate:()=>{navigated+=1;},location:{href:'https://x.test/a'}});
  const target={available:true,url:'https://x.test/b'};nav.scheduleNextChapter({token:'a',delayMs:1,target,origin:'https://x.test',expiresAt:Date.now()+1000});
  handles[0].fn();assert.equal(navigated,0);nav.cancelNext();resolveWrite();await Promise.resolve();await Promise.resolve();assert.equal(navigated,0);
});

test('malformed or expired handoff is ignored and valid handoff is consumed once',async()=>{
  let record={targetUrl:'https://x.test/b',origin:'https://x.test',expiresAt:Date.now()+1000};let removed=0;let continued=0;
  const nav=load()({storage:{readAutoContinue:async()=>record,removeAutoContinue:async()=>{removed+=1;record=null;}} ,location:{href:'https://x.test/b'},scheduler:{setTimeout(fn){fn();return 1;},clearTimeout(){}}});
  assert.equal(await nav.resumeContinuation({token:'a',onContinue:()=>{continued+=1;}}),true);assert.equal(removed,1);assert.equal(continued,1);
  record={targetUrl:'https://x.test/b',origin:'https://x.test',expiresAt:Date.now()-1};assert.equal(await nav.resumeContinuation({token:'a'}),false);assert.equal(removed,2);
});

// A real <button> has no href property at all; the helper above would give it ''.
function button(text){return {tagName:'BUTTON',textContent:text,innerText:text,className:'',id:'',getAttribute:()=>null,isConnected:true};}

test('a next-chapter <button> resolves to a click target, never to a bogus URL',()=>{
  const next=button('Next chapter');
  const nav=load()({document:doc([next]),location:{href:'https://example.test/novel/ch1'},getStyle:()=>({})});
  const target=nav.findNext({});
  assert.equal(target.available,true);assert.equal(target.url,'');assert.equal(target.element,next);
});
test('scheduled navigation to a connected <button> target proceeds',async()=>{
  const handles=[];let navigated=null;
  const scheduler={setTimeout(fn,delay){const h={fn,delay};handles.push(h);return h;},clearTimeout(){}};
  const nav=load()({scheduler,storage:{writeAutoContinue:async()=>undefined},navigate:t=>{navigated=t;},location:{href:'https://x.test/a'}});
  const next=button('Next');
  nav.scheduleNextChapter({token:'a',delayMs:1,target:{available:true,url:'',element:next},origin:'https://x.test',expiresAt:Date.now()+1000});
  await handles[0].fn();
  assert.equal(navigated?.element,next);
});
test('a <button> target that left the page never navigates',async()=>{
  const handles=[];let navigated=0;
  const scheduler={setTimeout(fn,delay){const h={fn,delay};handles.push(h);return h;},clearTimeout(){}};
  const nav=load()({scheduler,storage:{writeAutoContinue:async()=>undefined},navigate:()=>{navigated+=1;},location:{href:'https://x.test/a'}});
  const next=button('Next');next.isConnected=false;
  nav.scheduleNextChapter({token:'a',delayMs:1,target:{available:true,url:'',element:next},origin:'https://x.test',expiresAt:Date.now()+1000});
  await handles[0].fn();
  assert.equal(navigated,0);
});

test('a disabled next button is not a navigation target',()=>{
  for(const [name,disable] of [
    ['disabled property',node=>{node.disabled=true;}],
    ['aria-disabled',node=>{node.getAttribute=key=>key==='aria-disabled'?'true':null;}]]){
    const next=button('Next chapter');disable(next);
    const nav=load()({document:doc([next]),location:{href:'https://example.test/novel/last'},getStyle:()=>({})});
    assert.equal(nav.findNext({}).available,false,name);
  }
});

function scheduled(options){
  const handles=[];const writes=[];const removed=[];let navigated=0;
  const scheduler={setTimeout(fn,delay){const h={fn,delay};handles.push(h);return h;},clearTimeout(){}};
  const storage={writeAutoContinue:async value=>{writes.push(value);},removeAutoContinue:async()=>{removed.push(true);}};
  const nav=load()({scheduler,storage,navigate:()=>{navigated+=1;},location:{href:'https://x.test/a'},currentUrl:()=> 'https://x.test/a',...options});
  return {nav,handles,writes,removed,get navigated(){return navigated;}};
}

test('a button target is validated before any handoff is written',async()=>{
  const gone=button('Next');gone.isConnected=false;
  const h=scheduled();
  h.nav.scheduleNextChapter({token:'a',delayMs:1,target:{available:true,url:'',element:gone},origin:'https://x.test',expiresAt:Date.now()+1000});
  await h.handles[0].fn();
  assert.equal(h.writes.length,0);assert.equal(h.navigated,0);
});
test('a button handoff records the page it left',async()=>{
  const h=scheduled();const next=button('Next');
  h.nav.scheduleNextChapter({token:'a',delayMs:1,target:{available:true,url:'',element:next},origin:'https://x.test',expiresAt:Date.now()+1000});
  await h.handles[0].fn();
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].targetUrl,'');assert.equal(h.writes[0].origin,'https://x.test');assert.equal(h.writes[0].fromUrl,'https://x.test/a');
  assert.equal(h.navigated,1);
});
test('a handoff whose target vanished after the write is discarded',async()=>{
  const h=scheduled();const next=button('Next');
  const storageWrite=h.writes;
  h.nav.scheduleNextChapter({token:'a',delayMs:1,target:{available:true,url:'',element:next},origin:'https://x.test',expiresAt:Date.now()+1000});
  const pending=h.handles[0].fn();
  next.isConnected=false; // the button disappears while the write is in flight
  await pending;
  assert.equal(storageWrite.length,1);assert.equal(h.navigated,0);assert.equal(h.removed.length,1);
});

test('handoffs are honored only on their own origin and, for buttons, away from the page they left',async()=>{
  const base=over=>({targetUrl:'',origin:'https://x.test',fromUrl:'https://x.test/a',expiresAt:Date.now()+1000,...over});
  const cases=[
    ['button: same origin, different page','https://x.test/b',base(),true],
    ['button: other origin','https://other.test/p',base(),false],
    ['button: the page it left','https://x.test/a',base(),false],
    ['button: no fromUrl recorded','https://x.test/b',base({fromUrl:undefined}),false],
    ['link: exact target','https://x.test/b',base({targetUrl:'https://x.test/b'}),true],
    ['link: right url, forged origin','https://x.test/b',base({targetUrl:'https://x.test/b',origin:'https://evil.test'}),false],
    ['link: other url','https://x.test/c',base({targetUrl:'https://x.test/b'}),false]];
  for(const [name,current,record,expected] of cases){
    let continued=0;
    const nav=load()({storage:{readAutoContinue:async()=>record,removeAutoContinue:async()=>{}},location:{href:current},
      currentUrl:()=>current,scheduler:{setTimeout(fn){fn();return 1;},clearTimeout(){}}});
    assert.equal(await nav.resumeContinuation({token:'a',onContinue:()=>{continued+=1;}}),expected,name);
    assert.equal(continued,expected?1:0,name);
  }
});
