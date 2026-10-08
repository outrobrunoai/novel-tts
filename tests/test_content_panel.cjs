const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

const source = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8') +
  fs.readFileSync(require.resolve('../content-panel.js'), 'utf8');

function panelHarness() {
  const elements = new Map();
  const hosts = [];
  const translatables = [];
  class Element {
    constructor(tagName = 'div', id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
      this.hidden = false;
      this.value = '';
      this.checked = false;
      this.classList = {toggle() {}, add() {}, remove() {}};
      this.dataset = {};
      this.style = {setProperty() {}};
      this.adoptedStyleSheets = [];
    }
    set innerHTML(html) {
      for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        const id = match[2].match(/\bid="([^"]+)"/)?.[1];
        const element = new Element(match[1], id);
        element.type = match[2].match(/\btype="([^"]+)"/)?.[1] || '';
        element.dataset.i18n = match[2].match(/\bdata-i18n="([^"]+)"/)?.[1];
        if (element.dataset.i18n) translatables.push(element);
        if (/\bopen(?:\s|=|$)/.test(match[2])) element.open = true;
        element.parentElement = this;
        if (id) elements.set(id, element);
      }
      this.dataDetails = [...html.matchAll(/<details\b([^>]*)>/gi)].map(match => ({
        open: /\bopen(?:\s|=|$)/.test(match[1]), listeners: new Map()
      }));
      this.dataSummaries = translatables.filter(element => element.tagName === 'SUMMARY');
      this.tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => {
        const tab = new Element('button');
        tab.dataset.tab = match[1];
        return tab;
      });
      this.themeChoices = [...html.matchAll(/data-theme-choice="([^"]+)"/g)].map(match => {
        const button = new Element('button');
        button.dataset.themeChoice = match[1];
        return button;
      });
    }
    attachShadow({mode}) {
      this.shadowMode = mode;
      this.shadow = new Element('shadow-root');
      this.shadow.parentElement = this;
      return this.shadow;
    }
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      if (selector === '.nlr-progress-track') return this.progressTrack || null;
      return null;
    }
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return this.tabs || [];
      if (selector === '[data-theme-choice]') return this.themeChoices || [];
      if (selector === '[data-i18n]') return translatables;
      return [];
    }
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    replaceChildren(...children) { this.children = [...children]; }
    addEventListener(type, callback, options = {}) {
      const callbacks = this.listeners.get(type) || [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
      if (options.signal) options.signal.addEventListener('abort', () => this.removeEventListener(type, callback), {once: true});
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback));
    }
    dispatch(type, event = {}) {
      for (const callback of [...(this.listeners.get(type) || [])]) callback({...event, target: this});
    }
    contains(element) {
      for (let current = element; current; current = current.parentElement) if (current === this) return true;
      return false;
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
  }
  const body = new Element('body');
  const document = {
    body,
    documentElement: new Element('html'),
    addEventListener(...args) { return this.documentElement.addEventListener(...args); },
    removeEventListener(...args) { return this.documentElement.removeEventListener(...args); },
    createElement(tagName) {
      const element = new Element(tagName);
      if (tagName === 'section') {
        element.progressTrack = new Element('div');
        elements.set('nlr-progress-track', element.progressTrack);
      }
      if (tagName === 'option') elements.set(`option-${elements.size}`, element);
      return element;
    }
  };
  const context = {document, browser: {i18n: {getUILanguage: () => 'pt-BR'}}, AbortController,
    CSSStyleSheet: class {replaceSync(css) {this.css = css;}}};
  vm.createContext(context);
  vm.runInContext(source, context);
  const panel = context.NovelLocalReader.contentPanel.create({getAssetUrl: file => `moz-extension://id/${file}`});
  hosts.push(...body.children);
  const panelRoot = hosts[0].shadow.children.find(element => element.id === 'nlr-panel');
  return {panel, body, hosts, elements, translatables, panelRoot};
}

test('factory owns its DOM and exposes only panel operations and values', () => {
  const {panel, hosts} = panelHarness();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].shadowMode, 'closed');
  assert.equal(panel.isVisible(), false);
  for (const key of ['host', 'shadow', 'elements', 'controls']) assert.equal(key in panel, false);
  panel.dispose();
});

