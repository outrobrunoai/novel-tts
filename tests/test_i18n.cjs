const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = ['settings-schema.js', 'i18n.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const interfaceFiles = [
  'content-panel.js', 'content.js', 'reader.html', 'reader.js', 'reader-bootstrap.js',
  'library.html', 'library.js', 'options.html', 'options.js', 'preview.html', 'preview.js'
];

function loadI18n(browser = {}) {
  const context = {browser, Intl, console};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.NovelLocalReader.i18n;
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
}

test('Portuguese, English, and Spanish catalogs have identical keys and placeholders', () => {
  const i18n = loadI18n();
  const {pt, en, es} = i18n.catalogs;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  assert.deepEqual(Object.keys(es).sort(), Object.keys(pt).sort());
  for (const key of Object.keys(pt)) {
    assert.deepEqual(placeholders(en[key]), placeholders(pt[key]), `English placeholders: ${key}`);
    assert.deepEqual(placeholders(es[key]), placeholders(pt[key]), `Spanish placeholders: ${key}`);
  }
});

test('Firefox data disclosure declares required content/authentication without unrelated optional collection', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const gecko = manifest.browser_specific_settings.gecko;
  assert.equal(manifest.version, '1.0.0');
  assert.ok(Number.parseFloat(gecko.strict_min_version) >= 140);
  assert.deepEqual(gecko.data_collection_permissions.required,
    ['authenticationInfo', 'websiteContent']);
  assert.equal(Object.hasOwn(gecko.data_collection_permissions, 'optional'), false);
  assert.equal(gecko.data_collection_permissions.required.includes('none'), false);
});

test('privacy notices cover local text routing and functional synthesis parameters in all locales', () => {
  const {pt, en, es} = loadI18n().catalogs;
  const expectedSummaries = {
    pt: 'O texto escolhido é enviado ao serviço pareado para gerar áudio.',
    en: 'Selected text is sent to the paired service to generate audio.',
    es: 'El texto elegido se envía al servicio vinculado para generar audio.'
  };
  for (const [language, catalogue] of Object.entries({pt, en, es})) {
    assert.equal(catalogue['panel.dataHandlingSummary'], expectedSummaries[language]);
    assert.ok(catalogue['panel.dataHandlingDisclosure'].length > 10);
    assert.ok(catalogue['panel.dataHandlingDetails'].length > 40);
    assert.match(catalogue['panel.dataHandlingDetails'], /future chapters|Capítulos futuros|capítulos futuros/i);
    assert.match(catalogue['panel.dataHandlingDetails'], /Qwen/i);
    assert.ok(catalogue['options.dataHandling'].length > 40);
    assert.match(catalogue['panel.dataHandlingDetails'], /Qwen|Qwen configurado|Qwen endpoint/i);
    assert.equal(Object.hasOwn(catalogue, 'options.allowSynthesisSettings'), false);
  }
});

test('every interface translation reference exists in every catalog', () => {
  const i18n = loadI18n();
  const keys = new Set();
  for (const file of interfaceFiles) {
    const sourceText = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of sourceText.matchAll(/(?:data-i18n(?:-[a-z-]+)?|(?:i18n\??\.t|tr))\s*[=(]\s*['"]([A-Za-z0-9_.-]+)['"]/g)) {
      keys.add(match[1]);
    }
  }
  for (const language of ['pt', 'en', 'es']) {
    for (const key of keys) assert.equal(typeof i18n.catalogs[language][key], 'string', `${language}:${key}`);
  }
});

test('automatic locale supports Portuguese, English, and Spanish and safely falls back to Portuguese', () => {
  const i18n = loadI18n();
  const browser = locale => ({i18n: {getUILanguage: () => locale}});
  assert.equal(i18n.resolveChoice('auto', browser('pt-BR')), 'pt');
  assert.equal(i18n.resolveChoice('auto', browser('en-US')), 'en');
  assert.equal(i18n.resolveChoice('auto', browser('es-MX')), 'es');
  assert.equal(i18n.resolveChoice('auto', browser('fr-FR')), 'pt');
  assert.equal(i18n.resolveChoice('en', browser('pt-BR')), 'en');
  assert.equal(i18n.resolveChoice('es', browser('en-US')), 'es');
});

test('panel, reader, library, import, and errors render in all three selected languages', () => {
  const i18n = loadI18n();
  const labels = ['panel.settings', 'reader.cancelImport', 'library.empty', 'options.save',
    'status.preferenceError', 'reader.pdfPage'];
  const nodes = labels.map(key => ({dataset: {i18n: key}, textContent: '', setAttribute(name, value) {
    this[name] = value;
  }}));
  const document = {nodeType: 9, documentElement: {}, querySelectorAll: selector =>
    selector === '[data-i18n]' ? nodes : []};
  for (const language of ['pt', 'en', 'es']) {
    i18n.setLanguage(language, {}, document);
    assert.equal(document.documentElement.lang, language);
    for (let index = 0; index < labels.length; index += 1) {
      const rendered = nodes[index].textContent;
      assert.ok(rendered.length > 0, `${language}:${labels[index]} is rendered`);
      assert.notEqual(rendered, labels[index]);
    }
    assert.match(nodes.at(-1).textContent, /\{page\}\/\{total\}/);
  }
});

test('substitutions remain plain text and never parse external names as markup', () => {
  const i18n = loadI18n();
  i18n.setLanguage('en');
  assert.equal(i18n.t('reader.openingFile', {name: '<img src=x onerror=alert(1)>'}),
    'Opening <img src=x onerror=alert(1)>…');
});

test('settings handshake requires the validated preference contract and interface-language key', () => {
  const i18n = loadI18n();
  const settingKeys = ['autoNext','autoNextDelay','cacheLimitMb','characterVoices','compact','dialogueVoice',
    'expressionMode','interfaceLanguage','mergeShortLines','nextSelector','playbackRate','preGenerateChapters',
    'prefetch','seed','shortLineLimit','temperature','theme','voice','volume'];
  const good = {ok: true, settings_protocol: 1, implementation: 'background-patch-v1', revision: 4,
    accepted_keys: settingKeys, settings: {interfaceLanguage: 'es'}};
  assert.equal(i18n.validSettingsResponse(good), true);
  assert.equal(i18n.validSettingsResponse({...good, accepted_keys: []}), false);
  assert.equal(i18n.validSettingsResponse({...good, settings: {interfaceLanguage: 'fr'}}), false);
});

test('user-visible sources no longer carry the previous product name', () => {
  const files = ['manifest.json', 'i18n.js', 'options.html', 'library.html', 'reader.html', 'preview.html',
    'content-panel.js', 'reader.js', 'library.js', 'icon.svg'];
  const offenders = files.filter(file => /novel\s+local\s+reader/i.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
  assert.equal(JSON.parse(fs.readFileSync('manifest.json', 'utf8')).name, 'Novel TTS');
});
