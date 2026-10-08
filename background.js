const API = 'http://127.0.0.1:8081';
const REQUIRED_DATA_COLLECTION = Object.freeze(['authenticationInfo', 'websiteContent']);
const queue = new SynthesisQueue(runQueuedJob);
const ownerOf = sender => sender.tab ? 'tab:' + sender.tab.id : 'extension';
let identityCache = null;
let capabilitiesCache = null;
let capabilitiesPromise = null;
const protocol = globalThis.NovelProtocol;
const settingsSchema = globalThis.NovelLocalReader.settingsSchema;
let settingsRevision=0;
let settingsQueue=Promise.resolve();
function validSetting(key,value){return settingsSchema.valid(key,value);}
async function settingsGet(){const saved=await browser.storage.local.get(['nlrSettings','nlrSettingsRevision']);settingsRevision=Math.max(settingsRevision,Number.isInteger(saved.nlrSettingsRevision)?saved.nlrSettingsRevision:0);return {ok:true,settings:settingsSchema.normalize(saved.nlrSettings),revision:settingsRevision,accepted_keys:[...settingsSchema.keys],settings_protocol:settingsSchema.protocolVersion,implementation:settingsSchema.implementation};}
function settingsUpdate(patch){if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length)return Promise.reject(new Error('Atualização de preferências inválida.'));for(const [key,value]of Object.entries(patch))if(!validSetting(key,value))return Promise.reject(new Error('Preferência inválida.'));const acceptedKeys=Object.keys(patch).sort();const operation=settingsQueue.catch(()=>undefined).then(async()=>{const saved=await browser.storage.local.get(['nlrSettings','nlrSettingsRevision']);const current=saved.nlrSettings&&typeof saved.nlrSettings==='object'?saved.nlrSettings:{};settingsRevision=Math.max(settingsRevision,Number.isInteger(saved.nlrSettingsRevision)?saved.nlrSettingsRevision:0)+1;await browser.storage.local.set({nlrSettings:{...current,...patch},nlrSettingsRevision:settingsRevision});return {ok:true,revision:settingsRevision,accepted_keys:acceptedKeys,settings_protocol:settingsSchema.protocolVersion,implementation:settingsSchema.implementation};});settingsQueue=operation.catch(()=>undefined);return operation;}

