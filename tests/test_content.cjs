const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const path=require('node:path');
const source=['protocol.js','settings-schema.js','i18n.js','content-runtime.js','content-playback.js','content-document.js','content-progress.js','content-navigation.js','content-panel.js','content.js']
  .map(file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8')).join('\n');
const tick=()=>new Promise(r=>setImmediate(r));
const settingKeys=['voice','temperature','seed','playbackRate','volume','prefetch','cacheLimitMb','autoNext','autoNextDelay','nextSelector','compact','theme','dialogueVoice','characterVoices','expressionMode','mergeShortLines','shortLineLimit','preGenerateChapters','interfaceLanguage'];
const settingForControl={speed:'playbackRate',shortLimit:'shortLineLimit',preGenerate:'preGenerateChapters'};
const liveHarnesses=[];
test.afterEach(()=>{for(const h of liveHarnesses.splice(0))h.cleanup();});

function harness(initial={},options={}) {
  const runtimeListeners=new Set();
  const storageListeners=[];
  const timerHandles=new Set();
  const trackedTimeout=(fn,ms,...args)=>{const id=setTimeout(()=>{timerHandles.delete(id);fn(...args);},ms);timerHandles.add(id);return id;};
  const trackedInterval=(fn,ms,...args)=>{const id=setInterval(fn,ms,...args);timerHandles.add(id);return id;};
  const trackedClear=id=>{clearTimeout(id);clearInterval(id);timerHandles.delete(id);};
  const elements=new Map();
  const createdElements=[];
  const documentListeners=new Map();
  const windowListeners=new Map();
  class Element {
    constructor(id='',tagName='div'){
      this.id=id;this.tagName=tagName.toUpperCase();this.dataset={};this.style={setProperty(){}};
      this.value='';this.children=[];this.events={};this.listeners=new Map();this.hidden=false;
      this.classNames=new Set();this.classList={
        add:(...names)=>names.forEach(name=>this.classNames.add(name)),
        remove:(...names)=>names.forEach(name=>this.classNames.delete(name)),
        toggle:(name,force)=>{const enabled=force??!this.classNames.has(name);if(enabled)this.classNames.add(name);else this.classNames.delete(name);return enabled;},
        [Symbol.iterator]:()=>this.classNames[Symbol.iterator]()
      };
      this.parentElement={setAttribute(){},hidden:false};this.parentNode=null;this.removed=false;
    }
    set innerHTML(html) {
      if(this.id)elements.set(this.id,this);
      for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
        const id=match[2].match(/\bid="([^"]+)"/)?.[1];
        if(!id)continue;
        const child=new Element(id,match[1]);
        child.parentElement=this;
        child.type=match[2].match(/\btype="([^"]+)"/)?.[1]||'';
        child.hidden=/\bhidden(?:\s|=|$)/.test(match[2]);
        elements.set(id,child);
      }
      this.tabs=[...html.matchAll(/data-tab="([^"]+)"/g)].map(m=>Object.assign(new Element(),{dataset:{tab:m[1]}}));
      this.themes=[...html.matchAll(/data-theme-choice="([^"]+)"/g)].map(m=>Object.assign(new Element(),{dataset:{themeChoice:m[1]}}));
    }
    attachShadow(options={}){this.shadowMode=options.mode;this.shadow=new Element('','shadow-root');this.shadow.parentElement=this;this.shadow.adoptedStyleSheets=[];return this.shadow;}
    querySelector(q){if(q[0]==='#')return elements.get(q.slice(1));return null;}
    querySelectorAll(q){return q==='[data-tab]'?this.tabs:q==='[data-theme-choice]'?this.themes:[];}
    setAttribute(k,v){this[k]=v;} getAttribute(k){return this[k];}
    addEventListener(name,fn,options={}){
      const listeners=this.listeners.get(name)||[];listeners.push({fn,options});this.listeners.set(name,listeners);
      this.events[name]=fn;
      if(options?.signal){const remove=()=>this.removeEventListener(name,fn);options.signal.addEventListener('abort',remove,{once:true});}
    }
    removeEventListener(name,fn){
      const listeners=this.listeners.get(name)||[];this.listeners.set(name,listeners.filter(item=>item.fn!==fn));
      this.events[name]=this.listeners.get(name).at(-1)?.fn;
    }
    dispatch(name,event={}){
      const value={type:name,target:this,preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.propagationStopped=true;},...event};
      for(const item of [...(this.listeners.get(name)||[])])item.fn.call(this,value);
      return value;
    }
    replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];children.forEach(child=>this.appendChild(child));}
    appendChild(child){this.children.push(child);child.parentElement=this;child.parentNode=this;return child;}
    contains(child){for(let current=child;current;current=current.parentElement){if(current===this)return true;}return false;}
    remove(){this.removed=true;const parent=this.parentElement;if(parent)parent.children=parent.children.filter(child=>child!==this);this.parentElement=null;}
    focus(){} scrollIntoView(){}
  }
  const body=new Element();
  const paragraphs=(options.paragraphs||[]).map((text,index)=>Object.assign(new Element(`p-${index}`),{
    innerText:text,textContent:text,closest(){return null;}
  }));
  body.innerText=paragraphs.map(item=>item.innerText).join('\n\n');
  body.textContent=body.innerText;
  body.querySelectorAll=query=>query==='p'?paragraphs:[];
  const documentElement=new Element('','html');
  const doc={title:'Chapter one',body,documentElement,visibilityState:'visible',
    createElement:tag=>{const element=new Element('',tag);createdElements.push(element);return element;},
    querySelector:()=>null,querySelectorAll:()=>[],
    addEventListener(name,fn,opts){const listeners=documentListeners.get(name)||[];listeners.push(fn);documentListeners.set(name,listeners);docTarget.addEventListener(name,fn,opts);},
    removeEventListener(name,fn){documentListeners.set(name,(documentListeners.get(name)||[]).filter(listener=>listener!==fn));docTarget.removeEventListener(name,fn);}};
  const docTarget=new Element('','document');
  doc.dispatch=(name,event)=>docTarget.dispatch(name,event);
  const windowTarget=new Element('','window');
  const windowAddEventListener=(name,fn,opts)=>{const listeners=windowListeners.get(name)||[];listeners.push(fn);windowListeners.set(name,listeners);windowTarget.addEventListener(name,fn,opts);};
  const windowRemoveEventListener=(name,fn)=>{windowListeners.set(name,(windowListeners.get(name)||[]).filter(listener=>listener!==fn));windowTarget.removeEventListener(name,fn);};
  const calls=[];const pending=[];const started=[];const saved={...initial};let fingerprint='base-v1';

  // Minimal Web Audio double: records every scheduled source so a test can see
  // when each paragraph was told to start on the context clock.
  class AudioContext {
    constructor(){this.state='running';this.currentTime=0;this.destination={};}
    createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
    createBufferSource(){
      const node={buffer:null,playbackRate:{value:1},onended:null,connect(){},disconnect(){},
        start(when,offset){node.startedAt=when;node.offset=offset;started.push(node);},
        stop(){node.stopped=true;}};
      return node;
    }
    decodeAudioData(buffer){return Promise.resolve({duration:1.5,length:buffer.byteLength});}
    resume(){this.state='running';return Promise.resolve();}
    suspend(){this.state='suspended';return Promise.resolve();}
  }

  const sandbox={console,crypto:webcrypto,AbortController,URL,Blob,Element,Node:{ELEMENT_NODE:1},AudioContext,
    setTimeout:trackedTimeout,clearTimeout:trackedClear,setInterval:trackedInterval,clearInterval:trackedClear,location:new URL('https://novel.test/chapter-1'),document:doc,
    confirm:()=>true,CSS:{escape:s=>s},getComputedStyle:()=>({}),
    CSSStyleSheet:class{replaceSync(css){this.css=css;}},
    browser:{i18n:{getUILanguage:()=> 'pt-BR'},runtime:{id:'test',getURL:p=>'moz-extension://test/'+p,onMessage:{addListener(fn){if(options.registerEventsError)throw new Error('listener unavailable');runtimeListeners.add(fn);},removeListener(fn){runtimeListeners.delete(fn);}},
      connect:()=>({name:'port',disconnect(){},onDisconnect:{addListener(){}}}),
      sendMessage:async message=>{
        calls.push(message);
        if(message.type==='settings-get'){if(Object.hasOwn(options,'settingsGet'))return typeof options.settingsGet==='function'?options.settingsGet():options.settingsGet;return {ok:true,settings:{...(saved.nlrSettings||{})},revision:0,accepted_keys:settingKeys,settings_protocol:1,implementation:'background-patch-v1'};}
        if(message.type==='settings-update'){saved.nlrSettings={...(saved.nlrSettings||{}),...message.patch};return options.settingsUpdate || {ok:true,revision:1,accepted_keys:Object.keys(message.patch),settings_protocol:1,implementation:'background-patch-v1'};}
        if(message.type==='profile')return {fingerprint};
        if(message.type==='synthesize')return new Promise(resolve=>pending.push(resolve));
        if(message.type==='voices')return {voices:[]};
        if(message.type==='health')return {ok:true,data:{upstream:true,backend:'qwen3',cache:'hd'},queue:{waiting:0}};
        if(message.type==='capabilities')return options.capabilities||{legacy:false,compatible:true,serviceVersion:'1.5.0',capabilities:{voice_cloning:true,multiple_voices:false,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:true,offline_cache_hits:true}};
        if(message.type==='cache-stats')return {ok:true,mode:'hd',bytes:15*1024*1024,count:28};
        if(message.type==='origin-allowed')return {ok:true,allowed:false};
        if(message.type==='panel-css')return {ok:true,css:'#nlr-panel{}'};
        return {ok:true};
      }},storage:{local:{get:async key=>typeof key==='string'?{[key]:saved[key]}:saved,set:async value=>Object.assign(saved,value),remove:async key=>delete saved[key]},onChanged:{addListener(fn){storageListeners.push(fn);},removeListener(fn){const i=storageListeners.indexOf(fn);if(i>=0)storageListeners.splice(i,1);}}}}
  };
  sandbox.getSelection=()=>options.selection||{isCollapsed:true,toString:()=>''};
  sandbox.window=sandbox;sandbox.addEventListener=windowAddEventListener;sandbox.removeEventListener=windowRemoveEventListener;
  vm.createContext(sandbox);
  const install=()=>vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.hooks={state,runtime,navigation,playback,progress,panel,playIndex,stopReading,updateSettingForControl,selectTab,applyTheme,startReading,continueReading,checkServer,prefetchFutureChapters,readPage,readSelection,refreshCacheStats,getSettingsFailureReason:()=>settingsFailureReason,getSettingsRevision:()=>settingsRevision,buildSynthesisPayload,audioItem};})();'),sandbox);
  install();
  const result={sandbox,calls,pending,started,elements,saved,storageListeners,createdElements,documentListeners,windowListeners,
    body,doc,storageChange:(value,area='local',revision)=>{const changes={};if(value)changes.nlrSettings={newValue:value};if(Number.isInteger(revision))changes.nlrSettingsRevision={newValue:revision};for(const fn of [...storageListeners])fn(changes,area);},
    setFingerprint:v=>fingerprint=v,dispatchRuntime:message=>Promise.all([...runtimeListeners].map(listener=>listener(message))),
    listenerCounts:()=>({runtime:runtimeListeners.size,storage:storageListeners.length,
      document:[...docTarget.listeners.values()].reduce((total,list)=>total+list.length,0),
      window:[...windowTarget.listeners.values()].reduce((total,list)=>total+list.length,0)}),
    panelListenerCount:()=>[...elements.values()].reduce((total,element)=>total+
      [...element.listeners.values()].reduce((count,list)=>count+list.length,0),0),
    timerCount:()=>timerHandles.size,
    reinject:install,
    cleanup:()=>{for(const id of timerHandles)trackedClear(id);}};
  Object.defineProperty(result,'runtimeListener',{get:()=>runtimeListeners.values().next().value});
  liveHarnesses.push(result); return result;
}

