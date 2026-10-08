(() => {
  if (globalThis.NovelLocalReader?.contentPanel) return;
  if (globalThis.NovelLocalReader !== undefined &&
      (typeof globalThis.NovelLocalReader !== 'object' || !globalThis.NovelLocalReader)) {
    throw new Error('Namespace NovelLocalReader ocupado.');
  }

  const root = globalThis.NovelLocalReader ||
    (globalThis.NovelLocalReader = Object.create(null));
  const i18n = root.i18n;
  const CONTROL_IDS = Object.freeze({
    voice: 'nlr-voice', temperature: 'nlr-temperature', seed: 'nlr-seed',
    playbackRate: 'nlr-speed', volume: 'nlr-volume', prefetch: 'nlr-prefetch',
    cacheLimitMb: 'nlr-cache-limit', autoNext: 'nlr-auto-next',
    autoNextDelay: 'nlr-auto-next-delay', nextSelector: 'nlr-next-selector',
    compact: 'nlr-compact', theme: 'nlr-theme', dialogueVoice: 'nlr-dialogue-voice',
    characterVoices: 'nlr-character-voices', expressionMode: 'nlr-expression',
    mergeShortLines: 'nlr-merge-short', shortLineLimit: 'nlr-short-limit',
    preGenerateChapters: 'nlr-pregenerate', interfaceLanguage: 'nlr-interface-language', contentSelector: 'nlr-content-selector',
    ignoreSelector: 'nlr-ignore-selector'
  });
  const ACTION_IDS = Object.freeze({
    connect: 'nlr-connect', diagnose: 'nlr-diagnose', readSelection: 'nlr-read-selection',
    readPage: 'nlr-read-page', library: 'nlr-library', openFile: 'nlr-open-file',
    continue: 'nlr-continue', previous: 'nlr-previous', next: 'nlr-next',
    repeat: 'nlr-repeat', pause: 'nlr-pause', stop: 'nlr-stop',
    clearCache: 'nlr-clear-cache', warmNext: 'nlr-warm-next', allowSite: 'nlr-allow-site',
    testVoice: 'nlr-test-voice', saveProfile: 'nlr-save-profile',
    pickContent: 'nlr-pick-content', pickNext: 'nlr-pick-next'
  });
  const CHANGE_ONLY = new Set([
    'autoNext', 'compact', 'theme', 'expressionMode', 'mergeShortLines', 'interfaceLanguage'
  ]);

  function create({getAssetUrl, onStylesUnavailable} = {}) {
    const doc = globalThis.document;
    if (!doc?.createElement || typeof getAssetUrl !== 'function') {
      throw new TypeError('Panel requires a document and an asset URL callback.');
    }
    const host = doc.createElement('nlr-reader-host');
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('display', 'block', 'important');
    const shadow = host.attachShadow({mode: 'closed'});
    const controls = Object.create(null);
    const views = Object.create(null);
    const actionButtons = Object.create(null);
    const styleLinks = [];
    let disposed = false;
    let bound = false;
    let styleFallbackRequested = false;
    let picker = null;
    let theme = 'midnight';
    const listeners = new AbortController();

    for (const file of ['themes.css', 'content.css']) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = getAssetUrl(file);
      link.addEventListener('error', () => {
        if (styleFallbackRequested) return;
        styleFallbackRequested = true;
        safeCall(onStylesUnavailable, css => adoptStyles(css));
      }, {once: true, signal: listeners.signal});
      styleLinks.push(link);
      shadow.appendChild(link);
    }

    const panelElement = doc.createElement('section');
    panelElement.id = 'nlr-panel';
    panelElement.hidden = true;
    panelElement.setAttribute('aria-label', 'Novel TTS');
    panelElement.innerHTML = `
      <header class="nlr-header">
        <div class="nlr-brand"><span class="nlr-logo" aria-hidden="true">n.</span><div><strong>Novel</strong><small>TTS <span class="nlr-version">1.0.0</span></small></div></div>
        <button id="nlr-close" title="Fechar painel" aria-label="Fechar painel" data-i18n-title="panel.close" data-i18n-aria-label="panel.close">×</button>
      </header>
      <nav class="nlr-tabs" role="tablist" aria-label="Áreas do leitor" data-i18n-aria-label="panel.tabs">
        <button id="nlr-tab-listen" role="tab" aria-controls="nlr-view-listen" aria-selected="true" data-tab="listen" data-i18n="panel.listen">Ouvir</button>
        <button id="nlr-tab-appearance" role="tab" aria-controls="nlr-view-appearance" aria-selected="false" tabindex="-1" data-tab="appearance" data-i18n="panel.appearance">Aparência</button>
        <button id="nlr-tab-settings" role="tab" aria-controls="nlr-view-settings" aria-selected="false" tabindex="-1" data-tab="settings" data-i18n="panel.settings">Ajustes</button>
      </nav>
      <section id="nlr-view-listen" role="tabpanel" aria-labelledby="nlr-tab-listen">
        <div class="nlr-book"><span class="nlr-eyebrow" data-i18n="panel.eyebrow">SEU PRÓXIMO CAPÍTULO</span><h2 id="nlr-book-title" data-i18n="panel.bookTitle">Uma pausa para ouvir.</h2>
          <p id="nlr-excerpt" data-i18n="panel.excerpt">Abra um capítulo ou selecione um trecho. A história cuida do resto.</p></div>
        <div class="nlr-status"><span id="nlr-status-text" role="status" aria-live="polite" data-i18n="panel.ready">Pronto para começar.</span><strong id="nlr-progress">0/0</strong></div>
        <div class="nlr-progress-track" role="progressbar" aria-label="Progresso de leitura" data-i18n-aria-label="panel.progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="nlr-progress-bar"></span></div>
        <div class="nlr-controls">
          <button id="nlr-repeat" title="Repetir trecho" aria-label="Repetir trecho" data-i18n-title="panel.repeat" data-i18n-aria-label="panel.repeat">↻</button>
          <button id="nlr-previous" title="Trecho anterior" aria-label="Trecho anterior" data-i18n-title="panel.previous" data-i18n-aria-label="panel.previous">⏮</button>
          <button id="nlr-pause" class="nlr-main-control" title="Pausar ou continuar" aria-label="Pausar ou continuar" data-i18n-title="panel.pause" data-i18n-aria-label="panel.pause">▶</button>
          <button id="nlr-next" title="Próximo trecho" aria-label="Próximo trecho" data-i18n-title="panel.next" data-i18n-aria-label="panel.next">⏭</button>
          <button id="nlr-stop" title="Parar leitura e cancelar fila" aria-label="Parar leitura e cancelar fila" data-i18n-title="panel.stop" data-i18n-aria-label="panel.stop">■</button>
        </div>
        <div class="nlr-actions"><button id="nlr-read-page" class="nlr-primary" data-i18n="panel.readPage">Ler página</button><button id="nlr-read-selection" data-i18n="panel.readSelection">Ler seleção</button><button id="nlr-continue" hidden data-i18n="panel.continue">Continuar</button></div>
        <p class="nlr-note" data-i18n="panel.dataHandlingSummary">O texto escolhido é enviado ao serviço pareado para gerar áudio.</p>
        <details class="nlr-data-details"><summary data-i18n="panel.dataHandlingDisclosure">Como seus dados são usados</summary>
          <p data-i18n="panel.dataHandlingDetails">Capítulos futuros também podem ser enviados quando a pré-geração estiver ativada. O host pode encaminhar o texto ao Qwen configurado; documentos e cache podem ser armazenados localmente.</p>
        </details>
        <div class="nlr-quick nlr-settings-row">
          <label><span data-i18n="panel.narrator">Voz do narrador</span><input id="nlr-voice" list="nlr-voices" placeholder="Padrão do servidor" data-i18n-placeholder="panel.serverDefault"><datalist id="nlr-voices"></datalist></label>
          <label><span data-i18n="panel.speed">Velocidade</span><select id="nlr-speed"><option value="0.75">0,75×</option><option value="0.9">0,90×</option><option value="1">1,00×</option><option value="1.1">1,10×</option><option value="1.25">1,25×</option><option value="1.5">1,50×</option><option value="2">2,00×</option></select></label>
        </div>
        <label class="nlr-volume"><span data-i18n="panel.volume">Volume</span><input id="nlr-volume" type="range" min="0" max="1" step="0.05" aria-label="Volume" data-i18n-aria-label="panel.volume"></label>
      </section>
      <section id="nlr-view-appearance" role="tabpanel" aria-labelledby="nlr-tab-appearance" hidden>
        <div class="nlr-section-heading"><span class="nlr-eyebrow" data-i18n="panel.doYourWay">DO SEU JEITO</span><h2 data-i18n="panel.readingMood">O clima da leitura.</h2><p data-i18n="panel.paletteNote">Seis paletas. Um espaço para se concentrar.</p></div>
        <div class="nlr-theme-grid" aria-label="Escolha um tema" data-i18n-aria-label="panel.chooseTheme">
          <button data-theme-choice="midnight" aria-pressed="false"><span class="nlr-swatch" style="--sw-bg:#181923;--sw-accent:#b9a3ff"></span><strong data-i18n="theme.midnight">Meia-noite</strong><small data-i18n="theme.midnightDesc">Lavanda & carvão</small></button>
          <button data-theme-choice="parchment" aria-pressed="false"><span class="nlr-swatch" style="--sw-bg:#f5eddf;--sw-accent:#885126"></span><strong data-i18n="theme.parchment">Papel</strong><small data-i18n="theme.parchmentDesc">Luz quente & tinta</small></button>
          <button data-theme-choice="forest" aria-pressed="false"><span class="nlr-swatch" style="--sw-bg:#142721;--sw-accent:#9ed9b6"></span><strong data-i18n="theme.forest">Bosque</strong><small data-i18n="theme.forestDesc">Verde & silêncio</small></button>
          <button data-theme-choice="persona" aria-pressed="false"><span class="nlr-swatch" style="--sw-bg:#11223c;--sw-accent:#91caff"></span><strong data-i18n="theme.ocean">Oceano</strong><small data-i18n="theme.oceanDesc">Azul & brisa</small></button>
          <button data-theme-choice="rose" aria-pressed="false"><span class="nlr-swatch" style="--sw-bg:#2c1c26;--sw-accent:#f4abc4"></span><strong data-i18n="theme.rose">Rosé</strong><small data-i18n="theme.roseDesc">Rosa & ameixa</small></button>
          <button data-theme-choice="oled" aria-pressed="false"><span class="nlr-swatch" style="--sw-bg:#000;--sw-accent:#f1f1f1"></span><strong data-i18n="theme.oled">OLED</strong><small data-i18n="theme.oledDesc">Preto & contraste</small></button>
        </div>
        <select id="nlr-theme" hidden aria-label="Tema" data-i18n-aria-label="panel.theme"><option value="midnight" data-i18n="theme.midnight">Meia-noite</option><option value="parchment" data-i18n="theme.parchment">Papel</option><option value="forest" data-i18n="theme.forest">Bosque</option><option value="persona" data-i18n="theme.ocean">Oceano</option><option value="rose" data-i18n="theme.rose">Rosé</option><option value="oled" data-i18n="theme.oled">OLED</option></select>
        <label class="nlr-check"><input id="nlr-compact" type="checkbox"><span data-i18n="panel.compact">Painel compacto</span></label>
        <p class="nlr-note" data-i18n="panel.themeNote">O tema acompanha o painel, a biblioteca e o leitor de arquivos. Salvo automaticamente.</p>
      </section>
      <section id="nlr-view-settings" role="tabpanel" aria-labelledby="nlr-tab-settings" hidden>
        <div class="nlr-section-heading"><span class="nlr-eyebrow" data-i18n="panel.lessDistractions">MENOS DISTRAÇÕES</span><h2 data-i18n="panel.settingsHeading">Ajuste uma vez. Aproveite.</h2></div>
        <details class="nlr-settings"><summary><span class="nlr-settings-copy"><strong class="nlr-settings-title" data-i18n="panel.voiceSection">Voz e narração</strong><span class="nlr-settings-subtitle" data-i18n="panel.voiceSubtitle">Amostra, temperatura e seed</span></span></summary>
          <button id="nlr-test-voice" data-i18n="panel.testVoice">Ouvir amostra da voz</button>
          <div id="nlr-multiple-voices-controls" hidden>
            <label><span data-i18n="panel.dialogueVoice">Voz dos diálogos</span><input id="nlr-dialogue-voice" list="nlr-voices" placeholder="Mesma do narrador" data-i18n-placeholder="panel.sameAsNarrator"></label>
            <label><span data-i18n="panel.characterVoices">Vozes por personagem</span><textarea id="nlr-character-voices" rows="3" placeholder="Alice=voice-alice&#10;Bob=voice-bob" data-i18n-placeholder="panel.characterVoicesPlaceholder"></textarea></label>
          </div>
          <label id="nlr-expression-control" hidden><span data-i18n="panel.expression">Instruções de expressão</span><select id="nlr-expression"><option value="off" data-i18n="expression.off">Desativadas</option><option value="smart" data-i18n="expression.smart">Automáticas</option><option value="narration" data-i18n="expression.narration">Narração uniforme</option></select></label>
          <div class="nlr-settings-row"><label><span data-i18n="panel.temperature">Temperatura</span><input id="nlr-temperature" type="number" min="0" max="2" step="0.1"></label><label><span data-i18n="panel.seed">Seed</span><input id="nlr-seed" type="number" min="0" max="2147483647" step="1"></label></div>
        </details>
        <details class="nlr-settings"><summary><span class="nlr-settings-copy"><strong class="nlr-settings-title" data-i18n="panel.continuity">Continuidade</strong><span class="nlr-settings-subtitle" data-i18n="panel.continuitySubtitle">Buffer e próximos capítulos</span></span></summary>
          <label class="nlr-check"><input id="nlr-merge-short" type="checkbox"><span data-i18n="panel.mergeShort">Agrupar linhas curtas</span></label>
          <div class="nlr-settings-row"><label><span data-i18n="panel.lineLimit">Limite da linha</span><input id="nlr-short-limit" type="number" min="20" max="160" step="10"></label><label><span data-i18n="panel.ahead">Trechos à frente</span><input id="nlr-prefetch" type="number" min="0" max="5" step="1"></label></div>
          <label class="nlr-check"><input id="nlr-auto-next" type="checkbox"><span data-i18n="panel.autoNext">Continuar no próximo capítulo</span></label>
          <p id="nlr-auto-next-note" class="nlr-note" hidden><span data-i18n="panel.permissionNote">Este site ainda não tem permissão para abrir o leitor sozinho depois da troca de capítulo.</span><button id="nlr-allow-site" data-i18n="panel.allowSite">Autorizar este site ↗</button></p>
          <div class="nlr-settings-row"><label><span data-i18n="panel.delay">Espera (s)</span><input id="nlr-auto-next-delay" type="number" min="2" max="30"></label><label><span data-i18n="panel.pregenerate">Pré-gerar capítulos</span><input id="nlr-pregenerate" type="number" min="0" max="3"></label></div>
          <button id="nlr-warm-next" data-i18n="panel.warmNext">Preparar próximo capítulo</button>
          <p class="nlr-note" data-i18n="panel.priorityNote">A leitura atual tem prioridade. Parar descarta a fila; um trecho já na GPU pode terminar.</p>
        </details>
        <details class="nlr-settings"><summary><span class="nlr-settings-copy"><strong class="nlr-settings-title" data-i18n="panel.siteProfile">Perfil do site</strong><span class="nlr-settings-subtitle" data-i18n="panel.siteProfileSubtitle">Escolha o que será lido</span></span></summary>
          <label><span data-i18n="panel.chapterArea">Área do capítulo</span><input id="nlr-content-selector" placeholder=".chapter-content"></label>
          <label><span data-i18n="panel.ignoredElements">Elementos ignorados</span><input id="nlr-ignore-selector" placeholder=".ads, .translator-note"></label>
          <label><span data-i18n="panel.nextButton">Botão de próximo capítulo</span><input id="nlr-next-selector" placeholder=".next-chapter"></label>
          <div class="nlr-settings-row"><button id="nlr-pick-content" data-i18n="panel.pickContent">Escolher conteúdo</button><button id="nlr-pick-next" data-i18n="panel.pickNext">Escolher próximo</button></div>
          <button id="nlr-save-profile" class="nlr-primary" data-i18n="panel.saveProfile">Salvar perfil</button>
        </details>
        <details class="nlr-settings"><summary><span class="nlr-settings-copy"><strong class="nlr-settings-title" data-i18n="panel.system">Sistema</strong><span class="nlr-settings-subtitle" data-i18n="panel.systemSubtitle">Conexão, cache e diagnóstico</span></span></summary>
          <label><span data-i18n="panel.language">Idioma da interface</span><select id="nlr-interface-language"><option value="auto" data-i18n="language.auto">Automático</option><option value="pt" data-i18n="language.pt">Português</option><option value="en" data-i18n="language.en">English</option><option value="es" data-i18n="language.es">Español</option></select></label>
          <button id="nlr-connect" data-i18n="panel.connect">Conectar serviço local</button><button id="nlr-diagnose" data-i18n="panel.diagnose">Verificar conexão</button>
          <p id="nlr-diagnostics" class="nlr-note" data-i18n="panel.localQwen">Qwen3-TTS local · voz clonada e cache local.</p>
          <p id="nlr-settings-diagnostic" class="nlr-note" role="alert" hidden></p>
          <label><span data-i18n="panel.cacheLimit">Limite do cache local (MB)</span><input id="nlr-cache-limit" type="number" min="100" max="50000" step="100" disabled></label>
          <p class="nlr-note" data-i18n="panel.cacheLimitNote">Limite definido no config.json do serviço. A atualização não apaga o cache existente.</p>
          <small id="nlr-cache-stats" data-i18n="panel.cacheNotChecked">Cache ainda não consultado.</small>
          <button id="nlr-clear-cache" class="nlr-danger" data-i18n="panel.clearCache">Limpar cache local</button>
        </details>
      </section>
      <footer class="nlr-footer"><button id="nlr-library" data-i18n="panel.library">Biblioteca ↗</button><button id="nlr-open-file" data-i18n="panel.openFile">Abrir arquivo ↗</button></footer>
      <div class="nlr-server"><span id="nlr-server-dot"></span><span id="nlr-server-text" data-i18n="panel.checkConnection">Verifique a conexão em Ajustes</span></div>
    `;
    i18n?.apply(panelElement);
    shadow.appendChild(panelElement);
    (doc.body || doc.documentElement).appendChild(host);
    const query = selector => panelElement.querySelector(selector);
    for (const [name, id] of Object.entries(CONTROL_IDS)) controls[name] = query(`#${id}`);
    for (const [name, id] of Object.entries(ACTION_IDS)) actionButtons[name] = query(`#${id}`);
    for (const id of ['listen', 'appearance', 'settings']) views[id] = query(`#nlr-view-${id}`);
    const elements = Object.freeze({
      close: query('#nlr-close'), tabs: [...panelElement.querySelectorAll('[data-tab]')],
      themeChoices: [...panelElement.querySelectorAll('[data-theme-choice]')],
      status: query('#nlr-status-text'), diagnostics: query('#nlr-diagnostics'),
      settingsDiagnostic: query('#nlr-settings-diagnostic'), progress: query('#nlr-progress'),
      progressBar: query('#nlr-progress-bar'), progressTrack: query('.nlr-progress-track'),
      bookTitle: query('#nlr-book-title'), excerpt: query('#nlr-excerpt'),
      serverDot: query('#nlr-server-dot'), serverText: query('#nlr-server-text'),
      autoNextNote: query('#nlr-auto-next-note'), cacheStats: query('#nlr-cache-stats'),
      voiceList: query('#nlr-voices'), multipleVoiceControls: query('#nlr-multiple-voices-controls'),
      expressionControl: query('#nlr-expression-control')
    });
    const liveText = new Map();
    let resumeIndex = null;

    function setLiveText(element, text) {
      element.textContent = text;
      liveText.set(element, text);
    }

    function value(name) {
      const element = controls[name];
      if (!element) return undefined;
      return element.type === 'checkbox' ? element.checked : element.value;
    }
    function setValue(name, next) {
      const element = controls[name];
      if (!element) return false;
      if (element.type === 'checkbox') element.checked = Boolean(next);
      else element.value = String(next ?? '');
      if (name === 'theme') setTheme(next);
      if (name === 'compact') panelElement.classList.toggle('nlr-compact', Boolean(next));
      return true;
    }
    function setTheme(nextTheme) {
      const available = ['midnight', 'parchment', 'forest', 'persona', 'rose', 'oled'];
      theme = available.includes(nextTheme) ? nextTheme : 'midnight';
      panelElement.dataset.theme = theme;
      for (const button of elements.themeChoices) {
        button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
      }
      if (controls.theme.value !== theme) controls.theme.value = theme;
      return theme;
    }
    function selectTab(name) {
      for (const tab of elements.tabs) {
        const active = tab.dataset.tab === name;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        views[tab.dataset.tab].hidden = !active;
      }
    }
    function setVisible(visible) { panelElement.hidden = !Boolean(visible); }
    function createStableSelector(element) {
      if (!(element instanceof globalThis.Element)) return '';
      if (element.id) return `#${globalThis.CSS.escape(element.id)}`;
      for (const attribute of ['data-testid', 'data-chapter', 'aria-label', 'rel']) {
        const value = element.getAttribute(attribute);
        if (value) {
          return `${element.tagName.toLowerCase()}[${attribute}="${globalThis.CSS.escape(value)}"]`;
        }
      }
      const classes = [...element.classList]
        .filter(name => !/^(active|selected|hover|css-|jsx-)/i.test(name))
        .slice(0, 2);
      if (classes.length) {
        return `${element.tagName.toLowerCase()}${classes.map(name => `.${globalThis.CSS.escape(name)}`).join('')}`;
      }
      return element.tagName.toLowerCase();
    }
    function clearPicker({restorePanel = true} = {}) {
      if (!picker) return false;
      const active = picker;
      picker = null;
      if (active.timer !== null) globalThis.clearTimeout(active.timer);
      if (active.handler) doc.removeEventListener('click', active.handler, true);
      doc.documentElement.classList.remove('nlr-picking');
      if (restorePanel && !disposed) setVisible(true);
      return true;
    }
    function beginPicker(kind, onSelected) {
      if (disposed || !['content', 'next'].includes(kind)) return false;
      clearPicker({restorePanel: false});
      setLiveText(elements.status, kind === 'content'
        ? i18n?.t('panel.pickingContent')
        : i18n?.t('panel.pickingNext'));
      setVisible(false);
      doc.documentElement.classList.add('nlr-picking');
      picker = {timer: null, handler: null};
      picker.timer = globalThis.setTimeout(() => {
        if (disposed || !picker) return;
        picker.timer = null;
        const current = picker;
        current.handler = event => {
          const path = event.composedPath?.() || [];
          if (path.includes(host) || host.contains(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          const selector = createStableSelector(event.target);
          clearPicker({restorePanel: false});
          setVisible(true);
          safeCall(onSelected, kind, selector);
        };
        doc.addEventListener('click', current.handler, true);
      }, 100);
      return true;
    }
    function applySettings(settings) {
      for (const name of Object.keys(CONTROL_IDS)) {
        if (Object.hasOwn(settings, name)) setValue(name, settings[name]);
      }
    }
    function safeCall(callback, ...args) {
      try {
        const result = callback?.(...args);
        if (result && typeof result.then === 'function') result.catch(() => undefined);
      } catch {
        // A compositor callback must never break panel cleanup or other actions.
      }
    }
    function adoptStyles(css) {
      if (disposed || typeof css !== 'string' || !css) return false;
      try {
        const sheet = new globalThis.CSSStyleSheet();
        sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
        for (const link of styleLinks) link.remove();
        return true;
      } catch {
        return false;
      }
    }
    function bind(callbacks = {}) {
      if (disposed || bound) return false;
      bound = true;
      for (const tab of elements.tabs) {
        tab.addEventListener('click', () => selectTab(tab.dataset.tab), {signal: listeners.signal});
        tab.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = elements.tabs.indexOf(tab);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? elements.tabs.length - 1 :
            (index + (event.key === 'ArrowRight' ? 1 : -1) + elements.tabs.length) % elements.tabs.length;
          selectTab(elements.tabs[next].dataset.tab);
          elements.tabs[next].focus();
        }, {signal: listeners.signal});
      }
      for (const button of elements.themeChoices) {
        button.addEventListener('click', () => {
          setValue('theme', button.dataset.themeChoice);
          safeCall(callbacks.onSetting, 'theme', value('theme'));
        }, {signal: listeners.signal});
      }
      elements.close.addEventListener('click', () => setVisible(false), {signal: listeners.signal});
      for (const [action, button] of Object.entries(actionButtons)) {
        button.addEventListener('click', () => safeCall(callbacks.onAction, action), {signal: listeners.signal});
      }
      for (const [name, element] of Object.entries(controls)) {
        element.addEventListener(CHANGE_ONLY.has(name) ? 'change' : 'input', () =>
          safeCall(callbacks.onSetting, name, value(name)), {signal: listeners.signal});
      }
      doc.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (clearPicker()) {
          setLiveText(elements.status, i18n?.t('panel.selectionCancelled') || 'Seleção cancelada.');
          return;
        }
        if (!panelElement.hidden) setVisible(false);
      }, {signal: listeners.signal});
      return true;
    }
    function dispose() {
      if (disposed) return false;
      disposed = true;
      clearPicker({restorePanel: false});
      listeners.abort();
      host.remove();
      return true;
    }
    const api = Object.freeze({
      bind, beginPicker, cancelPicker: () => clearPicker(), dispose,
      contains: element => host.contains(element),
      isVisible: () => !panelElement.hidden,
      setVisible,
      toggle: () => { setVisible(panelElement.hidden); return !panelElement.hidden; },
      selectTab, value, setValue, applySettings, setTheme,
      theme: () => theme,
      setStatus: text => setLiveText(elements.status, text),
      setLanguage: language => {
        if (disposed) return false;
        i18n?.setLanguage(language, globalThis.browser, panelElement);
        for (const [element, text] of liveText) element.textContent = text;
        if (resumeIndex !== null) {
          actionButtons.continue.textContent = `${i18n?.t('panel.continue') || 'Continuar'} · §${resumeIndex + 1}`;
        }
        return true;
      },
      setDiagnostics: text => setLiveText(elements.diagnostics, text),
      setSettingsDiagnostic: text => {
        if (!elements.settingsDiagnostic) return;
        elements.settingsDiagnostic.textContent = text || '';
        elements.settingsDiagnostic.hidden = !text;
      },
      setProgress: ({index, total, ratio}) => {
        elements.progress.textContent = index >= 0 ? `${index + 1}/${total}` : `0/${total}`;
        elements.progressBar.style.width = `${ratio * 100}%`;
        elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      },
      setPauseLabel: text => { actionButtons.pause.textContent = text; },
      setBookTitle: text => setLiveText(elements.bookTitle, text),
      setExcerpt: text => setLiveText(elements.excerpt, text),
      setResume: resume => {
        actionButtons.continue.hidden = !resume;
        resumeIndex = resume ? resume.index : null;
        if (resume) actionButtons.continue.textContent = `${i18n?.t('panel.continue') || 'Continuar'} · §${resumeIndex + 1}`;
      },
      setAutoNextNoteHidden: hidden => { elements.autoNextNote.hidden = Boolean(hidden); },
      setExpressionSupported: supported => {
        if (controls.expressionMode) controls.expressionMode.disabled = !supported;
        if (elements.expressionControl) elements.expressionControl.hidden = !supported;
      },
      setMultipleVoicesSupported: supported => {
        if (elements.multipleVoiceControls) elements.multipleVoiceControls.hidden = !supported;
      },
      setCacheLimit: next => setValue('cacheLimitMb', next),
      setCacheStats: text => setLiveText(elements.cacheStats, text),
      setServer: (kind, text) => { elements.serverDot.className = kind; setLiveText(elements.serverText, text); },
      setProfile: profile => {
        setValue('contentSelector', profile.contentSelector || '');
        setValue('ignoreSelector', profile.ignoreSelector || '');
        if (profile.nextSelector) setValue('nextSelector', profile.nextSelector);
      },
      profileValues: () => ({
        contentSelector: String(value('contentSelector') || ''),
        ignoreSelector: String(value('ignoreSelector') || ''),
        nextSelector: String(value('nextSelector') || '')
      }),
      setVoiceChoices: voices => {
        elements.voiceList.replaceChildren();
        for (const voice of voices) {
          const option = doc.createElement('option');
          option.value = voice;
          elements.voiceList.appendChild(option);
        }
      },
      adoptStyles
    });
    selectTab('listen');
    return api;
  }

  root.contentPanel = Object.freeze({create});
})();