test('settings snapshot rendering is silent and later control changes emit semantic patches', () => {
  const {panel, elements} = panelHarness();
  const patches = [];
  panel.applySettings({voice: 'voice-x', playbackRate: 1.25, autoNext: false, prefetch: 0, compact: true});
  assert.equal(panel.value('voice'), 'voice-x');
  assert.equal(panel.value('playbackRate'), '1.25');
  assert.equal(panel.value('autoNext'), false);
  assert.equal(panel.value('prefetch'), '0');
  panel.bind({onSetting: (key, value) => patches.push([key, value])});
  panel.applySettings({voice: 'external.wav'});
  assert.deepEqual(patches, []);
  const voice = elements.get('nlr-voice');
  voice.value = 'changed.wav';
  voice.dispatch('input');
  assert.deepEqual(patches, [['voice', 'changed.wav']]);
  panel.dispose();
});

test('semantic actions and visual rendering preserve controls and dispose idempotently', () => {
  const {panel, body, elements} = panelHarness();
  const actions = [];
  panel.setLanguage('pt');
  panel.bind({onAction: action => actions.push(action)});
  elements.get('nlr-read-page').dispatch('click');
  assert.deepEqual(actions, ['readPage']);
  panel.setProgress({index: 1, total: 3, ratio: 2 / 3});
  assert.equal(elements.get('nlr-progress').textContent, '2/3');
  panel.setResume({index: 4});
  assert.equal(elements.get('nlr-continue').textContent, 'Continuar · §5');
  panel.setVisible(true);
  assert.equal(panel.isVisible(), true);
  assert.equal(panel.dispose(), true);
  assert.equal(panel.dispose(), false);
  assert.equal((elements.get('nlr-read-page').listeners.get('click') || []).length, 0);
  assert.equal(body.children.length, 0);
});

test('language selector exists and panel messages follow explicit locale without touching page language', () => {
  const {panel, elements, body} = panelHarness();
  assert.ok(elements.has('nlr-interface-language'));
  panel.setLanguage('en');
  panel.setResume({index: 2});
  assert.equal(elements.get('nlr-continue').textContent, 'Continue · §3');
  assert.equal(body.parentElement, null);
  panel.dispose();
});

test('switching interface language preserves live document text and status while translating resume action', () => {
  const {panel, elements} = panelHarness();
  panel.setLanguage('pt');
  panel.setBookTitle('Título privado da novel');
  panel.setExcerpt('Trecho privado em reprodução');
  panel.setStatus('Gerando parágrafo 5…');
  panel.setDiagnostics('Fila: 2');
  panel.setCacheStats('Cache local: 15 MB');
  panel.setServer('ready', 'Servidor pronto');
  panel.setResume({index: 4});

  panel.setLanguage('en');
  for (const [id, expected] of [
    ['nlr-book-title', 'Título privado da novel'],
    ['nlr-excerpt', 'Trecho privado em reprodução'],
    ['nlr-status-text', 'Gerando parágrafo 5…'],
    ['nlr-diagnostics', 'Fila: 2'],
    ['nlr-cache-stats', 'Cache local: 15 MB'],
    ['nlr-server-text', 'Servidor pronto']
  ]) assert.equal(elements.get(id).textContent, expected, id);
  assert.equal(elements.get('nlr-continue').textContent, 'Continue · §5');
  panel.dispose();
});

test('data disclosure is concise, closed, accessible, translated, and inert', () => {
  const {panel, hosts, translatables, elements, panelRoot} = panelHarness();
  const template = fs.readFileSync(path.join(root, 'content-panel.js'), 'utf8');
  const details = panelRoot.dataDetails[0];
  const summary = panelRoot.dataSummaries.find(element =>
    element.dataset.i18n === 'panel.dataHandlingDisclosure');
  const shortSentence = translatables.find(element => element.dataset.i18n === 'panel.dataHandlingSummary');
  const expandedCopy = translatables.find(element => element.dataset.i18n === 'panel.dataHandlingDetails');
  assert.equal(details.open, false);
  assert.match(template, /<details class="nlr-data-details"><summary data-i18n="panel\.dataHandlingDisclosure">/);
  assert.equal(summary.tagName, 'SUMMARY');
  assert.equal(shortSentence.tagName, 'P');
  assert.equal(expandedCopy.tagName, 'P');

  const actions = [];
  const settings = [];
  panel.bind({onAction: action => actions.push(action), onSetting: patch => settings.push(patch)});
  panel.setStatus('Narration remains in progress');
  const expected = {
    pt: ['O texto escolhido é enviado ao serviço pareado para gerar áudio.', 'Como seus dados são usados'],
    en: ['Selected text is sent to the paired service to generate audio.', 'How your data is used'],
    es: ['El texto elegido se envía al servicio vinculado para generar audio.', 'Cómo se usan tus datos']
  };
  for (const [language, [sentence, label]] of Object.entries(expected)) {
    panel.setLanguage(language);
    assert.equal(shortSentence.textContent, sentence);
    assert.equal(summary.textContent, label);
    assert.match(expandedCopy.textContent, /chapters|capítulos futuros/i);
    assert.match(expandedCopy.textContent, /Qwen/i);
    assert.match(expandedCopy.textContent, /cache|caché/i);
    assert.equal(elements.get('nlr-status-text').textContent, 'Narration remains in progress');
  }
  summary.dispatch('click');
  assert.deepEqual(actions, []);
  assert.deepEqual(settings, []);
  panel.dispose();
});