// There is no blanket content script any more. The reader is injected into the
// active tab when the toolbar button is used (activeTab), and registered
// persistently only for origins the user explicitly authorised in the options
// page. Every other site is never touched.
const AUTO_SCRIPT_ID = 'nlr-auto-continue';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:8081/*';

async function grantedOrigins() {
  const granted = await browser.permissions.getAll();
  return (granted.origins || []).filter(origin => origin !== LOOPBACK_ORIGIN);
}

async function syncRegisteredScripts() {
  const origins = await grantedOrigins();
  const registered = await browser.scripting.getRegisteredContentScripts({ids:[AUTO_SCRIPT_ID]}).catch(() => []);
  if (registered.length) await browser.scripting.unregisterContentScripts({ids:[AUTO_SCRIPT_ID]}).catch(() => undefined);
  if (!origins.length) return;
  await browser.scripting.registerContentScripts([{
    id: AUTO_SCRIPT_ID, matches: origins, js: ['protocol.js','content-runtime.js','content-playback.js','settings-schema.js','i18n.js','content-document.js','content-progress.js','content-navigation.js','content-panel.js','content.js'], css: ['page-overlay.css'],
    runAt: 'document_idle', persistAcrossSessions: true
  }]).catch(error => console.warn('[nlr] registro de script falhou:', error.message));
}
async function readerIsAlive(tabId) {
  try {
    const reply = await browser.tabs.sendMessage(tabId,{type:'nlr-probe'});
    return reply?.ok === true;
  } catch {
    return false;
  }
}
async function injectReader(tabId,{toggle=false}={}) {
  await browser.scripting.insertCSS({target:{tabId},files:['page-overlay.css']}).catch(() => undefined);
  await browser.scripting.executeScript({target:{tabId},func:() => {
    // A global from an extension context invalidated by an update may no
    // longer be callable. Removing its host from the page works across that
    // boundary and prevents duplicate closed shadow roots.
    try {
      if (typeof globalThis.__nlrDispose === 'function') {
        globalThis.__nlrDispose();
      }
    } catch {
      // The previous extension context may already have been invalidated.
    } finally {
      delete globalThis.__nlrDispose;
      delete globalThis.__novelLocalReaderLoaded;
      document.querySelectorAll('nlr-reader-host,#nlr-reconnect-notice').forEach(node => node.remove());
    }
  }});
  await browser.scripting.executeScript({target:{tabId},files:['protocol.js','content-runtime.js','content-playback.js','settings-schema.js','i18n.js','content-document.js','content-progress.js','content-navigation.js','content-panel.js','content.js']});
  if (toggle) await browser.tabs.sendMessage(tabId,{type:'toggle-panel'});
}
async function healAuthorizedTabs() {
  const origins = await grantedOrigins();
  if (!origins.length) return;
  const tabs = await browser.tabs.query({url:origins}).catch(() => []);
  await Promise.allSettled(tabs.filter(tab => tab.id).map(async tab => {
    if (!await readerIsAlive(tab.id)) await injectReader(tab.id);
  }));
}
async function initializeBackground() {
  await syncRegisteredScripts();
  await healAuthorizedTabs();
}
browser.runtime.onInstalled.addListener(initializeBackground);
browser.runtime.onStartup.addListener(initializeBackground);
browser.permissions.onAdded.addListener(initializeBackground);
browser.permissions.onRemoved.addListener(syncRegisteredScripts);
// Temporary-extension reloads do not consistently produce an install/startup
// event. Running once when this background context starts also repairs tabs
// left behind by about:debugging reloads.
initializeBackground().catch(error => console.warn('[nlr] inicialização falhou:',error.message));

browser.action.onClicked.addListener(async tab => {
  if (!tab.id) return;
  try {
    if (await readerIsAlive(tab.id)) await browser.tabs.sendMessage(tab.id,{type:'toggle-panel'});
    else await injectReader(tab.id,{toggle:true});
  } catch {
    await browser.action.setBadgeText({tabId:tab.id,text:'!'});
    const saved = await browser.storage.local.get('nlrSettings').catch(() => ({}));
    globalThis.NovelLocalReader.i18n.setLanguage(saved.nlrSettings?.interfaceLanguage || 'auto', browser);
    await browser.action.setTitle({tabId:tab.id,title:globalThis.NovelLocalReader.i18n.t('status.readerUnavailable')});
    return;
  }
  await browser.action.setBadgeText({tabId:tab.id,text:''});
});
browser.tabs.onRemoved.addListener(id => queue.cancel('tab:' + id));
browser.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading') queue.cancel('tab:' + id);
});

// A reading session holds a port open. Firefox keeps the event page alive while
// a port is connected, so the in-memory queue survives an idle background, and
// disconnect covers tab crashes that onRemoved/onUpdated never report.
browser.runtime.onConnect.addListener(port => {
  if (port.sender?.id !== browser.runtime.id) return port.disconnect();
  const [name, scope] = port.name.split(':');
  if (name !== 'nlr-session' || !scope) return port.disconnect();
  const owner = ownerOf(port.sender);
  port.onDisconnect.addListener(() => queue.cancel(owner, scope));
});
browser.runtime.onMessage.addListener((message,sender) => {
  if (!message || sender.id !== browser.runtime.id) return undefined;
  const owner = ownerOf(sender);
  if (message.type === 'cancel-session') {
    queue.cancel(owner,message.scope);
    return Promise.resolve({ok:true});
  }
  if (message.type === 'profile') return profile();
  if (message.type === 'settings-get') return settingsGet();
  if (message.type === 'settings-update') return settingsUpdate(message.patch);
  if (message.type === 'health') return health();
  if (message.type === 'capabilities') return capabilities();
  if (message.type === 'voices') return api('/voices').then(r=>r.json()).then(data=>({ok:true,...data}));
  if (message.type === 'cache-stats') return api('/cache/stats').then(r=>r.json()).then(data=>({ok:true,mode:'hd',...data}));
  if (message.type === 'clear-cache') return api('/cache',{method:'DELETE'}).then(()=>({ok:true}));
  if (message.type === 'panel-css') {
    // Extension pages may read their own packaged files without web accessibility.
    return Promise.all(['themes.css','content.css'].map(file =>
      fetch(browser.runtime.getURL(file)).then(response => response.text())
    )).then(parts => ({ok:true, css: parts.join('\n')}));
  }
  if (message.type === 'granted-origins') return grantedOrigins().then(origins => ({ok:true, origins}));
  if (message.type === 'forget-origin') {
    if (typeof message.origin !== 'string' || message.origin === LOOPBACK_ORIGIN) return Promise.reject(new Error('Origem inválida.'));
    return browser.permissions.remove({origins:[message.origin]}).then(removed => ({ok:removed}));
  }
  if (message.type === 'origin-allowed') {
    if (typeof message.origin !== 'string') return Promise.resolve({ok:true, allowed:false});
    return browser.permissions.contains({origins:[message.origin]}).then(allowed => ({ok:true, allowed}));
  }
  if (message.type === 'open-page') {
    if (!['library.html','reader.html','options.html'].includes(message.page)) return Promise.reject(new Error('Página inválida.'));
    const hash = typeof message.hash === 'string' && /^[\w.:/*-]{1,200}$/.test(message.hash) ? '#' + message.hash : '';
    return browser.tabs.create({url:browser.runtime.getURL(message.page) + hash});
  }
  if (['synthesize','warm-cache'].includes(message.type)) {
    if (typeof message.scope !== 'string' || message.scope.length > 100) return Promise.reject(new Error('Sessão inválida.'));
    return queue.enqueue(owner,message.scope,{kind:message.type === 'warm-cache' ? 'warm' : 'speech', payload:message.payload},
      message.type === 'warm-cache' ? -1 : (message.priority ?? 1));
  }
  return undefined;
});

async function token() {
  const saved = await browser.storage.local.get('nlrConnection');
  if (!saved.nlrConnection?.token) {
    const error = new Error('Conecte o serviço local em Sistema → Conexão.');
    Object.assign(error, {code:'PAIRING_KEY_MISSING', retryable:false});
    throw error;
  }
  return saved.nlrConnection.token;
}

async function assertDataCollectionConsent() {
  let manifest;
  let permissions;
  try {
    manifest = browser.runtime.getManifest();
    permissions = await browser.permissions.getAll();
  } catch {
    const error = new Error('NLR_DATA_CONSENT_CHECK_FAILED');
    Object.assign(error, {code:'PERMISSION_CHECK_FAILED', retryable:false});
    throw error;
  }
  const declared = manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required;
  // getAll() reports granted optional categories. Required categories are
  // accepted at install/update time; loading this extension proves acceptance.
  // An absent data_collection array means this Firefox lacks the consent API.
  if (!Array.isArray(declared) ||
      REQUIRED_DATA_COLLECTION.some(permission => !declared.includes(permission)) ||
      !Array.isArray(permissions.data_collection)) {
    const error = new Error('NLR_DATA_CONSENT_REQUIRED');
    Object.assign(error, {code:'DATA_CONSENT_REQUIRED', retryable:false});
    throw error;
  }
}

async function api(path, options={}, signal, timeout=5000, binary=false) {
  await assertDataCollectionConsent();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort',abort,{once:true});
  const timer = setTimeout(abort,timeout);
  try {
    const response = await fetch(API + path,{
      ...options, signal:controller.signal,
      headers:{'Content-Type':'application/json',Authorization:'Bearer ' + await token(),...(options.headers||{})}
    });
    if (!response.ok) {
      const failure = protocol.error(response.status, await limitedErrorText(response));
      const wrapped = new Error(failure.message);
      Object.assign(wrapped, failure);
      throw wrapped;
    }
    // Consume the complete body before clearing the timeout.
    if (binary) return {response,buffer:await response.arrayBuffer()};
    const data = await response.json();
    return {json:async()=>data};
  } catch(error) {
    if (controller.signal.aborted) {
      const failure = new Error(signal?.aborted ? 'Leitura cancelada.' : 'Tempo limite do serviço.');
      Object.assign(failure, {code:signal?.aborted ? 'REQUEST_CANCELLED' : 'HOST_TIMEOUT', retryable:false});
      throw failure;
    }
    if (error instanceof TypeError || error?.name === 'TypeError') {
      const failure = new Error('Serviço local indisponível.');
      Object.assign(failure, {code:'HOST_UNAVAILABLE', retryable:true});
      throw failure;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort',abort);
  }
}
async function limitedErrorText(response, limit=8192) {
  if (!response.body?.getReader) return '';
  const reader = response.body.getReader(); const chunks=[]; let size=0;
  try {
    while (size < limit) {
      const {value,done} = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const take = Math.min(bytes.byteLength, limit-size);
      chunks.push(bytes.slice(0,take)); size += take;
      if (take < bytes.byteLength) { await reader.cancel(); break; }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock?.(); }
  const merged = new Uint8Array(size); let offset=0;
  for (const chunk of chunks) { merged.set(chunk,offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8',{fatal:false}).decode(merged);
}
async function profile() {
  if (!identityCache || Date.now()-identityCache.at > 1500) {
    const data = await (await api('/identity')).json();
    if (identityCache?.fingerprint && identityCache.fingerprint !== data.fingerprint) capabilitiesCache = null;
    identityCache = {...data,at:Date.now()};
  }
  return identityCache;
}
async function health() {
  try {
    const data = await (await api('/health',{},undefined,8000)).json();
    const handshake = data.protocol ? protocol.capabilities({service_version:data.service_version || data.version,protocol:data.protocol,backend:{name:data.backend || 'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:false,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}}) : protocol.legacy(data);
    return {ok:true,data:{...data,backend:data.backend || data.mode,cache:'hd'},protocol:handshake,queue:{waiting:queue.pending.length,running:Boolean(queue.running)}};
  } catch(error) {
    const knownCodes = new Set([
      'DATA_CONSENT_REQUIRED', 'PERMISSION_CHECK_FAILED', 'PAIRING_KEY_MISSING',
      'AUTH_REQUIRED', 'HOST_TIMEOUT', 'HOST_UNAVAILABLE', 'HOST_FORBIDDEN',
      'ORIGIN_FORBIDDEN', 'INTERNAL_ERROR', 'ENDPOINT_NOT_FOUND'
    ]);
    const code = knownCodes.has(error?.code) ? error.code : 'HOST_RESPONSE_INVALID';
    const messages = {
      DATA_CONSENT_REQUIRED: 'Firefox data consent is unavailable; no request was sent.',
      PERMISSION_CHECK_FAILED: 'Firefox data consent could not be checked; no request was sent.',
      PAIRING_KEY_MISSING: 'Pair the extension with the local service.',
      AUTH_REQUIRED: 'The pairing key was rejected by the local service.',
      HOST_TIMEOUT: 'The local service did not respond in time.',
      HOST_UNAVAILABLE: 'The local service could not be reached.',
      HOST_FORBIDDEN: 'The local service denied this extension.',
      ORIGIN_FORBIDDEN: 'The local service denied this request origin.',
      ENDPOINT_NOT_FOUND: 'The local service does not provide the health endpoint.',
      INTERNAL_ERROR: 'The local service reported an error.',
      HOST_RESPONSE_INVALID: 'The local service returned an invalid response.'
    };
    return {ok:false,code,error:messages[code]};
  }
}
async function capabilities(signal) {
  const connectionToken = await token();
  if (capabilitiesCache?.token === connectionToken && Date.now() - capabilitiesCache.at < 5000) return capabilitiesCache.value;
  if (capabilitiesPromise?.token === connectionToken) return capabilitiesPromise.promise;
  const promise = (async () => {
    try {
      const data = await (await api('/v1/nlr/capabilities', {})).json();
      return protocol.capabilities(data);
    } catch (error) {
      if (error.code !== 'ENDPOINT_NOT_FOUND') throw error;
      const healthData = await (await api('/health', {})).json();
      return healthData.protocol ? protocol.capabilities({service_version:healthData.service_version || healthData.version,protocol:healthData.protocol,backend:{name:healthData.backend || 'qwen3',variant:'base'},capabilities:{voice_cloning:true,multiple_voices:false,deterministic_seed:true,temperature:true,style_instructions:false,cache_warming:false,offline_cache_hits:true}}) : protocol.legacy(healthData);
    }
  })();
  capabilitiesPromise = {token:connectionToken,promise};
  try { const value = await promise; capabilitiesCache = {at:Date.now(),token:connectionToken,value}; return value; }
  finally { if (capabilitiesPromise?.promise === promise) capabilitiesPromise = null; }
}
function pause(ms,signal) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new Error('Leitura cancelada.'));
    const timer=setTimeout(done,ms);
    function done(){ signal?.removeEventListener('abort',cancel); resolve(); }
    function cancel(){ clearTimeout(timer); signal?.removeEventListener('abort',cancel); reject(new Error('Leitura cancelada.')); }
    signal?.addEventListener('abort',cancel,{once:true});
  });
}
async function awaitTtsRestart(signal) {
  const deadline=Date.now()+45000;
  while (Date.now()<deadline) {
    if (signal?.aborted) throw new Error('Leitura cancelada.');
    try {
      const data=await (await api('/health',{},signal,5000)).json();
      if (data.upstream) return;
    } catch(error) {
      if (signal?.aborted) throw error;
    }
    await pause(1500,signal);
  }
  throw new Error('O TTS não voltou após a reinicialização. Execute novel-tts logs.');
}
async function synthesize(payload,signal) {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length>4000) throw new Error('Texto inválido.');
  const started = performance.now();
  const handshake = await capabilities(signal);
  if (!handshake.compatible) {
    const error = new Error('Protocolo incompatível: atualize o host ou a extensão.');
    Object.assign(error,{code:'PROTOCOL_INCOMPATIBLE',retryable:false});
    throw error;
  }
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const {response,buffer} = await api('/v1/audio/speech',{
        method:'POST',body:JSON.stringify({
          input:payload.text,voice:payload.voice?.trim().split(/[\\/]/).pop()||'',
          temperature:Number(payload.temperature??.9),seed:Number(payload.seed??42),
          ...(handshake.capabilities.style_instructions ? {instructions:payload.instructions||''} : {}),
          response_format:'wav'
        })
      },signal,310000,true);
      if (buffer.byteLength<44 || buffer.byteLength>32*1024*1024) throw new Error('Áudio inválido ou grande demais.');
      return {ok:true,buffer,mimeType:'audio/wav',cached:response.headers.get('X-NLR-Cache')==='HIT',
        duration:Number(response.headers.get('X-NLR-Duration')),elapsed:(performance.now()-started)/1000,
        fingerprint:response.headers.get('X-NLR-Identity')};
    } catch(error) {
      if (attempt===0 && protocol.shouldRetry(error)) {
        await awaitTtsRestart(signal);
        continue;
      }
      throw error;
    }
  }
}
function validateWarmResult(data) {
  if (!data || data.status !== 'ready' || typeof data.cached !== 'boolean' ||
      !Number.isFinite(data.duration) || data.duration < 0 ||
      !Number.isFinite(data.elapsed) || data.elapsed < 0 ||
      typeof data.fingerprint !== 'string' || !/^[a-f0-9]{32,128}$/i.test(data.fingerprint)) {
    throw new Error('Resposta de warm-cache inválida.');
  }
  return {ok:true, warm:true, cached:data.cached, duration:data.duration,
    elapsed:data.elapsed, fingerprint:data.fingerprint};
}
async function warmCache(payload,signal) {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length>4000) throw new Error('Texto inválido.');
  const handshake = await capabilities(signal);
  if (!handshake.compatible) {
    const error = new Error('Protocolo incompatível: atualize o host ou a extensão.');
    Object.assign(error,{code:'PROTOCOL_INCOMPATIBLE',retryable:false});
    throw error;
  }
  if (handshake.capabilities.cache_warming !== true) {
    return {ok:false, warm:true, available:false, code:'WARM_CACHE_UNAVAILABLE'};
  }
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const {json} = await api('/v1/nlr/cache/warm',
        {method:'POST',body:JSON.stringify({
          input:payload.text,voice:payload.voice?.trim().split(/[\\/]/).pop()||'',
          temperature:Number(payload.temperature??.9),seed:Number(payload.seed??42)
        })},signal,310000);
      return validateWarmResult(await json());
    } catch(error) {
      if (attempt===0 && protocol.shouldRetry(error)) { await awaitTtsRestart(signal); continue; }
      throw error;
    }
  }
}
async function runQueuedJob(job,signal) {
  if (!job || !['speech','warm'].includes(job.kind)) throw new Error('Trabalho de áudio inválido.');
  return job.kind === 'warm' ? warmCache(job.payload,signal) : synthesize(job.payload,signal);
}