test('rapid Next cannot play an older generation over the current paragraph',async()=>{
  const h=harness();await tick();
  const {state,playIndex}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'first',element:null},{text:'second',element:null}],length:2};h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId);state.settings.prefetch=0;
  const a=playIndex(0,state.sessionId);await tick();
  const b=playIndex(1,state.sessionId);await tick();
  h.pending[1]({ok:true,buffer:new ArrayBuffer(44)});await b;
  h.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await a;
  assert.equal(h.started.length,1);
  assert.equal(h.sandbox.hooks.progress.currentIndex(),1);
  h.sandbox.__nlrDispose();
});
test('Stop invalidates pending generation and sends cancellation',async()=>{
  const h=harness();await tick();const {state,playIndex,stopReading}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'first',element:null}],length:1};h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId);state.settings.prefetch=0;
  const a=playIndex(0,state.sessionId);await tick();assert.equal(h.sandbox.hooks.progress.inspect().timerActive,true);await stopReading();
  assert.equal(h.sandbox.hooks.progress.inspect().timerActive,false);
  h.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await a;
  assert.equal(h.started.length,0);
  assert.ok(h.calls.some(c=>c.type==='cancel-session'));
  h.sandbox.__nlrDispose();
});

test('reload Continue restores paragraph index and offset through the real content flow',async()=>{
  const paragraphs=Array.from({length:6},(_,index)=>
    `Paragraph ${index} contains enough readable words for the document parser and remains longer than the merge threshold.`);
  const first=harness({}, {paragraphs});await tick();
  const snapshot=first.sandbox.NovelLocalReader.contentDocument.createPageSnapshot({document:first.sandbox.document});
  first.sandbox.hooks.startReading(snapshot,'page',4,0,true);await tick();
  first.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await tick();await first.sandbox.hooks.progress.save(true);
  const key=Object.keys(first.saved.nlrProgress)[0];first.saved.nlrProgress[key].currentTime=1.25;
  first.sandbox.__nlrDispose();
  const second=harness(first.saved,{paragraphs});await tick();
  assert.equal(second.sandbox.hooks.progress.resumeSnapshot().index,4);
  const resumed=second.sandbox.hooks.continueReading();await tick();
  assert.equal(second.sandbox.hooks.progress.currentIndex(),4);
  second.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await resumed;await tick();
  assert.equal(second.started[0].offset,1.25);assert.equal(second.sandbox.hooks.progress.currentIndex(),4);
  second.sandbox.__nlrDispose();
});
test('the next paragraph is scheduled to start exactly when the current one ends',async()=>{
  const h=harness();await tick();const {state,playIndex}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'first',element:null},{text:'second',element:null}],length:2};h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId);state.settings.prefetch=1;
  const a=playIndex(0,state.sessionId);await tick();
  h.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await a;
  await tick();await tick();
  h.pending[1]({ok:true,buffer:new ArrayBuffer(44)});
  await tick();await tick();
  assert.equal(h.started.length,2);
  // First paragraph starts now and runs 1.5s; the second is queued for 1.5s.
  assert.equal(h.started[0].startedAt,0);
  assert.equal(h.started[1].startedAt,1.5);
  assert.equal(h.started[1].offset,0);
  h.sandbox.__nlrDispose();
});
test('pausing suspends the shared context instead of dropping the schedule',async()=>{
  const h=harness();await tick();const {state,playback,playIndex}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'first',element:null}],length:1};h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId);state.settings.prefetch=0;
  const a=playIndex(0,state.sessionId);await tick();
  h.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await a;
  h.elements.get('nlr-pause').events.click();
  await tick();
  assert.equal(playback.snapshot().playing,false);
  assert.equal(h.started[0].stopped,undefined);
  h.sandbox.__nlrDispose();
});
test('the keepalive port opens with playback and closes with the scope',async()=>{
  const h=harness();await tick();const {state,playIndex,stopReading}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'first',element:null}],length:1};h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId);state.settings.prefetch=0;
  assert.equal(h.sandbox.hooks.runtime.hasPort,false);
  const a=playIndex(0,state.sessionId);await tick();
  assert.equal(h.sandbox.hooks.runtime.hasPort,true);
  h.pending[0]({ok:true,buffer:new ArrayBuffer(44)});await a;
  const scope=h.sandbox.hooks.runtime.session.scope;
  await stopReading();
  // Disconnecting tombstones the scope in the background, so the scope must be
  // retired at the same moment.
  assert.equal(h.sandbox.hooks.runtime.hasPort,false);
  assert.notEqual(h.sandbox.hooks.runtime.session.scope,scope);
  h.sandbox.__nlrDispose();
});
test('changing voice clears session audio and pending tasks',async()=>{
  const h=harness();await tick();const {state,updateSettingForControl}=h.sandbox.hooks;
  const previous=h.sandbox.hooks.runtime.session.scope;
  h.elements.get('nlr-voice').value='new.wav';await updateSettingForControl('voice','new.wav');
  assert.equal(h.sandbox.hooks.playback.snapshot().bufferCount,0);assert.notEqual(h.sandbox.hooks.runtime.session.scope,previous);
  assert.equal(state.settings.voice,'new.wav');
  h.sandbox.__nlrDispose();
});
test('interface language persists and syncs without changing English synthesis payload or playback session',async()=>{
  const h=harness();await tick();
  const {state,audioItem,updateSettingForControl}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'The story remains in English.',element:null}],length:1};
  const before={...audioItem(0)};const session=state.sessionId;const scope=h.sandbox.hooks.runtime.session.scope;
  await updateSettingForControl('interfaceLanguage','es');
  const after={...audioItem(0)};
  assert.deepEqual(after,before);
  assert.equal(state.sessionId,session);
  assert.equal(h.sandbox.hooks.runtime.session.scope,scope);
  const patch=h.calls.filter(call=>call.type==='settings-update').at(-1).patch;
  assert.deepEqual({...patch},{interfaceLanguage:'es'});
  assert.equal(h.sandbox.NovelLocalReader.i18n.currentLanguage(),'es');
  const writes=h.calls.filter(call=>call.type==='settings-update').length;
  h.storageChange({...state.settings,interfaceLanguage:'en'});
  assert.equal(h.sandbox.NovelLocalReader.i18n.currentLanguage(),'en');
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,writes);
  h.sandbox.__nlrDispose();
});
test('a control event sends only that control patch to the background',async()=>{
  const h=harness();await tick();
  const voice=h.elements.get('nlr-voice');voice.value='single.wav';
  await voice.events.input();
  const updates=h.calls.filter(call=>call.type==='settings-update');
  assert.equal(updates.length,1);assert.deepEqual({...updates[0].patch},{voice:'single.wav'});
  h.sandbox.__nlrDispose();
});
test('old settings background is rejected visibly instead of applying defaults',async()=>{
  const h=harness({}, {settingsGet:{ok:true,settings:{playbackRate:1.25},revision:0}});await tick();
  assert.equal(h.elements.get('nlr-settings-diagnostic').textContent,'Não foi possível carregar as preferências. Recarregue a extensão.');
  assert.equal(h.sandbox.hooks.getSettingsFailureReason(),'protocol');
  assert.doesNotMatch(h.elements.get('nlr-settings-diagnostic').textContent,/background-patch|revision|accepted_keys|revisão/i);
  assert.match(h.elements.get('nlr-status-text').textContent,/Não foi possível carregar as preferências/);
});
test('a synchronous registerEvents failure stays visible and remains disposable',async()=>{
  const h=harness({}, {registerEventsError:true});await tick();
  assert.equal(h.elements.get('nlr-settings-diagnostic').textContent,'Não foi possível carregar as preferências. Recarregue a extensão.');
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,0);
  assert.equal(typeof h.sandbox.__nlrDispose,'function');assert.doesNotThrow(()=>h.sandbox.__nlrDispose());
});
test('settings diagnostics distinguish every safe incompatibility reason',async()=>{
  const base={ok:true,settings:{},revision:0,accepted_keys:settingKeys,settings_protocol:1,implementation:'background-patch-v1'};
  const cases=[
    [undefined,'no-response'],
    [{ok:false},'malformed-response'],
    [{...base,settings_protocol:2},'protocol'],
    [{...base,implementation:'old'},'implementation'],
    [{...base,revision:-1},'revision'],
    [{...base,accepted_keys:[]},'accepted-keys']
  ];
  for(const [response,reason] of cases){const h=harness({}, {settingsGet:response});await tick();assert.equal(h.elements.get('nlr-settings-diagnostic').textContent,'Não foi possível carregar as preferências. Recarregue a extensão.');assert.equal(h.sandbox.hooks.getSettingsFailureReason(),reason);}
  const transport=harness({}, {settingsGet:()=>{throw new Error('private transport detail');}});await tick();
  assert.equal(transport.elements.get('nlr-settings-diagnostic').textContent,'Não foi possível carregar as preferências. Recarregue a extensão.');
  assert.equal(transport.sandbox.hooks.getSettingsFailureReason(),'transport-error');
  assert.doesNotMatch(transport.elements.get('nlr-status-text').textContent,/private transport detail/);
});
test('mismatched accepted keys are rejected without exposing the value',async()=>{
  const h=harness({}, {settingsUpdate:{ok:true,revision:2,accepted_keys:['voice'],settings_protocol:1,implementation:'background-patch-v1'}});await tick();
  const speed=h.elements.get('nlr-speed');speed.value='1.25';
  await assert.rejects(h.sandbox.hooks.updateSettingForControl('playbackRate',speed.value),/Não foi possível salvar as preferências/);
  assert.equal(h.elements.get('nlr-settings-diagnostic').textContent,'Não foi possível salvar as preferências. Recarregue a extensão.');
  assert.equal(h.sandbox.hooks.getSettingsFailureReason(),'accepted-keys');
  assert.doesNotMatch(h.elements.get('nlr-settings-diagnostic').textContent,/1\.25/);h.sandbox.__nlrDispose();
});
test('storage changes synchronize controls without a write loop and listener is disposed',async()=>{
  const h=harness();await tick();const before=h.calls.filter(call=>call.type==='settings-update').length;
  h.storageChange({playbackRate:1.25,prefetch:3,temperature:0,seed:0,autoNext:false},'local',9);
  assert.equal(h.elements.get('nlr-speed').value,'1.25');assert.equal(h.elements.get('nlr-prefetch').value,'3');
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,before);assert.equal(h.storageListeners.length,1);
  assert.equal(h.sandbox.hooks.getSettingsFailureReason(),null);
  assert.equal(h.sandbox.hooks.state.settings.playbackRate,1.25);
  h.sandbox.__nlrDispose();assert.equal(h.storageListeners.length,0);
});

