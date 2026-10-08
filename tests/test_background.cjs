const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(fetch,granted=['http://127.0.0.1:8081/*'],liveTabs=[],capabilitiesData=null,
  dataCollection=[],permissionFailure=false) {
  let handler; let connect; let actionClick;
  const store={nlrConnection:{token:'test-token'}};
  const event={addListener(){}};
  const registered=[];const sent=[];const injected=[];
  const defaultCapabilities={service_version:'1.5.0',protocol:{current:1,minimum:1,maximum:1},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:true,offline_cache_hits:true}};
  let capabilitiesCalls=0;
  const guardedFetch=async (url,options)=>String(url).endsWith('/v1/nlr/capabilities')
    ? (capabilitiesCalls++, capabilitiesData===false ? new Response('{}',{status:404}) : new Response(JSON.stringify(capabilitiesData || defaultCapabilities)))
    : fetch(url,options);
  const domNodes=[];
  const context={AbortController,setTimeout,clearTimeout,performance,fetch:guardedFetch,console,Response,Headers,TextDecoder,Uint8Array,
    document:{querySelectorAll(){return domNodes; }},
    browser:{runtime:{id:'nlr',getURL:p=>p,getManifest:()=>
          JSON.parse(fs.readFileSync(path.join(__dirname,'..','manifest.json'),'utf8')),
        onMessage:{addListener:fn=>handler=fn},
        onConnect:{addListener:fn=>connect=fn},onInstalled:event,onStartup:event},
      permissions:{getAll:async()=>{if(permissionFailure)throw new Error('synthetic permission failure');return {origins:granted,data_collection:dataCollection};},contains:async()=>false,
        remove:async()=>true,onAdded:event,onRemoved:event},
      scripting:{getRegisteredContentScripts:async()=>[],
        unregisterContentScripts:async()=>undefined,
        registerContentScripts:async scripts=>{registered.push(...scripts);}},
      storage:{local:{get:async key=>typeof key==='string'?{[key]:store[key]}:{...store},set:async value=>Object.assign(store,value)}},action:{onClicked:{addListener:fn=>actionClick=fn},
        setBadgeText:async()=>undefined,setTitle:async()=>undefined},
      tabs:{onRemoved:event,onUpdated:event,create:async p=>p,query:async()=>liveTabs,
        sendMessage:async(id,message)=>{sent.push({id,message});return liveTabs.find(tab=>tab.id===id)?.alive?{ok:true}:Promise.reject(new Error('Receiving end does not exist'));}}}};
  context.browser.scripting.insertCSS=async details=>injected.push({kind:'css',details});
  context.browser.scripting.executeScript=async details=>{
    const kind=details.files?'file':'cleanup';
    injected.push({kind,details});
    if (kind==='cleanup' && details.func) details.func();
    if(kind==='file') {
      const tab=liveTabs.find(item=>item.id===details.target.tabId);
      if(tab) tab.alive=true;
    }
  };
  vm.createContext(context);
  for(const file of ['protocol.js','settings-schema.js','queue.js','background.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  return {message:(m,sender={id:'nlr',tab:{id:1}})=>handler(m,sender),connect:(...a)=>connect(...a),
    store,registered,sent,injected,queue:context.queue,sync:()=>context.syncRegisteredScripts(),
    heal:()=>context.healAuthorizedTabs(),click:tab=>actionClick(tab),protocol:context.NovelProtocol,
    capabilities:()=>context.capabilities(),capabilitiesCalls:()=>capabilitiesCalls,limitedErrorText:context.limitedErrorText,
    inject:(...args)=>context.injectReader(...args),domNodes,context};
}

