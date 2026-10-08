(() => {
  const root = globalThis.NovelLocalReader;
  if (!root || root.playback) return;

  function create(options) {
    const {
      runtime,
      audioFactory = () => new AudioContext(),
      getConfig,
      getProfile = async () => "",
      send,
      onStatus,
      onActive,
      onEnded,
      onError
    } = options;

    let context = null;
    let gain = null;
    let rate = 1;
    let disposed = false;
    let generation = 0;
    let intent = 0;
    let pausedAt = 0;
    let profileIdentity = null;
    let warmTimer = null;
    let warmStarted = false;
    const buffers = new Map();
    const pending = new Map();
    const sources = new Map();
    const warming = new Map();
    const warmed = new Set();

    function safely(callback, ...args) {
      try {
        callback?.(...args);
      } catch {
        // UI callbacks must never interrupt audio cleanup or resurrect a task.
      }
    }

    function configSnapshot() {
      return Object.freeze({...getConfig()});
    }

    function ensureContext() {
      if (!context) {
        context = audioFactory();
        gain = context.createGain();
        gain.gain.value = configSnapshot().volume;
        gain.connect(context.destination);
        rate = configSnapshot().playbackRate;
      }
      return context;
    }

    function synthesisKey(item) {
      return JSON.stringify([
        item.id, item.text, item.voice, item.language, item.temperature,
        item.seed, item.instructions, item.profile
      ]);
    }

    function synthesisPayload(item) {
      return {
        text: item.text,
        voice: item.voice,
        instructions: item.instructions,
        temperature: item.temperature,
        seed: item.seed,
        cacheLimitMb: item.cacheLimitMb
      };
    }

    function validateSpeech(result) {
      if (!result?.ok || !result.buffer?.byteLength) {
        throw new Error(result?.error || "O servidor não retornou áudio.");
      }
      return result.buffer;
    }

    function cleanupSource(entry, stopSource = false) {
      entry.source.onended = null;
      if (stopSource) {
        try { entry.source.stop(); } catch { /* already stopped */ }
      }
      try { entry.source.disconnect(); } catch { /* already disconnected */ }
    }

    function stopSources() {
      for (const entry of sources.values()) cleanupSource(entry, true);
      sources.clear();
    }

    function cancelWarmTimer() {
      if (warmTimer !== null) globalThis.clearTimeout(warmTimer);
      warmTimer = null;
    }

    function resetWarm() {
      cancelWarmTimer();
      warming.clear();
      warmed.clear();
      warmStarted = false;
    }

    async function ensureBuffer(item, priority = 1) {
      const profile = await getProfile();
      if (profileIdentity !== null && profileIdentity !== profile) invalidate("profile");
      profileIdentity = profile;
      const resolved = Object.freeze({...item, profile});
      const identity = synthesisKey(resolved);
      if (buffers.has(identity)) return buffers.get(identity);
      if (pending.has(identity)) return pending.get(identity);

      const token = generation;
      const request = send({type: "synthesize", priority, payload: synthesisPayload(resolved)})
        .then(validateSpeech)
        .then((bytes) => ensureContext().decodeAudioData(bytes))
        .then((decoded) => {
          if (!decoded?.duration || disposed || token !== generation) {
            throw new Error("Leitura substituída por outra.");
          }
          buffers.set(identity, decoded);
          return decoded;
        })
        .finally(() => {
          if (pending.get(identity) === request) pending.delete(identity);
        });
      pending.set(identity, request);
      return request;
    }

    async function schedule(item, scheduling = {}) {
      const {offset = 0, when, replace = false, priority = 1} = scheduling;
      if (disposed) return null;
      const token = generation;
      const playIntent = replace ? ++intent : intent;
      if (replace) stopSources();
      safely(onStatus, "loading", item);
      try {
        const buffer = await ensureBuffer(item, priority);
        if (disposed || token !== generation || (replace && playIntent !== intent)) return null;
        const audio = ensureContext();
        if (audio.state === "suspended") await audio.resume();
        if (disposed || token !== generation || (replace && playIntent !== intent)) return null;

        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.connect(gain);
        const start = Math.max(when ?? audio.currentTime, audio.currentTime);
        const safeOffset = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.15));
        const entry = {
          source, item, start, offset: safeOffset, duration: buffer.duration,
          endsAt: start + (buffer.duration - safeOffset) / rate
        };
        sources.set(item.id, entry);
        source.onended = () => {
          if (sources.get(item.id) !== entry || disposed) return;
          sources.delete(item.id);
          cleanupSource(entry);
          safely(onEnded, item);
        };
        source.start(start, safeOffset);
        pausedAt = 0;
        safely(onActive, item);
        safely(onStatus, "playing", item);
        return entry;
      } catch (error) {
        if (!disposed && token === generation) {
          stopSources();
          safely(onError, error);
        }
        return null;
      }
    }

    function elapsed() {
      const entry = sources.values().next().value;
      if (!entry || !context) return pausedAt;
      const played = (context.currentTime - entry.start) * rate;
      return Math.max(0, Math.min(entry.duration, entry.offset + played));
    }

    async function pause() {
      if (!context || !sources.size) return false;
      pausedAt = elapsed();
      await context.suspend();
      return true;
    }

    function stop({clearBuffers = false} = {}) {
      generation += 1;
      intent += 1;
      stopSources();
      pending.clear();
      pausedAt = 0;
      resetWarm();
      if (clearBuffers) buffers.clear();
    }

    function invalidate() {
      stop({clearBuffers: true});
    }

    function pruneAround(currentIndex, prefetchCount) {
      const keepBehind = 2;
      const keepAhead = Math.max(2, prefetchCount + 1);
      for (const [identity] of buffers) {
        const itemId = String(JSON.parse(identity)[0] || "");
        const index = Number(itemId.slice(itemId.lastIndexOf(":") + 1));
        if (index < currentIndex - keepBehind || index > currentIndex + keepAhead) {
          buffers.delete(identity);
        }
      }
    }

    function setRate(value) {
      if (rate === value) return Promise.resolve(false);
      const entry = sources.values().next().value;
      const offset = elapsed();
      const running = Boolean(entry && context?.state === "running");
      rate = value;
      if (entry && running) return schedule(entry.item, {offset, replace: true});
      if (entry) {
        stopSources();
        pausedAt = offset;
      }
      return Promise.resolve(Boolean(entry));
    }

    async function warmOne(item, token) {
      const identity = synthesisKey({...item, profile: await getProfile()});
      if (warmed.has(identity)) return {status: "ready", cached: true};
      if (warming.has(identity)) return warming.get(identity);
      const request = send({type: "warm-cache", payload: synthesisPayload(item)})
        .then((result) => {
          if (!result?.status || token !== generation || disposed) {
            throw new Error("Resposta de warm-cache inválida.");
          }
          warmed.add(identity);
          return result;
        })
        .finally(() => warming.get(identity) === request && warming.delete(identity));
      warming.set(identity, request);
      return request;
    }

    async function warm(items) {
      cancelWarmTimer();
      warmStarted = true;
      if (!configSnapshot().cacheWarming) return {available: false};
      const token = generation;
      for (const item of items) {
        if (disposed || token !== generation) return {cancelled: true};
        try { await warmOne(item, token); } catch (error) { safely(onError, error); }
      }
      return {available: true};
    }

    function scheduleWarm(callback, delay) {
      cancelWarmTimer();
      warmStarted = false;
      const token = generation;
      warmTimer = runtime.timer('timeout', () => {
        warmTimer = null;
        if (!disposed && token === generation && !warmStarted) callback();
      }, delay);
    }

    function dispose() {
      if (disposed) return false;
      disposed = true;
      invalidate("dispose");
      try { context?.close?.(); } catch { /* context already closed */ }
      return true;
    }

    runtime.register({dispose});
    return Object.freeze({
      play: (item, scheduling = {}) => schedule(item, {...scheduling, replace: true}),
      schedule,
      pause,
      resume: (item) => schedule(item, {offset: pausedAt, replace: true}),
      stop,
      prefetch: (item) => ensureBuffer(item, 0),
      warm,
      scheduleWarm,
      setVolume: (value) => { if (gain) gain.gain.value = value; },
      setRate,
      isPlaying: () => Boolean(sources.size && context?.state === "running"),
      elapsed,
      hasScheduled: (id) => sources.has(id),
      sourceCount: () => sources.size,
      currentEnd: () => sources.values().next().value?.endsAt ?? null,
      pruneAround,
      dispose,
      snapshot: () => Object.freeze({playing: Boolean(sources.size && context?.state === "running"), bufferCount: buffers.size, pendingCount: pending.size})
    });
  }

  root.playback = Object.freeze({create});
})();