test('all persisted settings survive a fresh instance, including zero and false',async()=>{
  const first=harness(); await tick();
  const names=['voice','temperature','seed','speed','volume','prefetch','cacheLimitMb','autoNextDelay','nextSelector','dialogueVoice','characterVoices','shortLimit','preGenerate'];
  const values=['voice-x','0','0','1.25','0','0','100','2','.next','dialogue-x','{"Hero":"voice-x"}','20','0'];
  names.forEach((name,index)=>{ const id={'voice':'nlr-voice',temperature:'nlr-temperature',seed:'nlr-seed',speed:'nlr-speed',volume:'nlr-volume',prefetch:'nlr-prefetch','cacheLimitMb':'nlr-cache-limit','autoNextDelay':'nlr-auto-next-delay',nextSelector:'nlr-next-selector',dialogueVoice:'nlr-dialogue-voice',characterVoices:'nlr-character-voices',shortLimit:'nlr-short-limit',preGenerate:'nlr-pregenerate'}[name]; first.elements.get(id).value=values[index]; });
  first.elements.get('nlr-auto-next').checked=false; first.elements.get('nlr-compact').checked=true; first.elements.get('nlr-merge-short').checked=false;
  for(const name of ['voice','temperature','seed','speed','volume','prefetch','cacheLimitMb','autoNext','autoNextDelay','nextSelector','compact','dialogueVoice','characterVoices','mergeShortLines','shortLimit','preGenerate']){
    const id={'voice':'nlr-voice',temperature:'nlr-temperature',seed:'nlr-seed',speed:'nlr-speed',volume:'nlr-volume',prefetch:'nlr-prefetch','cacheLimitMb':'nlr-cache-limit',autoNext:'nlr-auto-next','autoNextDelay':'nlr-auto-next-delay',nextSelector:'nlr-next-selector',compact:'nlr-compact',dialogueVoice:'nlr-dialogue-voice',characterVoices:'nlr-character-voices',mergeShortLines:'nlr-merge-short',shortLimit:'nlr-short-limit',preGenerate:'nlr-pregenerate'}[name];
    const control=first.elements.get(id);await first.sandbox.hooks.updateSettingForControl(settingForControl[name]||name,control.type==='checkbox'?control.checked:control.value);
  }
  first.sandbox.__nlrDispose();
  const second=harness({nlrSettings:first.saved.nlrSettings}); await tick();
  assert.equal(second.sandbox.hooks.state.settings.voice,'voice-x');
  assert.equal(second.sandbox.hooks.state.settings.prefetch,0);
  assert.equal(second.sandbox.hooks.state.settings.temperature,0);
  assert.equal(second.sandbox.hooks.state.settings.seed,0);
  assert.equal(second.sandbox.hooks.state.settings.autoNext,false);
  assert.equal(second.sandbox.hooks.state.settings.mergeShortLines,false);
  assert.equal(second.sandbox.hooks.state.settings.preGenerateChapters,0);
  second.sandbox.__nlrDispose();
});
test('opening a page does not fetch the voice list until the panel is shown',async()=>{
  const h=harness();await tick();
  assert.ok(!h.calls.some(c=>c.type==='voices'));
  h.sandbox.__nlrDispose();
});
test('a site CSP that blocks the stylesheet link falls back to adopted styles',async()=>{
  const h=harness();await tick();
  const links=h.createdElements.filter(element=>element.tagName==='LINK');
  assert.equal(links.length,2);
  links[0].events.error();
  links[1].events.error();
  await tick();await tick();
  assert.equal(h.calls.filter(c=>c.type==='panel-css').length,1);
  h.sandbox.__nlrDispose();
});
test('theme and keyboard tab state use valid selections',async()=>{
  const h=harness();await tick();h.sandbox.hooks.selectTab('appearance');
  assert.equal(h.elements.get('nlr-view-appearance').hidden,false);
  assert.equal(h.elements.get('nlr-view-listen').hidden,true);
  h.elements.get('nlr-theme').value='parchment';await h.sandbox.hooks.updateSettingForControl('theme','parchment');
  assert.equal(h.saved.nlrSettings.theme,'parchment');
  h.sandbox.__nlrDispose();
});
test('the background can probe a live content script before deciding to reinject it',async()=>{
  const h=harness();await tick();
  const result=await h.runtimeListener({type:'nlr-probe'});
  assert.equal(result.ok,true);
  assert.equal(result.version,JSON.parse(fs.readFileSync('manifest.json','utf8')).version);
  h.sandbox.__nlrDispose();
});
test('Base capabilities hide expression controls and cache limit remains read-only',async()=>{
  const h=harness();await tick();
  await h.sandbox.hooks.checkServer();
  assert.equal(h.elements.get('nlr-expression').disabled,true);
  assert.equal(h.elements.get('nlr-expression-control').hidden,true);
  assert.equal(h.elements.get('nlr-multiple-voices-controls').hidden,true);
  assert.equal(h.elements.get('nlr-test-voice')!==undefined,true);
  assert.equal(h.elements.get('nlr-temperature').hidden,false);
  assert.equal(h.elements.get('nlr-seed').hidden,false);
  assert.match(source,/id="nlr-cache-limit"[^>]*disabled/);
  assert.match(source,/Limite do cache local \(MB\)/);
  assert.doesNotMatch(source,/Cache máximo no HD|cache no HD|Preferências: background-patch-v1|Preferência salva · revisão/);
  h.sandbox.__nlrDispose();
});
test('multi-voice routing stays available only with the negotiated capability and legacy values hydrate',async()=>{
  const legacy={voice:'narrator',dialogueVoice:'dialogue-old',characterVoices:'Alice=character-old',expressionMode:'smart'};
  const h=harness({nlrSettings:legacy},{capabilities:{legacy:false,compatible:true,serviceVersion:'1.5.0',capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:true,cache_warming:true,offline_cache_hits:true}}});
  await tick();await h.sandbox.hooks.checkServer();
  assert.equal(h.sandbox.hooks.state.settings.dialogueVoice,'dialogue-old');
  assert.equal(h.sandbox.hooks.state.settings.characterVoices,'Alice=character-old');
  assert.equal(h.sandbox.hooks.state.settings.expressionMode,'smart');
  assert.equal(h.elements.get('nlr-multiple-voices-controls').hidden,false);
  assert.equal(h.elements.get('nlr-expression-control').hidden,false);
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,0);
  const payload=h.sandbox.hooks.buildSynthesisPayload('Alice: Hello there.');
  assert.equal(payload.voice,'character-old');
  h.sandbox.__nlrDispose();
});
test('dialogue voice preferences are preserved but ignored without multiple-voice capability',async()=>{
  const h=harness({nlrSettings:{voice:'narrator',dialogueVoice:'dialogue-old',characterVoices:'Alice=character-old'}});
  await tick();await h.sandbox.hooks.checkServer();
  assert.equal(h.sandbox.hooks.state.settings.dialogueVoice,'dialogue-old');
  assert.equal(h.sandbox.hooks.state.settings.characterVoices,'Alice=character-old');
  assert.equal(h.sandbox.hooks.buildSynthesisPayload('Alice: Hello there.').voice,'narrator');
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,0);
  h.sandbox.__nlrDispose();
});
test('an internal 1.4/1.5 host that speaks protocol 1 is not flagged as outdated by a 1.0.0 extension',async()=>{
  for(const serviceVersion of ['1.4.0','1.5.0']){
    const h=harness({}, {capabilities:{legacy:false,compatible:true,serviceVersion,capabilities:{voice_cloning:true,multiple_voices:false,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}}});
    await tick();await h.sandbox.hooks.checkServer();
    assert.doesNotMatch(h.elements.get('nlr-diagnostics').textContent,/Host legado temporário/,serviceVersion);
    h.sandbox.__nlrDispose();
  }
});
test('older host notice follows negotiated host version and legacy protocol state',async()=>{
  const old=harness({}, {capabilities:{legacy:false,compatible:true,serviceVersion:'0.9.0',capabilities:{voice_cloning:true,multiple_voices:false,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}}});
  await tick();await old.sandbox.hooks.checkServer();
  assert.match(old.elements.get('nlr-diagnostics').textContent,/Host legado temporário/);
  const current=harness();await tick();await current.sandbox.hooks.checkServer();
  assert.doesNotMatch(current.elements.get('nlr-diagnostics').textContent,/Host legado temporário/);
  old.sandbox.__nlrDispose();current.sandbox.__nlrDispose();
});
test('cache labels are medium-neutral and describe local usage',async()=>{
  const h=harness();await tick();await h.sandbox.hooks.refreshCacheStats();
  assert.equal(h.elements.get('nlr-cache-stats').textContent,'Cache local: 15 MB em 28 trechos.');
  assert.match(source,/cache local/);
  assert.doesNotMatch(source,/no HD|Cache no HD/i);
  h.sandbox.__nlrDispose();
});
test('settings revision stays internal while successful saves show neutral status',async()=>{
  const h=harness();await tick();
  assert.equal(h.sandbox.hooks.getSettingsRevision(),0);
  assert.equal(h.elements.get('nlr-settings-diagnostic').hidden,true);
  assert.equal(h.elements.get('nlr-settings-diagnostic').textContent || '', '');
  const speed=h.elements.get('nlr-speed');speed.value='1.25';
  await h.sandbox.hooks.updateSettingForControl('playbackRate','1.25');
  assert.equal(h.elements.get('nlr-status-text').textContent,'Preferências salvas.');
  assert.doesNotMatch(h.elements.get('nlr-status-text').textContent,/revisão|background-patch|\b1\b/);
  assert.equal(h.sandbox.hooks.getSettingsFailureReason(),null);
  assert.equal(h.sandbox.hooks.getSettingsRevision(),1);
  h.storageChange({voice:'voice-other'},'local',8);
  assert.equal(h.elements.get('nlr-voice').value,'voice-other');
  assert.equal(h.sandbox.hooks.getSettingsRevision(),8);
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,1);
  h.sandbox.__nlrDispose();
});
test('future chapters do not queue speech or warm work when cache warming is unavailable',async()=>{
  const h=harness({}, {capabilities:{legacy:false,compatible:true,serviceVersion:'1.5.0',capabilities:{voice_cloning:true,multiple_voices:false,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}}});await tick();
  await h.sandbox.hooks.checkServer();
  await h.sandbox.hooks.prefetchFutureChapters(1,true);
  assert.equal(h.calls.filter(call=>call.type==='warm-cache').length,0);
  assert.match(source,/cache_warming !== true/);
  h.sandbox.__nlrDispose();
});
test('disposing a reader is idempotent and clears warm/navigation timers and its session port',async()=>{
  const h=harness();await tick();
  const state=h.sandbox.hooks.state;
  let disconnected=0;
  h.sandbox.hooks.navigation.scheduleNext({token:state.sessionId,delayMs:60000});
  h.sandbox.hooks.navigation.scheduleContinuation({token:state.sessionId,delayMs:60000});
  const originalClose=h.sandbox.hooks.runtime.closePort;
  h.sandbox.hooks.runtime.closePort=()=>{disconnected++; originalClose();};
  h.sandbox.__nlrDispose();
  h.sandbox.__nlrDispose();
  h.sandbox.hooks.navigation.cancelAll();
  assert.equal(h.sandbox.hooks.runtime.hasPort,false);
  assert.equal(h.sandbox.hooks.runtime.hasPort,false);
});