function optionsPage(background, {healthReply}={}) {
  const nodes = new Map();
  const makeNode = () => ({value:'',textContent:'',disabled:false,hidden:false,listeners:{},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    appendChild(child) { (this.children ||= []).push(child); },
    append(...children) { (this.children ||= []).push(...children); },
    replaceChildren() { this.children = []; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? submitButton : null; }});
  const selectors = ['#pair-form','#pair-token','#pair-status','#origin-status','#origin-list',
    '#allow-all','#origin-request','#allow-origin'];
  for (const selector of selectors) nodes.set(selector, makeNode());
  const submitButton = makeNode();
  nodes.get('#pair-form').querySelector = selector => selector === 'button[type="submit"]' ? submitButton : null;
  const stored = [];
  const hostMessages = [];
  const runtime = {
    sendMessage(message) {
      if (message.type === 'health') hostMessages.push('health');
      if (message.type === 'health' && healthReply) return healthReply();
      return background.message(message, {id:'nlr',tab:{id:88}});
    }
  };
  const browser = {
    runtime,
    storage: {
      local: {
        set: async value => { stored.push(Object.keys(value)); Object.assign(background.store,value); },
        get: async key => typeof key === 'string' ? {[key]:background.store[key]} : {...background.store}
      },
      onChanged: {addListener(){},removeListener(){}}
    },
    permissions: {getAll:async()=>({origins:[],data_collection:['authenticationInfo','websiteContent']})},
    i18n: {getUILanguage:()=> 'en'}
  };
  const window = {addEventListener(){}};
  const context = {
    browser,window,location:{hash:''},Intl,console,setTimeout:(callback,delay,...args)=>
      setTimeout(callback,delay === 10000 ? 8 : delay,...args),clearTimeout,
    document:{querySelector:selector=>nodes.get(selector) || null,querySelectorAll:()=>[],
      createElement:()=>makeNode(),documentElement:{setAttribute(){}}}
  };
  context.globalThis=context;
  vm.createContext(context);
  for (const file of ['settings-schema.js','i18n.js','options.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context,{filename:file});
  }
  return {form:nodes.get('#pair-form'),input:nodes.get('#pair-token'),status:nodes.get('#pair-status'),
    button:submitButton,stored,hostMessages,submit:async()=>nodes.get('#pair-form').listeners.submit({preventDefault(){}})};
}

test('reinjection cleanup survives an invalidated old dispose and reaches the new reader',async()=>{
  const h=harness(async()=>{throw new Error('unused');},undefined,[{id:12,alive:false}]);
  const removed=[];
  h.domNodes.push({remove(){removed.push(this);}} , {remove(){removed.push(this);}});
  h.context.__novelLocalReaderLoaded=true;
  h.context.__nlrDispose=()=>{throw new Error('invalidated context');};
  // The function runs in the real injected cleanup context, not a copied test helper.
  // The harness context is reachable through the captured function global.
  await h.inject(12,{toggle:true});
  assert.equal(h.injected.filter(item=>item.kind==='file').length,1);
  assert.equal(h.sent.some(item=>item.id===12 && item.message.type==='toggle-panel'),true);
  assert.equal(removed.length,2);
  assert.equal(h.context.__novelLocalReaderLoaded,undefined);
  assert.deepEqual([...h.injected.find(item=>item.kind==='file').details.files],['protocol.js','content-runtime.js','content-playback.js','settings-schema.js','i18n.js','content-document.js','content-progress.js','content-navigation.js','content-panel.js','content.js']);
});
test('background sends token only to loopback and returns binary audio',async()=>{
  const requests=[];
  const h=harness(async(url,options)=>{
    requests.push({url,options});
    return new Response(new Uint8Array(64),{headers:{'Content-Type':'audio/wav','X-NLR-Duration':'1','X-NLR-Cache':'MISS'}});
  });
  const result=await h.message({type:'synthesize',scope:'s',payload:{text:'hello'}});
  assert.equal(result.buffer.byteLength,64);
  assert.equal(result.base64,undefined);
  assert.equal(requests[0].url,'http://127.0.0.1:8081/v1/audio/speech');
  assert.equal(requests[0].options.headers.Authorization,'Bearer test-token');
  assert.equal(result.token,undefined);
});
test('required data consent blocks host requests before token or text leaves the extension',async()=>{
  const requests=[];
  const h=harness(async(url,options)=>{requests.push({url,options});return new Response(new Uint8Array(64));},
    undefined,[],null,null);
  await assert.rejects(h.message({type:'synthesize',scope:'s',payload:{text:'synthetic sample'}}),
    error=>error.code==='DATA_CONSENT_REQUIRED');
  await assert.rejects(h.message({type:'warm-cache',scope:'s',payload:{text:'synthetic sample'}}),
    error=>error.code==='DATA_CONSENT_REQUIRED');
  assert.equal(requests.length,0);
});
test('accepted required manifest consent allows personalized speech and warm-cache parameters without optional consent',async()=>{
  const requests=[];
  const h=harness(async(url,options)=>{
    requests.push({url,options});
    return new Response(new Uint8Array(64),{headers:{'Content-Type':'audio/wav','X-NLR-Duration':'1'}});
  },undefined,[],null,['authenticationInfo','websiteContent']);
  await h.message({type:'synthesize',scope:'s',payload:{text:'synthetic sample',voice:'custom-voice',temperature:1.7,seed:99}});
  const speech=requests.find(request=>String(request.url).endsWith('/v1/audio/speech'));
  assert.ok(speech);
  assert.deepEqual(JSON.parse(speech.options.body),{
    input:'synthetic sample',voice:'custom-voice',temperature:1.7,seed:99,response_format:'wav'
  });
  assert.equal(JSON.parse(speech.options.body).url,undefined);
  assert.equal(JSON.parse(speech.options.body).title,undefined);
  const warmHarness=harness(async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>({status:'ready',cached:false,duration:1,elapsed:.1,fingerprint:'d'.repeat(64)}),
      headers:new Headers()};
  },undefined,[],null,['authenticationInfo','websiteContent']);
  await warmHarness.message({type:'warm-cache',scope:'s',payload:{text:'synthetic future',voice:'custom-voice',temperature:1.7,seed:99}});
  const warm=requests.find(request=>String(request.url).endsWith('/v1/nlr/cache/warm'));
  assert.deepEqual(JSON.parse(warm.options.body),{
    input:'synthetic future',voice:'custom-voice',temperature:1.7,seed:99
  });
});
test('settings messages normalize without writing and patch only accepted fields',async()=>{
  const h=harness(async()=>{throw new Error('unused');});
  h.store.nlrSettings={voice:'kept',prefetch:4,temperature:1};
  const restored=await h.message({type:'settings-get'});
  assert.equal(restored.settings.voice,'kept');assert.equal(restored.settings.playbackRate,1);
  assert.equal(restored.settings_protocol,1);assert.equal(restored.implementation,'background-patch-v1');
  assert.deepEqual(h.store.nlrSettings,{voice:'kept',prefetch:4,temperature:1});
  const updated=await h.message({type:'settings-update',patch:{prefetch:0,autoNext:false}});
  assert.equal(updated.revision,1);assert.equal(h.store.nlrSettingsRevision,1);assert.deepEqual([...updated.accepted_keys],['autoNext','prefetch']);assert.deepEqual({...h.store.nlrSettings},{voice:'kept',prefetch:0,temperature:1,autoNext:false});
  await h.message({type:'settings-update',patch:{expressionMode:'smart'}});
  await assert.rejects(h.message({type:'settings-update',patch:{expressionMode:'unknown'}}),/inválida/);
  await assert.rejects(h.message({type:'settings-update',patch:{unknown:true}}),/inválida/);
  await assert.rejects(h.message({type:'settings-update',patch:{temperature:3}}),/inválida/);
});

