(() => {
  if (globalThis.NovelLocalReader?.runtime) return;
  if (globalThis.NovelLocalReader !== undefined && (typeof globalThis.NovelLocalReader !== 'object' || !globalThis.NovelLocalReader)) throw new Error('Namespace NovelLocalReader ocupado.');
  const root = globalThis.NovelLocalReader || (globalThis.NovelLocalReader = Object.create(null));
  function create({browser = globalThis.browser, onReconnect} = {}) {
    const MAX_ATTEMPTS = 3;
    const controller = new AbortController();
    const instanceId = crypto.randomUUID();
    let phase = 'initializing'; let disposed = false; let scope = crypto.randomUUID(); let port = null;
    const resources = new Set();
    const register = resource => { if (disposed) { try { resource?.dispose?.(); } catch {} return false; } resources.add(resource); return true; };
    const timer = (kind, fn, ms) => {
      if (disposed) return null;
      const repeat = kind === 'interval';
      if (!repeat && kind !== 'timeout') throw new Error('Tipo de timer inválido.');
      const id = repeat ? globalThis.setInterval(fn, ms) : globalThis.setTimeout(fn, ms);
      register({dispose: () => {
        if (repeat) globalThis.clearInterval(id);
        else globalThis.clearTimeout(id);
      }});
      return id;
    };
    const listen = (target, event, fn, options = {}) => { if (disposed) return false; const opts = {...(typeof options === 'boolean' ? {capture: options} : options), signal: controller.signal}; target.addEventListener(event, fn, opts); return true; };
    const dispose = () => { if (disposed) return false; disposed = true; phase = 'disposing'; controller.abort(); try { port?.disconnect(); } catch {} port = null; for (const r of [...resources]) { try { r?.dispose?.(); } catch {} } resources.clear(); phase = 'disposed'; return true; };
    const send = async message => {
      if (disposed) throw new Error('Sessão encerrada.');
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try { return await browser.runtime.sendMessage({scope, ...message}); }
        catch (error) {
          const detail = error?.message || String(error);
          const invalidated = /extension context invalidated/i.test(detail);
          const missingReceiver = /receiving end does not exist|message port closed/i.test(detail);
          if (invalidated) { onReconnect?.(); throw error; }
          if (!missingReceiver) throw error;
          if (attempt === MAX_ATTEMPTS - 1) { onReconnect?.(); throw error; }
          await new Promise((resolve, reject) => {
            if (controller.signal.aborted) {
              reject(new Error('Sessão encerrada.'));
              return;
            }
            const id = globalThis.setTimeout(() => {
              controller.signal.removeEventListener('abort', abort);
              resolve();
            }, 250 * (attempt + 1));
            const abort = () => { globalThis.clearTimeout(id); reject(new Error('Sessão encerrada.')); };
            controller.signal.addEventListener('abort', abort, {once:true});
          });
        }
      }
      throw new Error('Falha de comunicação.');
    };
    const openPort = () => { try { port?.disconnect(); port = browser.runtime.connect({name: `nlr-session:${scope}`}); port.onDisconnect?.addListener?.(() => { port = null; }); } catch { port = null; } return port; };
    const cancelScope = () => { send({type:'cancel-session', scope}).catch(() => undefined); try { port?.disconnect(); } catch {} port = null; scope = crypto.randomUUID(); };
    const session = Object.freeze({instanceId, get phase(){return phase;}, get disposed(){return disposed;}, get scope(){return scope;}, rotateScope(){if(disposed)return false;scope=crypto.randomUUID();return scope;}, activate(){if(disposed||phase!=='initializing')return false;phase='active';return true;}, beginDispose(){return dispose();}, register, disposeResources(){dispose();}});
    const api = Object.freeze({session, signal: controller.signal, register, timer, listen, send, openPort, closePort: () => { try { port?.disconnect(); } catch {} port = null; }, get hasPort(){return !!port;}, cancelScope, dispose, get disposed(){return disposed;}});
    return api;
  }
  root.runtime = Object.freeze({create});
})();