test('characterization: identical pending synthesis is shared and rejection is cleared',async()=>{
  const h=harness(); await tick(); const {state,playIndex}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'same',element:null}],length:1}; h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId); state.settings.prefetch=0;
  const first=playIndex(0,state.sessionId); await tick();
  const second=playIndex(0,state.sessionId); await tick();
  assert.equal(h.pending.length,1,'the same pending paragraph shares its synthesis');
  h.pending[0]({ok:false,error:'bad'});
  await Promise.all([first,second]); assert.equal(h.sandbox.hooks.playback.snapshot().pendingCount,0); h.sandbox.__nlrDispose();
});

test('characterization: local volume and speed changes do not request a new synthesis',async()=>{
  const h=harness(); await tick(); const {state,playIndex,updateSettingForControl}=h.sandbox.hooks;
  state.documentSnapshot={entries:[{text:'audio',element:null}],length:1}; h.sandbox.hooks.progress.setDocument(state.documentSnapshot,null,state.sessionId); state.settings.prefetch=0;
  const playing=playIndex(0,state.sessionId); await tick(); h.pending[0]({ok:true,buffer:new ArrayBuffer(44)}); await playing;
  const count=h.calls.filter(c=>c.type==='synthesize').length;
  h.elements.get('nlr-volume').value='0.5'; await updateSettingForControl('volume','0.5');
  h.elements.get('nlr-speed').value='1.25'; await updateSettingForControl('playbackRate','1.25');
  assert.equal(h.calls.filter(c=>c.type==='synthesize').length,count); h.sandbox.__nlrDispose();
});

