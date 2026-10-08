(() => {
  const settingsSchema = globalThis.NovelLocalReader?.settingsSchema;
  const i18n = globalThis.NovelLocalReader?.i18n;
  const contentDocument = globalThis.NovelLocalReader?.contentDocument;
  const panelFactory = globalThis.NovelLocalReader?.contentPanel?.create;
  const progressFactory = globalThis.NovelLocalReader?.contentProgress?.create;
  const navigationFactory = globalThis.NovelLocalReader?.contentNavigation?.create;
  if (!settingsSchema || !i18n || !contentDocument || typeof progressFactory !== 'function' ||
      typeof panelFactory !== 'function') return;
  if (globalThis.__novelLocalReaderLoaded) {
    return;
  }
  const runtimeFactory = globalThis.NovelLocalReader?.runtime?.create;
  const playbackFactory = globalThis.NovelLocalReader?.playback?.create;
  if (typeof runtimeFactory !== 'function' || typeof playbackFactory !== 'function') {
    return;
  }
  let runtime;
  let panelUI = null;
  try {
    runtime = runtimeFactory({browser, onReconnect: showReconnectNotice});
  } catch {
    return;
  }
  const session = runtime?.session;
  const lifecycle = runtime;
  if (!runtime) return;

  function showReconnectNotice() {
    panelUI?.dispose();
    document.querySelectorAll('nlr-reader-host,#nlr-reconnect-notice').forEach(node => node.remove());
    const notice = document.createElement('aside');
    notice.id = 'nlr-reconnect-notice';
    notice.setAttribute('role','alert');
    notice.style.cssText = 'all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;max-width:360px!important;padding:16px 44px 16px 18px!important;border:1px solid #7667e8!important;border-radius:14px!important;background:#171724!important;color:#f7f5ff!important;box-shadow:0 16px 50px #0009!important;font:500 14px/1.45 system-ui,sans-serif!important;';
    notice.textContent = tr('status.updated');
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label',tr('status.closeNotice'));
    close.textContent = '×';
    close.style.cssText = 'all:initial!important;position:absolute!important;right:12px!important;top:9px!important;color:#c9c3ff!important;font:24px/1 system-ui,sans-serif!important;cursor:pointer!important;';
    close.addEventListener('click',() => notice.remove());
    notice.appendChild(close);
    (document.body || document.documentElement).appendChild(notice);
  }

  const sendToBackground = message => runtime.send(message);
  const tr = (key, values) => i18n.t(key, values);


  const state = {
    documentSnapshot: contentDocument.createSnapshot([]),
    sessionId: 0,
    lastSelection: "",
    settings: settingsSchema.cloneDefaults(),
    siteProfile: {},
    voicesLoaded: false,
    capabilities: null
  };
  let settingsHydrated = false;
  let settingsPhase = 'hydrating';
  let settingsRevision = 0;
  let settingsFailureReason = null;

  // The controller receives only immutable synthesis inputs.  Profile, DOM,
  // document parsing and visible UI remain owned by this compositor.
  let playback;
  try {
    playback = playbackFactory({
      runtime,
      getConfig: () => Object.freeze({
        volume: state.settings.volume,
        playbackRate: state.settings.playbackRate,
        cacheWarming: state.capabilities?.capabilities?.cache_warming === true
      }),
      getProfile: async () => (await sendToBackground({type:'profile'})).fingerprint || '',
      send: sendToBackground,
      onEnded: (item) => advanceFrom(item.index, item.sessionId),
      onError: handlePlaybackError
    });
  } catch {
    runtime.dispose?.();
    return;
  }
  if (!playback) {
    runtime.dispose?.();
    return;
  }
  panelUI = panelFactory({
    getAssetUrl: path => browser.runtime.getURL(path),
    onStylesUnavailable: adopt => sendToBackground({type: 'panel-css'}).then(result => {
      if (result?.ok && result.css) adopt(result.css);
    })
  });
  const panel = panelUI;
  const navigation = navigationFactory({
    panel: Object.freeze({contains: element => panel.contains(element)}),
    scheduler: {
      setTimeout: (callback, delay) => lifecycle.timer('timeout', callback, delay),
      clearTimeout: timer => globalThis.clearTimeout(timer)
    },
    storage: {
      readAutoContinue: () => browser.storage.local.get('nlrAutoContinue').then(result => result.nlrAutoContinue),
      writeAutoContinue: value => browser.storage.local.set({nlrAutoContinue: value}),
      removeAutoContinue: () => browser.storage.local.remove('nlrAutoContinue')
    },
    navigate: target => target.url ? location.assign(target.url) : target.element?.click(),
    currentUrl: () => normalizeUrl(location.href),
    normalizeText: contentDocument.normalizeText,
    looksLikeNavigationText: contentDocument.looksLikeNavigationText,
    isOriginAllowed: origin => sendToBackground({type: 'origin-allowed', origin}).then(result => result?.allowed === true)
  });

  const progress = progressFactory({
    scheduler: {
      setInterval: (callback, delay) => lifecycle.timer('interval', callback, delay),
      clearInterval: intervalId => globalThis.clearInterval(intervalId)
    },
    storage: browser.storage.local,
    pageKey: getPageKey,
    sessionValid: token => token === state.sessionId,
    callbacks: {
      onClearHighlight: entry => entry?.element?.classList?.remove('nlr-reading-paragraph'),
      onApplyHighlight: entry => {
        if (entry?.element && entry.element !== document.body) {
          entry.element.classList.add('nlr-reading-paragraph');
        }
      },
      onScroll: entry => {
        if (entry?.element && entry.element !== document.body) {
          entry.element.scrollIntoView({behavior: 'smooth', block: 'center'});
        }
      },
      onProgress: value => panel.setProgress(value),
      onError: () => setStatus(tr('status.progressError')),
      isPlaying: () => playback.isPlaying(),
      getPlaybackPosition: () => playback.elapsed(),
      createRecord: ({entry, index, position, updatedAt}) => ({
        title: document.title,
        novelTitle: getNovelTitle(),
        chapterTitle: getChapterTitle(),
        url: location.href,
        index,
        currentTime: position,
        text: entry.text,
        updatedAt
      }),
      createHistory: ({completed, updatedAt}) => ({
        url: location.href,
        novelTitle: getNovelTitle(),
        chapterTitle: getChapterTitle(),
        completed,
        updatedAt
      }),
      historyKey: entry => {
        try {
          const url = new URL(entry.url, location.href);
          const id = url.pathname.endsWith('/reader.html') ? url.searchParams.get('document') : '';
          return id ? `local-document:${id}` : normalizeUrl(url.href);
        } catch { return ''; }
      },
    }
  });

  let bootstrapStage = 'unexpected';
  let disposed = false;
  let disposeCurrentInstance = () => {
    if (disposed) return;
    disposed = true;
    settingsPhase = 'disposed';
    settingsHydrated = false;
    progress.dispose();
    navigation.dispose();
    lifecycle.dispose();
    panel?.dispose();
    if (globalThis.__nlrDispose === disposeCurrentInstance) {
      delete globalThis.__nlrDispose;
      delete globalThis.__novelLocalReaderLoaded;
    }
  };
  globalThis.__nlrDispose = disposeCurrentInstance;
  bootstrap().catch((error) => {
    if (error?.name !== 'SettingsContractError') {
      safeSettingsDiagnostic(tr('status.loadPreferenceError'));
    }
    setStatus(error?.name === 'SettingsContractError'
      ? error.message
      : tr('status.initFailed'));
  });

  function safeSettingsDiagnostic(text) {
    if (panel) panel.setSettingsDiagnostic(text);
    else setStatus(tr('status.loadPreferenceError'));
  }

  async function bootstrap() {
    bootstrapStage='restore-settings';
    await restoreSettings();
    if (lifecycle.signal.aborted) return;
    settingsHydrated = true;
    settingsPhase = 'ready';
    bootstrapStage='register-events';
    registerEvents();
    if (lifecycle.signal.aborted) return;
    bootstrapStage='unexpected';
    await restoreSiteProfile();
    if (lifecycle.signal.aborted) return;
    // The voice list is not fetched at load time: that would send an
    // authenticated request to the local service on every page view. It is
    // loaded the first time the panel is actually opened.
    await refreshResume();
    if (lifecycle.signal.aborted) return;
    await resumeContinuationFromNavigation();
  }

  function listen(target, event, callback, options = {}) {
    lifecycle.listen(target, event, callback, options);
  }
  function selectTab(name) {
    panel.selectTab(name);
  }
  function reportError(error) {
    setStatus(tr('status.operationError'));
    panel.setDiagnostics(tr('status.operationFailed'));
  }
  function registerEvents() {
    panel.bind({
      onSetting: (key, value) => {
        if (!settingsHydrated || settingsPhase !== 'ready' || lifecycle.signal.aborted) return;
        return updateSettingForControl(key, value)
          .then(() => updateAutoNextPermission())
          .catch(reportError);
      },
      onAction: action => handlePanelAction(action)
    });
    const onMessage = (message) => {
      if (message?.type === 'nlr-probe') {
        return Promise.resolve({ok:true,version:'1.0.0'});
      }
      if (message?.type === "toggle-panel") {
        const visible = panel.toggle();
        if (visible) {
          if (!state.voicesLoaded) {
            state.voicesLoaded = true;
            loadVoiceChoices().catch(() => setStatus(tr('status.operationError')));
          }
          checkServer().catch(reportError);
          refreshResume().catch(reportError);
          refreshCacheStats().catch(reportError);
          updateAutoNextPermission().catch(() => undefined);
        }
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    const onSettingsChanged = (changes, areaName) => {
      if (areaName !== 'local' || settingsPhase !== 'ready') return;
      const revision = changes?.nlrSettingsRevision?.newValue;
      if (Number.isInteger(revision) && revision >= 0) settingsRevision = revision;
      if (changes?.nlrSettings?.newValue) applySettingsSnapshot(changes.nlrSettings.newValue);
    };
    browser.storage.onChanged?.addListener(onSettingsChanged);
    let disposed = false;
    disposeCurrentInstance = () => {
      if (disposed) return;
      disposed = true;
      settingsPhase = 'disposed';
      settingsHydrated = false;
      progress.stop();
      clearCurrentSession();
      progress.dispose();
      navigation.cancelAll();
      cancelScheduledNext(false);
      session.beginDispose();
      lifecycle.dispose();
      browser.runtime.onMessage.removeListener(onMessage);
      browser.storage.onChanged?.removeListener(onSettingsChanged);
      panel.dispose();
      if (globalThis.__nlrDispose === disposeCurrentInstance) {
        document.querySelectorAll('#nlr-reconnect-notice').forEach(node => node.remove());
        delete globalThis.__novelLocalReaderLoaded;
      }
    };
    globalThis.__nlrDispose = disposeCurrentInstance;
    globalThis.__novelLocalReaderLoaded = true;

    listen(document, "selectionchange", () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        return;
      }

      const anchor =
        selection.anchorNode?.nodeType === Node.ELEMENT_NODE
          ? selection.anchorNode
          : selection.anchorNode?.parentElement;

      // Selections inside the shadow root surface as the host element.
      if (anchor && panel.contains(anchor)) {
        return;
      }

      const text = contentDocument.normalizeText(selection.toString());
      if (text.length >= 2) {
        state.lastSelection = text;
      }
    });

    listen(document, "keydown", (event) => {
      // Events from the shadow root retarget to the host by the time they
      // reach document, so ask the composed path for the real target.
      const target = event.composedPath?.()[0] || event.target;
      if (!event.altKey || isTypingTarget(target)) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        togglePause();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        playIndex(Math.max(0, progress.currentIndex() - 1), state.sessionId);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        playIndex(
          Math.min(state.documentSnapshot.length - 1, progress.currentIndex() + 1),
          state.sessionId
        );
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        playIndex(progress.currentIndex(), state.sessionId);
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        stopReading();
      }
    });

    listen(window, "pagehide", () => {
      progress.save(true).catch(() => undefined);
      state.sessionId += 1;
      clearCurrentSession();
      cancelScheduledNext(false);
    });
    listen(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") progress.save(true);
    });
    listen(window, "nlr-document-ready", handleLocalDocumentReady);
  }

  function handlePanelAction(action) {
    const actions = {
      connect: () => sendToBackground({type: 'open-page', page: 'options.html'}),
      diagnose: () => {
        checkServer().catch(reportError);
        refreshCacheStats().catch(reportError);
        loadVoiceChoices().catch(reportError);
      },
      readSelection: () => readSelection(),
      readPage: () => readPage(),
      library: () => sendToBackground({type: 'open-page', page: 'library.html'}),
      openFile: () => sendToBackground({type: 'open-page', page: 'reader.html'}),
      continue: () => continueReading(),
      previous: () => playIndex(Math.max(0, progress.currentIndex() - 1), state.sessionId),
      next: () => playIndex(Math.min(state.documentSnapshot.length - 1, progress.currentIndex() + 1), state.sessionId),
      repeat: () => playIndex(progress.currentIndex(), state.sessionId),
      pause: () => togglePause(),
      stop: () => stopReading(),
      clearCache: () => clearPersistentCache(),
      warmNext: () => prefetchFutureChapters(1, true),
      allowSite: () => sendToBackground({type: 'open-page', page: 'options.html', hash: `${location.origin}/*`}),
      testVoice: () => testSelectedVoice(),
      saveProfile: () => saveSiteProfile(),
      pickContent: () => startPanelPicker('content'),
      pickNext: () => startPanelPicker('next')
    };
    try {
      const result = actions[action]?.();
      if (result && typeof result.then === 'function') result.catch(reportError);
    } catch (error) {
      reportError(error);
    }
  }

  function startPanelPicker(kind) {
    panel.beginPicker(kind, (selectedKind, selector) => {
      panel.setValue(selectedKind === 'content' ? 'contentSelector' : 'nextSelector', selector);
      setStatus(tr('status.selectorCaptured', {selector}));
    });
  }

  // Holding a port open keeps the background event page alive for the duration
  // of a reading session, so the synthesis queue is not discarded mid-chapter.
  // Disconnect also reaches the background when the tab crashes, which neither
  // tabs.onRemoved nor tabs.onUpdated report.
  function openSessionPort() {
    closeSessionPort();
    try {
      runtime.openPort();
    } catch {
    }
  }

  function closeSessionPort() {
    try {
      runtime.closePort();
    } catch {
      // The background may already have gone away; nothing to clean up.
    }
  }

  async function updateAutoNextPermission() {
    if (!state.settings.autoNext || location.protocol === "moz-extension:") {
      panel.setAutoNextNoteHidden(true);
      return;
    }
    const origin = `${location.origin}/*`;
    const result = await navigation.checkPermission(origin, state.sessionId, token => token === state.sessionId);
    panel.setAutoNextNoteHidden(Boolean(result.allowed));
  }

  async function handleLocalDocumentReady() {
    await refreshResume();
    await resumeContinuationFromNavigation();
  }

  async function restoreSettings() {
    let saved;
    try { saved=await sendToBackground({type:'settings-get'}); }
    catch { throw settingsContractError('transport-error', 'load'); }
    const reason=settingsEnvelopeFailure(saved,true);
    if(reason)throw settingsContractError(reason, 'load');
    settingsRevision = saved.revision;
    settingsFailureReason = null;
    bootstrapStage='apply-settings';
    applySettingsSnapshot(saved.settings);
  }

  function settingsContractError(reason, operation = 'save') {
    const message = operation === 'load'
      ? tr('status.loadPreferenceError')
      : tr('status.preferenceError');
    safeSettingsDiagnostic(message);
    settingsFailureReason = reason;
    const error=new Error(message);
    error.name='SettingsContractError';
    error.settingsReason=reason;
    return error;
  }

  function settingsEnvelopeFailure(value, requireSnapshot=false, expectedKeys=null) {
    if(value===undefined||value===null)return 'no-response';
    if(typeof value!=='object'||value.ok!==true)return 'malformed-response';
    if(value.settings_protocol!==settingsSchema.protocolVersion)return 'protocol';
    if(value.implementation!==settingsSchema.implementation)return 'implementation';
    if(!Number.isInteger(value.revision)||value.revision<0)return 'revision';
    if(!Array.isArray(value.accepted_keys))return 'accepted-keys';
    const accepted=[...value.accepted_keys].sort();
    const expected=(expectedKeys||[...settingsSchema.keys]).sort();
    if(JSON.stringify(accepted)!==JSON.stringify(expected))return 'accepted-keys';
    if(requireSnapshot&&(!value.settings||typeof value.settings!=='object'||Array.isArray(value.settings)))return 'malformed-response';
    return null;
  }

  function applySettingsSnapshot(snapshot) {
    state.settings=settingsSchema.normalize(snapshot);
    panel.applySettings(state.settings);
    panel.setLanguage(state.settings.interfaceLanguage);
    applyTheme(state.settings.theme);
    playback.setVolume(state.settings.volume);
    playback.setRate(state.settings.playbackRate);
  }

  async function updateSettingForControl(name, value) {
    if (!settingsHydrated || lifecycle.signal.aborted || runtime.disposed) return;
    let patch;
    const text = String(value ?? '');
    if(name==='voice')patch={voice:text.trim()};
    else if(name==='temperature')patch={temperature:clampNumber(value,0,2,0.9)};
    else if(name==='seed')patch={seed:Math.trunc(clampNumber(value,0,2147483647,42))};
    else if(name==='playbackRate')patch={playbackRate:clampNumber(value,0.5,2,1)};
    else if(name==='volume')patch={volume:clampNumber(value,0,1,1)};
    else if(name==='prefetch')patch={prefetch:Math.trunc(clampNumber(value,0,5,2))};
    else if(name==='cacheLimitMb')patch={cacheLimitMb:Math.trunc(clampNumber(value,100,50000,4096))};
    else if(name==='autoNext')patch={autoNext:Boolean(value)};
    else if(name==='autoNextDelay')patch={autoNextDelay:Math.trunc(clampNumber(value,2,30,5))};
    else if(name==='nextSelector')patch={nextSelector:text.trim()};
    else if(name==='compact')patch={compact:Boolean(value)};
    else if(name==='theme')patch={theme:text};
    else if(name==='dialogueVoice')patch={dialogueVoice:text.trim()};
    else if(name==='characterVoices')patch={characterVoices:text.trim()};
    else if(name==='expressionMode')patch={expressionMode:text};
    else if(name==='mergeShortLines')patch={mergeShortLines:Boolean(value)};
    else if(name==='shortLineLimit')patch={shortLineLimit:Math.trunc(clampNumber(value,20,160,70))};
    else if(name==='preGenerateChapters')patch={preGenerateChapters:Math.trunc(clampNumber(value,0,3,0))};
    else if(name==='interfaceLanguage')patch={interfaceLanguage:settingsSchema.valid('interfaceLanguage',text)?text:'auto'};
    else return;
    const generationKeys = ['voice','dialogueVoice','characterVoices','expressionMode','temperature','seed'];
    const before = JSON.stringify(generationKeys.map(key => state.settings[key]));
    Object.assign(state.settings,patch);
    let confirmed;
    try { confirmed=await sendToBackground({type:'settings-update',patch}); }
    catch { throw settingsContractError('transport-error', 'save'); }
    const expected=Object.keys(patch).sort();
    const reason=settingsEnvelopeFailure(confirmed,false,expected);
    if(reason)throw settingsContractError(reason, 'save');
    settingsRevision=confirmed.revision;
    settingsFailureReason = null;
    panel.setSettingsDiagnostic('');
    panel.setLanguage(state.settings.interfaceLanguage);
    setStatus(tr('status.preferencesSaved'));
    if (before !== JSON.stringify(generationKeys.map(key => state.settings[key]))) {
      state.sessionId += 1;
      clearCurrentSession();
      setStatus(tr('status.regenerate'));
    }
    panel.setValue('compact', state.settings.compact);
    applyTheme(state.settings.theme);
    playback.setVolume(state.settings.volume);
    playback.setRate(state.settings.playbackRate);
  }

  async function restoreSiteProfile() {
    const saved = await browser.storage.local.get("nlrSiteProfiles");
    const profiles = saved.nlrSiteProfiles || {};
    state.siteProfile = profiles[location.hostname] || {};
    panel.setProfile(state.siteProfile);
  }

  async function saveSiteProfile() {
    const saved = await browser.storage.local.get("nlrSiteProfiles");
    const profiles = saved.nlrSiteProfiles || {};
    const values = panel.profileValues();
    state.siteProfile = {
      contentSelector: values.contentSelector.trim(),
      ignoreSelector: values.ignoreSelector.trim(),
      nextSelector: values.nextSelector.trim(),
      updatedAt: Date.now()
    };
    profiles[location.hostname] = state.siteProfile;
    await browser.storage.local.set({ nlrSiteProfiles: profiles });
    setStatus(tr('status.profileSaved', {host: location.hostname}));
  }

  async function loadVoiceChoices() {
    state.voicesLoaded = true;
    const result = await sendToBackground({ type: "voices" });
    panel.setVoiceChoices(result?.voices || []);
  }

  function applyTheme(theme) {
    const appliedTheme = panel.setTheme(theme);
    if (location.protocol === 'moz-extension:') document.documentElement.dataset.nlrTheme = appliedTheme;
  }

  async function checkServer() {
    panel.setServer("nlr-pending", tr('status.serverChecking'));

    const result = await sendToBackground({ type: "health" });
    let handshake = result?.protocol;
    if (result?.ok) {
      try { handshake = await sendToBackground({ type: "capabilities" }); }
      catch (error) { handshake = null; }
    }
    state.capabilities = handshake;
    const styleSupported = handshake?.capabilities?.style_instructions === true;
    panel.setExpressionSupported(styleSupported);
    panel.setMultipleVoicesSupported(handshake?.capabilities?.multiple_voices === true);
    let diagnostics = result?.ok
      ? `${tr('status.cacheConnected')} · ${result.data.upstream ? tr('status.qwenReady') : tr('status.qwenOffline')} · ${tr('status.queue', {count: result.queue?.waiting || 0})}`
      : translateKnownError(result) || tr('status.noConnection');
    if (handshake?.legacy || isOlderHost(handshake?.serviceVersion)) {
      diagnostics += ` · ${tr('status.legacyHost')}`;
    }
    if (handshake && !handshake.compatible) diagnostics = tr('status.protocolMismatch');
    panel.setDiagnostics(diagnostics);
    if (result?.data?.cache_limit_mb) panel.setCacheLimit(result.data.cache_limit_mb);
    if (result?.ok) {
      panel.setServer("nlr-online", `${result.data.upstream ? tr('status.serverReady') : tr('status.cacheReadyOffline')} · ${
        result.data?.backend || "TTS"
      } · ${tr('status.localCache')}`);
    } else {
      panel.setServer("nlr-offline", translateKnownError(result) || tr('status.serverDisconnected'));
    }
  }

  function isOlderHost(version) {
    const currentVersion = globalThis.NovelProtocol?.APP_VERSION;
    if (typeof currentVersion !== 'string' || typeof version !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(version)) return false;
    const remote = version.split('.').map(Number);
    const local = currentVersion.split('.').map(Number);
    for (let index = 0; index < local.length; index += 1) {
      if (remote[index] !== local[index]) return remote[index] < local[index];
    }
    return false;
  }

  function translateKnownError(result) {
    const code = result?.error?.code || result?.code;
    if (!code || !KNOWN_HOST_ERRORS.has(code)) return null;
    return tr('status.hostRequestError');
  }

  const KNOWN_HOST_ERRORS = new Set([
    'INVALID_REQUEST', 'VOICE_NOT_FOUND', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_TIMEOUT',
    'UPSTREAM_REJECTED', 'INVALID_AUDIO', 'CACHE_UNAVAILABLE', 'QUEUE_FULL',
    'AUTH_REQUIRED', 'HOST_FORBIDDEN', 'ORIGIN_FORBIDDEN', 'ENDPOINT_NOT_FOUND',
    'UNSUPPORTED_MEDIA_TYPE', 'BODY_TOO_LARGE', 'INTERNAL_ERROR'
  ]);

  async function readSelection() {
    const currentSelection = contentDocument.normalizeText(
      window.getSelection()?.toString() || ""
    );
    const text = currentSelection || state.lastSelection;

    if (!text) {
      setStatus(tr('status.noSelection'));
      return;
    }

    const snapshot = contentDocument.createSelectionSnapshot({toString: () => text});
    if (!snapshot.length) {
      setStatus(tr('status.noSelection'));
      return;
    }
    startReading(
      snapshot,
      "seleção"
    );
  }

  async function readPage() {
    const snapshot = contentDocument.createPageSnapshot({document,contentSelector:state.siteProfile.contentSelector,ignoreSelector:state.siteProfile.ignoreSelector,excludedRoot:panel});
    if (!snapshot.length) {
      setStatus(tr('status.noReadableText'));
      return;
    }

    startReading(snapshot, "página");
  }

  async function continueReading() {
    await refreshResume();
    const resumeData = progress.resumeSnapshot();
    if (!resumeData) {
      setStatus(tr('status.noResume'));
      return;
    }

    const extracted = contentDocument.createPageSnapshot({document,contentSelector:state.siteProfile.contentSelector,ignoreSelector:state.siteProfile.ignoreSelector,excludedRoot:panel});
    const snapshot = state.settings.mergeShortLines ? contentDocument.createSnapshot(contentDocument.mergeShortEntries(extracted.entries,state.settings.shortLineLimit)) : extracted;
    if (!snapshot.length) {
      setStatus(tr('status.noReadableText'));
      return;
    }

    const savedText = normalizeResumeText(resumeData.text);
    let index = snapshot.entries.findIndex((entry) => {
      const entryText = normalizeResumeText(entry.text);
      return (
        entryText === savedText ||
        (savedText.length >= 12 && entryText.includes(savedText)) ||
        (entryText.length >= 12 && savedText.includes(entryText))
      );
    });
    if (index < 0) {
      index = Math.min(
        Math.max(0, Number(resumeData.index) || 0),
        snapshot.length - 1
      );
    }

    startReading(
      snapshot,
      "página",
      index,
      Number(resumeData.currentTime) || 0,
      true
    );
  }

  function startReading(snapshot, sourceName, startIndex = 0, startTime = 0, alreadyPrepared = false) {
    clearCurrentSession();
    cancelScheduledNext(false);
    selectTab("listen");
    panel.setBookTitle(getChapterTitle() || "Sua leitura");

    const preparedSnapshot = state.settings.mergeShortLines && !alreadyPrepared
      ? contentDocument.createSnapshot(
        contentDocument.mergeShortEntries(snapshot.entries, state.settings.shortLineLimit)
      )
      : snapshot;

    state.sessionId += 1;
    state.documentSnapshot = preparedSnapshot;
    progress.setDocument(preparedSnapshot, progressContext(), state.sessionId);
    setStatus(tr('status.readStarted', {
      count: state.documentSnapshot.length,
      source: sourceName === 'seleção' ? tr('status.selectionSource') : tr('status.pageSource')
    }));
    playIndex(startIndex, state.sessionId, startTime);
    if (state.settings.preGenerateChapters > 0) {
      playback.scheduleWarm(
        () => prefetchFutureChapters(state.settings.preGenerateChapters, false),
        12000
      );
    }
  }


  // Queue the following paragraph on the context clock so it begins at the exact
  // sample the current one ends. Only one paragraph is ever queued ahead, which
  // keeps Stop and Next cheap.
  async function prescheduleNext(index, sessionId) {
    const next = index + 1;
    if (next >= state.documentSnapshot.length || state.settings.prefetch < 1) {
      return;
    }
    if (playback.sourceCount() >= 2 || playback.hasScheduled(audioItem(next).id)) {
      return;
    }
    const item = audioItem(next);
    const end = playback.currentEnd();
    if (end === null || sessionId !== state.sessionId) {
      return;
    }
    await playback.schedule({...item,index:next,sessionId},{when:end,replace:false,priority:1});
  }

  function advanceFrom(index, sessionId) {
    if (sessionId !== state.sessionId) {
      return;
    }

    const next = index + 1;
    if (next >= state.documentSnapshot.length) {
      if (playback.sourceCount()) {
        return;
      }
      panel.setPauseLabel("\u25b6");
      progress.clearHighlight();
      progress.complete(sessionId)
        .then(() => { if (progress.currentIndex() >= 0) panel.setResume(null); })
        .catch(() => undefined);
      if (state.settings.autoNext) {
        scheduleNextFromComposer();
      } else {
        setStatus(tr('status.readComplete'));
      }
      return;
    }

    if (playback.hasScheduled(audioItem(next).id)) {
      // Already running: it was scheduled before this paragraph finished.
      if (!progress.activate(next, sessionId)) return;
      panel.setExcerpt(state.documentSnapshot.entries[next].text);
      panel.setPauseLabel("\u23f8");
      setStatus(tr('status.paragraphReading', {index: next + 1}));
      progress.save(true).catch(reportError);
      prefetchFollowing(next, sessionId);
      playback.pruneAround(next, state.settings.prefetch);
      prescheduleNext(next, sessionId);
      return;
    }

    playIndex(next, sessionId);
  }

  async function playIndex(index, sessionId, startTime = 0) {
    if (
      sessionId !== state.sessionId ||
      index < 0 ||
      index >= state.documentSnapshot.length
    ) {
      return;
    }

    // The port is opened on first playback and closed only when the scope is
    // retired, because the background treats a disconnect as a cancellation of
    // that scope.
    if (!runtime.hasPort) openSessionPort();
    progress.start(sessionId);

    panel.setExcerpt(state.documentSnapshot.entries[index].text);
    if (!progress.activate(index, sessionId)) return;
    panel.setPauseLabel("\u2026");
    setStatus(tr('status.generatingParagraph', {index: index + 1}));

    try {
      const item = {...audioItem(index),index,sessionId};
      const scheduled = await playback.play(item,{offset:startTime});
      if (!scheduled || sessionId !== state.sessionId) return;
      if (!progress.activate(index, sessionId)) return;
      panel.setPauseLabel("\u23f8");
      setStatus(tr('status.paragraphReading', {index: index + 1}));
      progress.save(true).catch(reportError);
      prefetchFollowing(index, sessionId);
      playback.pruneAround(index, state.settings.prefetch);
      prescheduleNext(index, sessionId);
    } catch (error) {
      if (sessionId === state.sessionId) handlePlaybackError(error);
    }
  }

  function handlePlaybackError(error) {
    panel.setPauseLabel("\u25b6");
    if (error?.code === 'DATA_CONSENT_REQUIRED' || /NLR_DATA_CONSENT_REQUIRED/.test(error?.message || '')) {
      setStatus(tr('status.dataConsentRequired'));
    } else if (error?.name === "NotAllowedError" || /not allowed|autoplay/i.test(error?.message || "")) {
      setStatus(tr('status.autoplayBlocked'));
    } else {
      setStatus(tr('status.audioFailed'));
    }
  }

  function audioItem(index) {
    const synthesis = buildSynthesisPayload(state.documentSnapshot.entries[index].text);
    return Object.freeze({
      id: session.scope + ":" + index,
      text: synthesis.text,
      voice: synthesis.voice,
      instructions: synthesis.instructions,
      language: state.settings.language || "",
      temperature: state.settings.temperature,
      seed: state.settings.seed,
      cacheLimitMb: state.settings.cacheLimitMb
    });
  }

  function buildSynthesisPayload(text) {
    const multipleVoices = state.capabilities?.capabilities?.multiple_voices === true;
    const characterMap = multipleVoices ? parseCharacterVoices() : new Map();
    const explicitSpeaker = text.match(/^([\p{L}\p{N}_ -]{1,40})\s*:\s*/u)?.[1]?.trim();
    const isDialogue = /^[\s“”"'‘’—-]*[“"'‘’]/u.test(text) || Boolean(explicitSpeaker);
    const voice =
      (explicitSpeaker && characterMap.get(explicitSpeaker.toLocaleLowerCase())) ||
      (multipleVoices && isDialogue && state.settings.dialogueVoice) ||
      state.settings.voice;

    if (state.capabilities?.capabilities?.style_instructions !== true) {
      return { text, voice, instructions: "" };
    }

    if (state.settings.expressionMode === "off") {
      return { text, voice, instructions: "" };
    }

    if (state.settings.expressionMode === "narration") {
      return { text, voice, instructions: "calm novel narration" };
    }

    let instructions = "natural expressive audiobook narration";
    if (/!{1,3}[”"']?\s*$/u.test(text) || /\b[A-Z]{4,}\b/.test(text)) {
      instructions = "dramatic and energetic";
    } else if (/\?+[”"']?\s*$/u.test(text)) {
      instructions = "curious questioning tone";
    } else if (/\.{3}|…/u.test(text)) {
      instructions = "hesitant with natural pauses";
    } else if (isDialogue) {
      instructions = "natural character dialogue";
    }
    // Expressive hints belong in the API field. Prefixing labels such as
    // "[narration]" makes backends without tag support read them aloud.
    return { text, voice, instructions };
  }

  function parseCharacterVoices() {
    const entries = state.settings.characterVoices
      .split(/\n+/)
      .map((line) => line.split("=").map((part) => part.trim()))
      .filter(([name, voice]) => name && voice)
      .map(([name, voice]) => [name.toLocaleLowerCase(), voice]);
    return new Map(entries);
  }

  async function testSelectedVoice() {
    setStatus(tr('status.sampleGenerating'));
    try {
      const synthesis = buildSynthesisPayload(
        "The evening sky faded slowly above the silent city."
      );
      const result = await sendToBackground({
        type: "synthesize",
        payload: {
          ...synthesis,
          temperature: state.settings.temperature,
          seed: state.settings.seed,
          cacheLimitMb: state.settings.cacheLimitMb
        }
      });
      if (!result?.buffer) throw new Error(tr('status.voiceSampleMissing'));
      const url = URL.createObjectURL(new Blob([result.buffer], {type: result.mimeType || "audio/wav"}));
      const preview = new Audio(url);
      preview.volume = state.settings.volume;
      preview.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await preview.play();
      setStatus(tr('status.samplePlaying'));
    } catch (error) {
      setStatus(tr('status.sampleFailed'));
    }
  }

  function prefetchFollowing(index, sessionId) {
    for (
      let next = index + 1;
      next <=
      Math.min(index + state.settings.prefetch, state.documentSnapshot.length - 1);
      next += 1
    ) {
      playback.prefetch(audioItem(next)).catch(() => undefined);
    }
  }

  async function refreshResume() {
    const resumeData = await progress.restore(state.sessionId, progressContext());
    panel.setResume(resumeData);
  }

  function getNovelTitle() {
    if (progress.context().localDocumentId) return tr('library.localFile');
    return (
      document.querySelector("meta[property='og:site_name']")?.content ||
      document.querySelector("[data-novel-title], .novel-title, .book-title")?.textContent ||
      location.hostname
    ).trim();
  }

  function getChapterTitle() {
    const localName = document.body?.dataset.nlrDocumentName;
    if (progress.context().localDocumentId && localName) return localName;
    return contentDocument.normalizeText(
      document.querySelector("h1, .chapter-title, [data-chapter-title]")?.textContent ||
        document.title
    );
  }

  async function refreshCacheStats() {
    const result = await sendToBackground({ type: "cache-stats" });
    if (!result?.ok) {
      panel.setCacheStats(tr('status.cacheStatsError'));
      return;
    }

    panel.setCacheStats(tr('status.cacheStats', {
      kind: result.mode === 'browser' ? tr('status.browserCache') : tr('status.cachePrefix'),
      size: formatBytes(result.bytes), count: result.count
    }));
  }

  async function clearPersistentCache() {
    if (!confirm(tr('status.cacheClearConfirm'))) return;
    state.sessionId += 1;
    clearCurrentSession();
    const result = await sendToBackground({ type: "clear-cache" });
    if (result?.ok) {
      setStatus(tr('status.cacheCleared'));
      refreshCacheStats().catch(reportError);
    } else {
      setStatus(tr('status.cacheClearFailed'));
    }
  }

  // Pre-generation is bounded in both paragraphs and wall time. Without a budget
  // three chapters could queue hundreds of sequential synthesis jobs and keep
  // the GPU busy long after the reader has moved on.
  const PREGENERATE_CHUNK_BUDGET = 120;
  const PREGENERATE_TIME_BUDGET = 20 * 60 * 1000;

  async function prefetchFutureChapters(count, manual) {
    // Future chapters need only a host-side cache entry. Never fall back to
    // speech here: that would carry a WAV into the extension only to discard it.
    if (state.capabilities?.capabilities?.cache_warming !== true) {
      if (manual) setStatus(tr('status.warmUnavailable'));
      return;
    }
    const scope = session.scope;
    const deadline = Date.now() + PREGENERATE_TIME_BUDGET;
    const initial = navigation.findNext({
      siteSelector: state.siteProfile.nextSelector,
      globalSelector: String(panel.value('nextSelector') || '').trim() || state.settings.nextSelector
    });
    let nextUrl = initial?.url || "";
    if (!nextUrl) {
      if (manual) setStatus(tr('status.nextUnavailable'));
      return;
    }

    let queued = 0;
    try {
      const visited = new Set();
      for (let chapter = 0; chapter < count && nextUrl; chapter += 1) {
        if (scope !== session.scope) return;
        const target = new URL(nextUrl, location.href);
        if (target.origin !== location.origin || !/^https?:$/.test(target.protocol) || visited.has(target.href)) break;
        visited.add(target.href);
        if (manual) setStatus(tr('status.readingNext', {chapter: chapter + 1}));
        const response = await fetch(nextUrl, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status} em ${nextUrl}`);
        const html = await response.text();
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const entries = extractEntriesFromDocument(parsed);
        const prepared = state.settings.mergeShortLines
          ? contentDocument.mergeShortEntries(entries,state.settings.shortLineLimit)
          : entries;

        for (const entry of prepared) {
          if (scope !== session.scope) return;
          if (queued >= PREGENERATE_CHUNK_BUDGET || Date.now() > deadline) {
            if (manual) setStatus(tr('status.warmLimit', {count: queued}));
            return;
          }
          const synthesis = buildSynthesisPayload(entry.text);
          await playback.warm([{
            id: `${target.href}:${queued}`,
            text: synthesis.text,
            voice: synthesis.voice,
            instructions: synthesis.instructions,
            temperature: state.settings.temperature,
            seed: state.settings.seed,
            cacheLimitMb: state.settings.cacheLimitMb
          }]);
          queued += 1;
        }
        nextUrl = navigation.findNextInDocument(parsed, nextUrl, {
          siteSelector: state.siteProfile.nextSelector,
          globalSelector: state.settings.nextSelector
        });
        if (Date.now() > deadline) break;
      }
      if (manual) {
        setStatus(tr('status.warmFinished', {count: queued}));
      }
    } catch (error) {
      if (manual) setStatus(tr('status.warmFailed'));
    }
  }

  function extractEntriesFromDocument(parsed) {
    const knownSelectors = [
      state.siteProfile.contentSelector,
      "article",
      "main",
      ".chapter-content",
      ".entry-content",
      ".reading-content",
      ".chapter-body",
      "#chapter-content"
    ].filter(Boolean);
    const roots = knownSelectors
      .flatMap((selector) => [...safeQueryAll(parsed, selector)])
      .filter(Boolean);
    const root = roots
      .map((candidate) => ({
        candidate,
        score: [...candidate.querySelectorAll("p")].reduce(
          (total, paragraph) => total + contentDocument.normalizeText(paragraph.textContent).length,
          0
        )
      }))
      .sort((a, b) => b.score - a.score)[0]?.candidate || parsed.body;

    const paragraphs = [...root.querySelectorAll("p")];
    const entries = [];
    for (const paragraph of paragraphs) {
      if (
        paragraph.closest("nav,header,footer,aside,.comments,.navigation,.ads,[class*='advert']") ||
        (state.siteProfile.ignoreSelector && safeClosest(paragraph, state.siteProfile.ignoreSelector))
      ) {
        continue;
      }
      const text = contentDocument.normalizeText(paragraph.textContent);
      if (!/[\p{L}\p{N}]/u.test(text) || contentDocument.looksLikeNavigationText(text)) continue;
      for (const chunk of contentDocument.splitText(text)) entries.push({ text: chunk, element: null });
    }
    return entries;
  }

  function scheduleNextFromComposer() {
    const target = navigation.findNext({
      siteSelector: state.siteProfile.nextSelector,
      globalSelector: String(panel.value('nextSelector') || '').trim() || state.settings.nextSelector
    });
    if (!target.available) {
      setStatus(tr('status.readComplete'));
      return;
    }

    cancelScheduledNext();
    let remaining = state.settings.autoNextDelay;
    setStatus(tr('status.autoNext', {seconds: remaining}));
    navigation.scheduleNextChapter({
      token: state.sessionId,
      delayMs: remaining * 1000,
      target,
      origin: location.origin,
      expiresAt: Date.now() + 120000,
      isValid: token => token === state.sessionId && !lifecycle.signal.aborted
    });
  }

  function cancelScheduledNext(showStatus = true) {
    navigation.cancelNext();
    if (showStatus) {
      setStatus(tr('status.autoNextCancelled'));
    }
  }

  async function resumeContinuationFromNavigation() {
    if (progress.context().localDocumentId && document.body?.dataset.nlrDocumentReady !== "true") return;
    const resumed = await navigation.resumeContinuation({
      token: state.sessionId,
      delayMs: 700,
      isValid: token => token === state.sessionId && !lifecycle.signal.aborted,
      onContinue: handoff => {
        panel.setVisible(true);
        (handoff.resume ? continueReading() : readPage()).catch(reportError);
      }
    });
    return resumed;
  }

  function togglePause() {
    const currentIndex = progress.currentIndex();
    if (!playback.sourceCount()) {
      if (currentIndex < 0 || !state.documentSnapshot.length) {
        if (progress.resumeSnapshot()) continueReading().catch(reportError);
        else readPage().catch(reportError);
      } else {
        playIndex(currentIndex, state.sessionId, playback.elapsed());
      }
      return;
    }

    if (playback.isPlaying()) {
      playback.pause()
        .then(() => {
          panel.setPauseLabel("▶");
          setStatus(tr('status.paragraphPaused', {index: currentIndex + 1}));
          progress.save(true).catch(reportError);
        })
        .catch(reportError);
    } else {
      playback.resume({...audioItem(currentIndex),index:currentIndex,sessionId:state.sessionId})
        .then(() => {
          panel.setPauseLabel("⏸");
          setStatus(tr('status.paragraphReading', {index: currentIndex + 1}));
        })
        .catch(reportError);
    }
  }

  async function stopReading() {
    cancelScheduledNext();
    progress.save(true).catch(reportError);
    state.sessionId += 1;
    clearCurrentSession();
    state.documentSnapshot = contentDocument.createSnapshot([]);
    progress.setDocument(state.documentSnapshot, progressContext(), state.sessionId);
    panel.setPauseLabel("▶");
    setStatus(tr('status.stopped'));
  }

  function clearCurrentSession() {
    progress.stop();
    runtime.cancelScope();
    closeSessionPort();
    progress.clearHighlight();
    playback.stop({clearBuffers: true});
  }

  function setStatus(message) {
    panel.setStatus(message);
  }

  function normalizeResumeText(text) {
    return contentDocument.normalizeText(text)
      .replace(/\s+([,.;:!?])/g, "$1")
      .toLocaleLowerCase();
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, number));
  }

  function getPageKey() {
    const localId = document.body?.dataset.nlrDocumentId || new URL(location.href).searchParams.get("document") || "";
    if (localId) return `local-document:${localId}`;
    return normalizeUrl(location.href);
  }

  function progressContext() {
    const localId = document.body?.dataset.nlrDocumentId || new URL(location.href).searchParams.get("document") || "";
    const canonical = getPageKey();
    const aliases = localId ? [normalizeUrl(location.href), `local:${localId}`] : [normalizeUrl(location.href)];
    return Object.freeze({pageKey: canonical, aliases: Object.freeze(aliases), localDocumentId: localId});
  }

  function normalizeUrl(value) {
    const url = new URL(value, location.href);
    url.hash = "";
    return url.href;
  }

  function formatBytes(bytes) {
    if (!bytes) {
      return "0 MB";
    }
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function isTypingTarget(target) {
    return (
      target instanceof Element &&
      Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
    );
  }

  function safeQuery(root, selector) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function safeQueryAll(root, selector) {
    try {
      return root.querySelectorAll(selector);
    } catch {
      return [];
    }
  }

  function safeClosest(element, selector) {
    try {
      return element.closest(selector);
    } catch {
      return null;
    }
  }
})();
