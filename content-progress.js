(() => {
  if (globalThis.NovelLocalReader?.contentProgress) return;
  const root = globalThis.NovelLocalReader || (globalThis.NovelLocalReader = Object.create(null));
  const HISTORY_LIMIT = 500;
  // Every save rewrites the whole map, so it must not grow with every page ever read.
  const PROGRESS_LIMIT = 1000;
  const bounded = progress => {
    const entries = Object.entries(progress);
    if (entries.length <= PROGRESS_LIMIT) return progress;
    entries.sort(([, a], [, b]) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
    return Object.fromEntries(entries.slice(0, PROGRESS_LIMIT));
  };

  function create({scheduler = globalThis, storage, clock = Date, callbacks = {}, sessionValid = () => true,
    pageKey, context = {}} = {}) {
    let snapshot = Object.freeze({entries: Object.freeze([])});
    let index = -1;
    let resume = null;
    let timer = null;
    let write = Promise.resolve();
    let lastSave = 0;
    let disposed = false;
    let token = null;
    let completed = false;
    let progressContext = Object.freeze({...context, aliases: Object.freeze([...(context.aliases || [])])});
    const valid = value => !disposed && sessionValid(value) && value === token;
    const safe = (fn, value) => {
      try {
        fn?.(value);
      } catch {
        try { callbacks.onError?.(); } catch { /* visual errors stay contained */ }
      }
    };
    const visualProgress = () => safe(callbacks.onProgress, {
      index,
      total: snapshot.entries.length,
      ratio: index >= 0 && snapshot.entries.length ? (index + 1) / snapshot.entries.length : 0
    });
    const clearVisual = entry => safe(callbacks.onClearHighlight, entry || null);
    const inspect = () => Object.freeze({index, hasResume: Boolean(resume), disposed, timerActive: timer !== null});
    const stop = () => { if (timer !== null) scheduler.clearInterval(timer); timer = null; };
    const save = (force = false) => {
      if (disposed || index < 0 || !snapshot.entries[index]) return Promise.resolve();
      const now = clock.now();
      if (!force && now - lastSave < 20000) return write;
      lastSave = now;
      const item = callbacks.createRecord?.({
        entry: snapshot.entries[index],
        index,
        position: callbacks.getPlaybackPosition?.() || 0,
        updatedAt: now
      }) || {...context, ...snapshot.entries[index], index, updatedAt: now};
      write = write.catch(() => undefined).then(async () => {
        const saved = await storage.get('nlrProgress');
        const progress = {...(saved.nlrProgress || {})};
        const key = progressContext.pageKey || pageKey?.();
        for (const alias of progressContext.aliases || []) if (alias !== key) delete progress[alias];
        progress[key] = item;
        await storage.set({nlrProgress: bounded(progress)});
        if (valid(token)) safe(callbacks.onResumeChanged, item);
      });
      return write;
    };
    return Object.freeze({
      setDocument(next, nextContext, nextToken) {
        const previous = snapshot.entries[index] || null;
        stop();
        clearVisual(previous);
        snapshot = next;
        index = -1;
        resume = null;
        completed = false;
        token = nextToken;
        progressContext = Object.freeze({
          ...(nextContext || context),
          aliases: Object.freeze([...(nextContext?.aliases || context.aliases || [])])
        });
        context = progressContext;
        visualProgress();
      },
      activate(nextIndex, expected) {
        if (!valid(expected) || nextIndex < 0 || nextIndex >= snapshot.entries.length) return false;
        const previous = snapshot.entries[index] || null;
        const current = snapshot.entries[nextIndex];
        index = nextIndex;
        clearVisual(previous);
        safe(callbacks.onApplyHighlight, current);
        safe(callbacks.onScroll, current);
        visualProgress();
        safe(callbacks.onActivate, {previous, current, index, total: snapshot.entries.length});
        return true;
      },
      restore(expected, nextContext = progressContext) {
        if (disposed || !sessionValid(expected)) return Promise.resolve(null);
        if (token === null) {
          token = expected;
          progressContext = Object.freeze({
            ...nextContext,
            aliases: Object.freeze([...(nextContext.aliases || [])])
          });
        }
        if (!valid(expected)) return Promise.resolve(null);
        const key = nextContext.pageKey || pageKey?.();
        const aliases = nextContext.aliases || [];
        return storage.get('nlrProgress').then(async saved => {
          const map = saved.nlrProgress || {};
          const candidates = [key, ...aliases].filter(Boolean);
          const found = candidates.map(candidate => map[candidate]).find(item =>
            item && Number.isInteger(item.index) && item.index >= 0 && typeof item.text === 'string'
          ) || null;
          if (!valid(expected)) return null;
          resume = found;
          const source = candidates.find(candidate => map[candidate] === found);
          if (found && key && source && source !== key) {
            const migrated = {...map, [key]: found};
            for (const alias of aliases) if (alias !== key) delete migrated[alias];
            await storage.set({nlrProgress: migrated});
          }
          if (valid(expected)) safe(callbacks.onResumeChanged, resume);
          return resume;
        });
      },
      start(expected) {
        if (!valid(expected) || timer !== null) return;
        timer = scheduler.setInterval(() => {
          if (callbacks.isPlaying?.()) save();
        }, 20000);
      },
      clearHighlight() { clearVisual(snapshot.entries[index] || null); },
      stop, save, resume: () => resume, resumeSnapshot: () => resume, context: () => progressContext,
      currentIndex: () => index, snapshot: () => snapshot, inspect,
      complete(expected, metadata = {}) {
        if (!valid(expected)) return Promise.resolve(false);
        if (completed) return Promise.resolve(true);
        const key = progressContext.pageKey || pageKey?.();
        const aliases = progressContext.aliases || [];
        write = write.catch(() => undefined).then(async () => {
          if (!valid(expected)) return false;
          const saved = await storage.get('nlrProgress');
          const progress = {...(saved.nlrProgress || {})};
          delete progress[key];
          for (const alias of aliases) delete progress[alias];
          await storage.set({nlrProgress: progress});
          const historySaved = await storage.get('nlrHistory');
          const history = Array.isArray(historySaved.nlrHistory) ? historySaved.nlrHistory : [];
          const item = callbacks.createHistory?.({
            ...metadata,
            completed: true,
            updatedAt: metadata.updatedAt ?? clock.now()
          });
          const next = item ? [item, ...history.filter(entry => {
            try { return callbacks.historyKey?.(entry) !== key; } catch { return true; }
          })].slice(0, HISTORY_LIMIT) : history;
          if (item) await storage.set({nlrHistory: next});
          stop();
          resume = null;
          completed = true;
          if (valid(expected)) safe(callbacks.onResumeChanged, null);
          return true;
        });
        return write;
      },
      dispose() { if (disposed) return; disposed = true; stop(); }
    });
  }
  root.contentProgress = Object.freeze({create});
})();