test('accordion copy sits beside the arrow with its text centered vertically', () => {
  const panelModule = fs.readFileSync(path.join(root, 'content-panel.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'content.css'), 'utf8');
  for (const key of ['panel.voiceSection', 'panel.continuity', 'panel.siteProfile', 'panel.system']) {
    assert.match(panelModule, new RegExp(`<summary><span class="nlr-settings-copy"><strong class="nlr-settings-title" data-i18n="${key}">`));
  }
  assert.match(css, /\.nlr-settings summary\s*\{[^}]*display:grid;[^}]*align-items:center/);
  assert.match(css, /\.nlr-settings summary::before\s*\{[^}]*content:'▸'/);
  assert.match(css, /\.nlr-settings\[open\] summary::before\s*\{[^}]*content:'▾'/);
  assert.match(css, /\.nlr-settings summary \.nlr-settings-title\s*\{[^}]*text-align:left/);
  assert.match(css, /\.nlr-settings summary \.nlr-settings-subtitle\s*\{[^}]*text-align:left/);
  assert.match(css, /\.nlr-settings summary \.nlr-settings-title\s*\{[^}]*color:var\(--nlr-text\)/);
  assert.match(css, /\.nlr-settings summary \.nlr-settings-subtitle\s*\{[^}]*color:var\(--nlr-muted\)/);
});

test('a throwing compositor callback cannot prevent cleanup', () => {
  const {panel, body, elements} = panelHarness();
  panel.bind({onAction() { throw new Error('private callback failure'); }});
  assert.doesNotThrow(() => elements.get('nlr-read-page').dispatch('click'));
  assert.doesNotThrow(() => panel.dispose());
  assert.equal(body.children.length, 0);
});

test('content is a compositor and every panel route loads its factory first', () => {
  const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const panelModule = fs.readFileSync(path.join(root, 'content-panel.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const reader = fs.readFileSync(path.join(root, 'reader.html'), 'utf8');
  assert.doesNotMatch(content, /innerHTML|panel\.querySelector/);
  assert.doesNotMatch(panelModule, /browser\.|storage\.|runtime\.|contentPlayback|contentProgress|contentNavigation|NovelProtocol/);
  for (const source of [reader, background]) {
    const panelIndex = source.indexOf("'content-panel.js'") >= 0
      ? source.indexOf("'content-panel.js'") : source.indexOf('content-panel.js');
    const contentIndex = source.indexOf("'content.js'") >= 0
      ? source.indexOf("'content.js'") : source.indexOf('content.js');
    assert.ok(panelIndex >= 0 && contentIndex > panelIndex, 'panel module precedes content compositor');
  }
  assert.ok(manifest.background.scripts.indexOf('content-panel.js') < manifest.background.scripts.indexOf('background.js'));
  assert.ok(manifest.background.scripts.indexOf('settings-schema.js') < manifest.background.scripts.indexOf('i18n.js'));
  assert.ok(manifest.background.scripts.indexOf('i18n.js') < manifest.background.scripts.indexOf('content-panel.js'));
  assert.ok(reader.indexOf('i18n.js') < reader.indexOf('content-panel.js'));
  for (const file of ['options.html', 'library.html', 'preview.html']) {
    const page = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(page.indexOf('settings-schema.js') < page.indexOf('i18n.js'), file);
  }
  assert.ok(manifest.background.scripts.includes('i18n.js'));
  assert.match(fs.readFileSync(path.join(root, 'scripts/package_release.py'), 'utf8'), /'content-panel\.js'/);
});