test('settings updates from concurrent tabs are serialized and preserve each field',async()=>{
  const h=harness(async()=>{throw new Error('unused');});h.store.nlrSettings={voice:'base'};
  const [a,b]=await Promise.all([
    h.message({type:'settings-update',patch:{playbackRate:1.25}},{id:'nlr',tab:{id:1}}),
    h.message({type:'settings-update',patch:{prefetch:3}},{id:'nlr',tab:{id:2}})
  ]);
  assert.ok(b.revision>a.revision);assert.equal(h.store.nlrSettings.voice,'base');assert.equal(h.store.nlrSettings.playbackRate,1.25);assert.equal(h.store.nlrSettings.prefetch,3);
  assert.equal('token' in a,false);
});
test('content runtime reaches the real background listener for settings envelopes',async()=>{
  const h=harness(async()=>{throw new Error('unused');});
  const context={crypto:{randomUUID:()=> 'scope'},AbortController,setTimeout,clearTimeout,console,
    browser:{runtime:{sendMessage:message=>h.message(message,{id:'nlr',tab:{id:44}})}}};
  context.globalThis=context;vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..','content-runtime.js'),'utf8'),context);
  const runtime=context.NovelLocalReader.runtime.create({browser:context.browser});
  const snapshot=await runtime.send({type:'settings-get'});
  assert.equal(snapshot.implementation,'background-patch-v1');assert.equal(snapshot.settings_protocol,1);
  const updated=await runtime.send({type:'settings-update',patch:{temperature:0,autoNext:false,voice:''}});
  assert.deepEqual([...updated.accepted_keys],['autoNext','temperature','voice']);assert.equal(updated.revision,1);runtime.dispose();
});
test('capable host warms through JSON without materialising or returning WAV',async()=>{
  const requests=[];
  const caps={service_version:'1.5.0',protocol:{current:1,minimum:1,maximum:1},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:true,offline_cache_hits:true}};
  const h=harness(async(url,options)=>{
    requests.push({url,options});
    return {ok:true,json:async()=>({status:'ready',cached:false,duration:1.2,elapsed:.03,fingerprint:'a'.repeat(64)}),arrayBuffer:async()=>{throw new Error('warm must not read WAV');},headers:new Headers()};
  },undefined,[],caps);
  const result=await h.message({type:'warm-cache',scope:'future',payload:{text:'future paragraph'}});
  assert.deepEqual({...result},{ok:true,warm:true,cached:false,duration:1.2,elapsed:.03,fingerprint:'a'.repeat(64)});
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/\/v1\/nlr\/cache\/warm$/);
  assert.equal(result.buffer,undefined);
  assert.equal(JSON.parse(requests[0].options.body).input,'future paragraph');
});
test('legacy or conservative capabilities never download speech as a warm fallback',async()=>{
  const requests=[];
  const legacy={service_version:'1.4.0',protocol:{current:1,minimum:1,maximum:1},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}};
  const h=harness(async(url)=>{requests.push(String(url));return new Response(new Uint8Array(64));},undefined,[],legacy);
  const result=await h.message({type:'warm-cache',scope:'future',payload:{text:'future'}});
  assert.deepEqual({...result},{ok:false,warm:true,available:false,code:'WARM_CACHE_UNAVAILABLE'});
  assert.equal(requests.filter(url=>url.endsWith('/v1/audio/speech')).length,0);
  assert.equal(requests.filter(url=>url.endsWith('/v1/nlr/cache/warm')).length,0);
});
test('warm validates JSON and retries only one transient structured failure',async()=>{
  let warm=0,health=0;
  const caps={service_version:'1.5.0',protocol:{current:1,minimum:1,maximum:1},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:true,offline_cache_hits:true}};
  const h=harness(async url=>{
    if(String(url).endsWith('/health')) {health++;return new Response('{"upstream":true}');}
    if(String(url).endsWith('/v1/nlr/cache/warm') && ++warm===1)
      return new Response('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"offline","retryable":true}}',{status:502});
    return new Response(JSON.stringify({status:'ready',cached:true,duration:1,elapsed:0,fingerprint:'b'.repeat(64)}));
  },undefined,[],caps);
  assert.equal((await h.message({type:'warm-cache',scope:'s',payload:{text:'x'}})).cached,true);
  assert.equal(warm,2);assert.equal(health,1);
  const malformed=harness(async()=>new Response('{"status":"ready"}'),undefined,[],caps);
  await assert.rejects(malformed.message({type:'warm-cache',scope:'s',payload:{text:'x'}}),/inválida/);
});
test('synthetic warm benchmark transfers metadata, not a duration-sized WAV',async()=>{
  const wavBytes=2*1024*1024;
  const envelope={status:'ready',cached:false,duration:600,elapsed:.1,fingerprint:'c'.repeat(64)};
  const jsonBytes=new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  const caps={service_version:'1.5.0',protocol:{current:1,minimum:1,maximum:1},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:true,offline_cache_hits:true}};
  const h=harness(async()=>({ok:true,json:async()=>envelope,arrayBuffer:async()=>{throw new Error('WAV transfer');},headers:new Headers()}),undefined,[],caps);
  const result=await h.message({type:'warm-cache',scope:'benchmark',payload:{text:'synthetic'}});
  assert.equal(result.buffer,undefined);
  assert.equal(result.warm,true);
  assert.equal(jsonBytes < 256,true);
  assert.equal(wavBytes > jsonBytes * 1000,true);
});
test('non-recoverable HTTP failure is reported once without unsafe fallback',async()=>{
  let requests=0;
  const h=harness(async()=>{requests++;return new Response('{"error":"invalid"}',{status:400});});
  await assert.rejects(h.message({type:'synthesize',scope:'s',payload:{text:'hello'}}),/não reconhecido/);
  assert.equal(requests,1);
});
test('a crashed TTS is retried once only after health reports it ready',async()=>{
  const requests=[];
  const h=harness(async(url)=>{
    requests.push(url);
    if(url.endsWith('/health')) return new Response('{"upstream":true}');
    if(requests.filter(value=>value.endsWith('/v1/audio/speech')).length===1)
      return new Response('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"offline","retryable":true}}',{status:502});
    return new Response(new Uint8Array(64),{headers:{'X-NLR-Duration':'1'}});
  });
  const result=await h.message({type:'synthesize',scope:'s',payload:{text:'hello'}});
  assert.equal(result.buffer.byteLength,64);
  assert.equal(requests.filter(value=>value.endsWith('/v1/audio/speech')).length,2);
  assert.equal(requests.filter(value=>value.endsWith('/health')).length,1);
});
test('incompatible protocol blocks synthesis before text is sent',async()=>{
  let speech=0;
  const h=harness(async url=>{if(String(url).endsWith('/v1/audio/speech'))speech++;return new Response(new Uint8Array(64));},undefined,[],
    {service_version:'2.0.0',protocol:{current:2,minimum:2,maximum:2},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}});
  await assert.rejects(h.message({type:'synthesize',scope:'s',payload:{text:'private'}}),/incompatível/);
  assert.equal(speech,0);
});
test('protocol parses compatible, legacy, malformed errors and retry allowlist',()=>{
  const h=harness(async()=>{throw new Error('unused');}); const p=h.protocol;
  assert.equal(p.capabilities({service_version:'1.5.0',protocol:{current:1,minimum:1,maximum:1},backend:{name:'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:true,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}}).compatible,true);
  const legacy=p.legacy({version:'1.4.0',backend:'qwen3'});
  assert.equal(legacy.legacy,true);
  assert.equal(legacy.capabilities.multiple_voices,false);
  assert.throws(()=>p.capabilities({}),/inválidas/);
  assert.equal(p.error(503,'not json').retryable,false);
  assert.equal(p.shouldRetry({code:'UPSTREAM_TIMEOUT',retryable:true}),true);
  assert.equal(p.shouldRetry({code:'CACHE_UNAVAILABLE',retryable:true}),false);
});
test('host without the capabilities endpoint is conservatively identified and does not claim multiple voices',async()=>{
  const h=harness(async url=>{
    if(String(url).endsWith('/health'))return new Response(JSON.stringify({version:'1.4.0',service_version:'1.4.0',backend:'qwen3',protocol:{current:1,minimum:1,maximum:1}}));
    throw new Error('unexpected endpoint');
  },undefined,[],false);
  const result=await h.capabilities();
  assert.equal(result.compatible,true);assert.equal(result.legacy,false);assert.equal(result.serviceVersion,'1.4.0');
  assert.equal(result.capabilities.cache_warming,false);assert.equal(result.capabilities.multiple_voices,false);
});
test('handshake is shared, cached and invalidated when the token changes',async()=>{
  const h=harness(async()=>{throw new Error('unexpected');});
  const [a,b]=await Promise.all([h.capabilities(),h.capabilities()]);
  assert.equal(a.compatible,true);assert.equal(b.compatible,true);assert.equal(h.capabilitiesCalls(),1);
  await h.capabilities();assert.equal(h.capabilitiesCalls(),1);
  h.store.nlrConnection.token='new-token';await h.capabilities();assert.equal(h.capabilitiesCalls(),2);
});
test('error reader caps streamed bytes and cancels the body',async()=>{
  let canceled=false;let reads=0;
  const response={body:{getReader(){return {
    async read(){reads++;return reads===1?{done:false,value:new Uint8Array(20000).fill(65)}:{done:true};},
    async cancel(){canceled=true;}, releaseLock(){}
  };}}};
  const text=await hLimited(response);
  assert.equal(text.length,8192);assert.equal(canceled,true);assert.equal(reads,1);
});
async function hLimited(response){ return harness(async()=>{throw new Error('unused');}).limitedErrorText(response); }
test('external senders and arbitrary internal pages are rejected',async()=>{
  const h=harness(async()=>{throw new Error('Unexpected request');});
  assert.equal(h.message({type:'health'},{id:'other'}),undefined);
  await assert.rejects(h.message({type:'open-page',page:'../../secret'}),/inválida/);
});
test('unpaired extension explains setup without a network request',async()=>{
  const h=harness(async()=>{throw new Error('Unexpected request');});
  h.store.nlrConnection=null;
  const result=await h.message({type:'health'});
  assert.equal(result.ok,false);
  assert.equal(result.code,'PAIRING_KEY_MISSING');
  assert.doesNotMatch(result.error,/Bearer|token|Authorization/i);
});

test('real options submit listener saves the key then reaches the background listener and fake host',async()=>{
  const requests=[];let authorizationPresent=false;
  const h=harness(async(url,options)=>{
    requests.push(String(url));authorizationPresent=options.headers.Authorization.startsWith('Bearer ');
    return new Response(JSON.stringify({version:'1.5.0',backend:'qwen3',upstream:true}),
      {headers:{'Content-Type':'application/json'}});
  },undefined,[],null,['authenticationInfo','websiteContent']);
  const page=optionsPage(h);
  page.input.value='K'.repeat(40);
  await page.submit();
  assert.deepEqual(page.stored,[['nlrConnection']]);
  assert.equal(page.input.value,'');
  assert.equal(requests.length,1);
  assert.match(requests[0],/127\.0\.0\.1:8081\/health$/);
  assert.equal(authorizationPresent,true);
  assert.match(page.status.textContent,/Connected/i);
  assert.equal(page.button.disabled,false);
  assert.doesNotMatch(page.status.textContent,/K{10}|Bearer|Authorization/i);
});

test('real options submit listener presents an authentication rejection without exposing the key',async()=>{
  const requests=[];
  const h=harness(async url=>{
    requests.push(String(url));
    return new Response(JSON.stringify({error:{code:'AUTH_REQUIRED',message:'safe rejection',retryable:false}}),
      {status:401,headers:{'Content-Type':'application/json'}});
  },undefined,[],null,['authenticationInfo','websiteContent']);
  const page=optionsPage(h);page.input.value='R'.repeat(40);
  await page.submit();
  assert.equal(requests.length,1);
  assert.match(page.status.textContent,/rejected.*401/i);
  assert.doesNotMatch(page.status.textContent,/R{10}|Bearer|Authorization/i);
  assert.equal(page.button.disabled,false);
});

test('real options submit listener classifies host transport failure and exits connecting state',async()=>{
  const h=harness(async()=>{throw new TypeError('synthetic transport failure');},
    undefined,[],null,['authenticationInfo','websiteContent']);
  const page=optionsPage(h);page.input.value='T'.repeat(40);
  await page.submit();
  assert.match(page.status.textContent,/could not be reached/i);
  assert.notEqual(page.status.textContent,'Checking the local service…');
  assert.equal(page.button.disabled,false);
});

test('real options submit listener reports missing background response within its deadline',async()=>{
  const h=harness(async()=>{throw new Error('health must not reach host');});
  const page=optionsPage(h,{healthReply:()=>new Promise(()=>undefined)});
  page.input.value='B'.repeat(40);
  await page.submit();
  assert.match(page.status.textContent,/background did not respond in time/i);
  assert.notEqual(page.status.textContent,'Checking the local service…');
  assert.equal(page.button.disabled,false);
  assert.equal(page.hostMessages.length,1);
  assert.doesNotMatch(page.status.textContent,/B{10}|Bearer|Authorization/i);
});

test('real options submit listener reports consent gate and makes no companion request',async()=>{
  const requests=[];
  const h=harness(async url=>{requests.push(String(url));return new Response('{}');},
    undefined,[],null,null);
  const page=optionsPage(h);page.input.value='C'.repeat(40);
  await page.submit();
  assert.equal(requests.length,0);
  assert.match(page.status.textContent,/consent.*could not be confirmed/i);
  assert.equal(page.button.disabled,false);
  assert.doesNotMatch(page.status.textContent,/C{10}|Bearer|Authorization/i);
});
test('dynamic registration covers only origins the user authorised',async()=>{
  const bare=harness(async()=>{throw new Error('Unexpected request');});
  await bare.sync();
  assert.equal(bare.registered.length,0);

  const allowed=harness(async()=>{throw new Error('Unexpected request');},
    ['http://127.0.0.1:8081/*','https://novel.test/*']);
  await allowed.sync();
  // Arrays built inside the vm belong to another realm, so copy before comparing.
  assert.deepEqual([...allowed.registered[0].matches],['https://novel.test/*']);
  assert.deepEqual([...allowed.registered[0].js],['protocol.js','content-runtime.js','content-playback.js','settings-schema.js','i18n.js','content-document.js','content-progress.js','content-navigation.js','content-panel.js','content.js']);
  assert.deepEqual([...allowed.registered[0].css],['page-overlay.css']);
});
test('a disconnected session port cancels that scope only',async()=>{
  // Behave like real fetch: an already-aborted signal rejects straight away,
  // otherwise reject when the abort arrives. Never settling would leave api()'s
  // timeout timer installed and keep the process alive.
  const aborted=()=>Object.assign(new Error('aborted'),{name:'AbortError'});
  const h=harness((url,options)=>options.signal.aborted
    ? Promise.reject(aborted())
    : new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(aborted()))));
  const listeners=[];
  const port={name:'nlr-session:scope-a',sender:{id:'nlr',tab:{id:7}},
    onDisconnect:{addListener:fn=>listeners.push(fn)},disconnect(){}};
  h.connect(port);
  const pending=h.message({type:'synthesize',scope:'scope-a',payload:{text:'hello'}},{id:'nlr',tab:{id:7}});
  const rejection=assert.rejects(pending,/cancelada/);
  for(const listener of listeners)listener();
  await rejection;
});
test('a port from another extension is refused',()=>{
  const h=harness(async()=>{throw new Error('Unexpected request');});
  let disconnected=false;
  h.connect({name:'nlr-session:x',sender:{id:'other'},disconnect(){disconnected=true;},
    onDisconnect:{addListener(){}}});
  assert.equal(disconnected,true);
});
test('startup healing reinjects only an authorised tab with an orphaned reader',async()=>{
  const h=harness(async()=>{throw new Error('Unexpected request');},
    ['http://127.0.0.1:8081/*','https://novel.test/*'],
    [{id:5,alive:false},{id:6,alive:true}]);
  await h.heal();
  assert.equal(h.injected.filter(item=>item.kind==='file').length,1);
  assert.equal(h.injected.find(item=>item.kind==='file').details.target.tabId,5);
  assert.ok(h.sent.some(item=>item.id===6 && item.message.type==='nlr-probe'));
});
test('toolbar click repairs an activeTab reader without asking for a page reload',async()=>{
  const h=harness(async()=>{throw new Error('Unexpected request');},undefined,[{id:9,alive:false}]);
  await h.click({id:9});
  assert.equal(h.injected.filter(item=>item.kind==='file').length,1);
  assert.ok(h.sent.some(item=>item.id===9 && item.message.type==='toggle-panel'));
  assert.equal(h.injected.find(item=>item.kind==='file').details.target.tabId,9);
  assert.deepEqual([...h.injected.find(item=>item.kind==='file').details.files],['protocol.js','content-runtime.js','content-playback.js','settings-schema.js','i18n.js','content-document.js','content-progress.js','content-navigation.js','content-panel.js','content.js']);
});
