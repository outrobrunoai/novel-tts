(() => {
  const existing = globalThis.NovelLocalReader;
  if (existing?.settingsSchema) return;
  if (existing !== undefined && (typeof existing !== 'object' || !existing)) {
    throw new Error('Namespace NovelLocalReader ocupado.');
  }
  const root = existing || (globalThis.NovelLocalReader = Object.create(null));
  const SETTINGS_DEFAULTS = Object.freeze({
    voice: '', temperature: 0.9, seed: 42, playbackRate: 1, volume: 1,
    prefetch: 2, cacheLimitMb: 4096, autoNext: false, autoNextDelay: 5,
    interfaceLanguage: 'auto',
    nextSelector: '', compact: false, theme: 'midnight', dialogueVoice: '',
    characterVoices: '', expressionMode: 'off', mergeShortLines: true,
    shortLineLimit: 70, preGenerateChapters: 0
  });
  const SETTINGS_RULES = Object.freeze({
    voice: ['string'], temperature: ['number', 0, 2], seed: ['integer', 0, 2147483647],
    playbackRate: ['number', 0.5, 2], volume: ['number', 0, 1], prefetch: ['integer', 0, 5],
    cacheLimitMb: ['integer', 100, 50000], autoNext: ['boolean'], autoNextDelay: ['integer', 2, 30],
    nextSelector: ['string'], compact: ['boolean'], theme: ['enum', ['midnight', 'parchment', 'forest', 'persona', 'rose', 'oled']],
    interfaceLanguage: ['enum', ['auto', 'pt', 'en', 'es']],
    dialogueVoice: ['string'], characterVoices: ['string'], expressionMode: ['enum', ['off', 'smart', 'narration']],
    mergeShortLines: ['boolean'], shortLineLimit: ['integer', 20, 160], preGenerateChapters: ['integer', 0, 3]
  });
  const defaults = SETTINGS_DEFAULTS;
  const rules = SETTINGS_RULES;
  for (const rule of Object.values(rules)) { if (Array.isArray(rule[1])) Object.freeze(rule[1]); Object.freeze(rule); }
  const keys = Object.freeze(Object.keys(SETTINGS_RULES).sort());
  const SETTINGS_PROTOCOL_VERSION = 1;
  const SETTINGS_IMPLEMENTATION = 'background-patch-v1';
  const protocolVersion = SETTINGS_PROTOCOL_VERSION;
  const implementation = SETTINGS_IMPLEMENTATION;
  const valid = (key, value) => {
    const rule = rules[key];
    if (!rule) return false;
    if (rule[0] === 'string') return typeof value === 'string' && value.length <= 10000;
    if (rule[0] === 'boolean') return typeof value === 'boolean';
    if (rule[0] === 'enum') return rule[1].includes(value);
    return typeof value === 'number' && Number.isFinite(value) &&
      (rule[0] !== 'integer' || Number.isInteger(value)) && value >= rule[1] && value <= rule[2];
  };
  const cloneDefaults = () => ({...defaults});
  const normalize = input => {
    const result = cloneDefaults();
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const key of keys) if (valid(key, input[key])) result[key] = input[key];
    }
    return result;
  };
  root.settingsSchema = Object.freeze({defaults, rules, keys, protocolVersion, implementation, valid, normalize, cloneDefaults});
})();