test('panel characterization: creates one host with a closed shadow root',async()=>{
  const h=harness();await tick();
  const hosts=h.createdElements.filter(element=>element.tagName==='NLR-READER-HOST');
  assert.equal(hosts.length,1);
  assert.equal(hosts[0].shadowMode,'closed');
  assert.equal(h.body.children.filter(element=>element===hosts[0]).length,1);
  assert.equal(h.elements.get('nlr-panel').hidden,true);
  h.sandbox.__nlrDispose();
});

test('panel characterization: toggle opens, close button and Escape hide the panel',async()=>{
  const h=harness();await tick();const panel=h.elements.get('nlr-panel');
  assert.equal(panel.hidden,true);
  await h.runtimeListener({type:'toggle-panel'});assert.equal(panel.hidden,false);
  h.elements.get('nlr-close').dispatch('click');assert.equal(panel.hidden,true);
  await h.runtimeListener({type:'toggle-panel'});assert.equal(panel.hidden,false);
  h.doc.dispatch('keydown',{key:'Escape'});assert.equal(panel.hidden,true);
  h.sandbox.__nlrDispose();
});

test('panel characterization: preference listeners are installed only after settings hydration',async()=>{
  let resolveSettings;
  const response=new Promise(resolve=>{resolveSettings=resolve;});
  const h=harness({}, {settingsGet:()=>response});
  const controls=['nlr-voice','nlr-temperature','nlr-seed','nlr-speed','nlr-volume','nlr-prefetch',
    'nlr-cache-limit','nlr-auto-next','nlr-auto-next-delay','nlr-next-selector','nlr-compact','nlr-theme',
    'nlr-dialogue-voice','nlr-character-voices','nlr-expression','nlr-merge-short','nlr-short-limit','nlr-pregenerate'];
  for(const id of controls){h.elements.get(id).dispatch('input');h.elements.get(id).dispatch('change');}
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,0);
  resolveSettings({ok:true,settings:{voice:'persisted.wav',prefetch:0,autoNext:false},revision:7,
    accepted_keys:settingKeys,settings_protocol:1,implementation:'background-patch-v1'});
  await tick();await tick();
  assert.equal(h.elements.get('nlr-voice').value,'persisted.wav');
  assert.equal(h.elements.get('nlr-prefetch').value,'0');
  assert.equal(h.elements.get('nlr-auto-next').checked,false);
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,0);
  h.elements.get('nlr-voice').value='after-hydration.wav';
  h.elements.get('nlr-voice').dispatch('input');await tick();
  assert.deepEqual(h.calls.filter(call=>call.type==='settings-update').map(call=>({...call.patch})),
    [{voice:'after-hydration.wav'}]);
  h.sandbox.__nlrDispose();
});

test('panel characterization: external local settings update controls without writing back',async()=>{
  const h=harness();await tick();const writes=h.calls.filter(call=>call.type==='settings-update').length;
  h.storageChange({voice:'external.wav',playbackRate:1.4,prefetch:0,autoNext:false});
  assert.equal(h.elements.get('nlr-voice').value,'external.wav');
  assert.equal(h.elements.get('nlr-speed').value,'1.4');
  assert.equal(h.elements.get('nlr-prefetch').value,'0');
  assert.equal(h.elements.get('nlr-auto-next').checked,false);
  assert.equal(h.calls.filter(call=>call.type==='settings-update').length,writes);
  h.storageChange({voice:'wrong-area.wav'},'sync');
  assert.equal(h.elements.get('nlr-voice').value,'external.wav');
  h.sandbox.__nlrDispose();
});

test('panel characterization: primary actions read, continue, play, and open library or file',async()=>{
  const paragraphs=Array.from({length:4},(_,index)=>
    `Paragraph ${index} contains enough readable text for the reader parser and playback.`);
  const h=harness({nlrProgress:{'https://novel.test/chapter-1':{
    index:2,text:paragraphs[2],currentTime:0,updatedAt:1
  }}},{paragraphs,selection:'A selected passage with enough readable words.'});
  await tick();assert.equal(h.elements.get('nlr-continue').hidden,false);
  h.elements.get('nlr-read-page').dispatch('click');await tick();
  assert.ok(h.calls.some(call=>call.type==='synthesize'));
  const firstPending=h.pending.at(-1);firstPending({ok:true,buffer:new ArrayBuffer(44)});await tick();
  h.elements.get('nlr-pause').dispatch('click');await tick();
  assert.equal(h.sandbox.hooks.playback.snapshot().playing,false);
  h.elements.get('nlr-read-selection').dispatch('click');await tick();
  assert.ok(h.calls.filter(call=>call.type==='synthesize').length>=2);
  h.pending.at(-1)({ok:true,buffer:new ArrayBuffer(44)});await tick();
  h.elements.get('nlr-library').dispatch('click');await tick();
  h.elements.get('nlr-open-file').dispatch('click');await tick();
  assert.ok(h.calls.some(call=>call.type==='open-page'&&call.page==='library.html'));
  assert.ok(h.calls.some(call=>call.type==='open-page'&&call.page==='reader.html'));
  h.elements.get('nlr-continue').dispatch('click');await tick();
  assert.ok(h.calls.filter(call=>call.type==='synthesize').length>=3);
  h.pending.at(-1)({ok:true,buffer:new ArrayBuffer(44)});await tick();
  h.sandbox.__nlrDispose();
});

test('panel characterization: dispose removes host and listeners and remains safe during reinjection',async()=>{
  const h=harness();await tick();
  const original=h.createdElements.find(element=>element.tagName==='NLR-READER-HOST');
  assert.ok(original);assert.ok(h.listenerCounts().runtime>0);assert.ok(h.listenerCounts().document>0);
  assert.ok(h.panelListenerCount()>0);
  h.sandbox.__nlrDispose();h.sandbox.__nlrDispose();
  assert.equal(h.body.children.filter(element=>element.tagName==='NLR-READER-HOST').length,0);
  assert.deepEqual(h.listenerCounts(),{runtime:0,storage:0,document:0,window:0});
  assert.equal(h.panelListenerCount(),0);
  h.reinject();await tick();
  assert.equal(h.body.children.filter(element=>element.tagName==='NLR-READER-HOST').length,1);
  assert.ok(h.listenerCounts().runtime>0);
  h.sandbox.__nlrDispose();
  assert.deepEqual(h.listenerCounts(),{runtime:0,storage:0,document:0,window:0});
  assert.equal(h.panelListenerCount(),0);
});

test('panel characterization: picker stays hidden while selecting and captures a stable selector',async()=>{
  const h=harness();await tick();
  const panel=h.elements.get('nlr-panel');const target=new h.sandbox.Element('chapter-body','article');
  h.elements.get('nlr-pick-content').dispatch('click');
  assert.equal(panel.hidden,true);
  await new Promise(resolve=>setTimeout(resolve,120));
  const host=h.createdElements.find(element=>element.tagName==='NLR-READER-HOST');
  h.doc.dispatch('click',{target:host,composedPath:()=>[panel,host]});
  assert.equal(h.elements.get('nlr-content-selector').value,'');
  assert.equal(panel.hidden,true);
  h.doc.dispatch('click',{target});
  assert.equal(h.elements.get('nlr-content-selector').value,'#chapter-body');
  assert.match(h.elements.get('nlr-status-text').textContent,/Seletor capturado/);
  assert.equal(h.sandbox.document.documentElement.classNames.has('nlr-picking'),false);
  h.sandbox.__nlrDispose();
});

test('panel picker cancellation restores the panel and disposal cancels its timer',async()=>{
  const h=harness();await tick();
  h.elements.get('nlr-pick-next').dispatch('click');
  assert.equal(h.elements.get('nlr-panel').hidden,true);
  assert.ok(h.timerCount()>0);
  h.doc.dispatch('keydown',{key:'Escape'});
  assert.equal(h.elements.get('nlr-panel').hidden,false);
  assert.equal(h.sandbox.document.documentElement.classNames.has('nlr-picking'),false);
  assert.match(h.elements.get('nlr-status-text').textContent,/cancelada/i);
  const before=h.timerCount();
  h.elements.get('nlr-pick-next').dispatch('click');
  assert.ok(h.timerCount()>before);
  h.sandbox.__nlrDispose();
  assert.equal(h.timerCount(),0);
});
