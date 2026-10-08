const browserGlobals = Object.fromEntries([
  'AbortController','Audio','AudioContext','Blob','CSS','CSSStyleSheet','CustomEvent','DOMParser','Element','File','Node','TextDecoder','TextEncoder','URL','browser','clearInterval','clearTimeout','confirm','crypto','document','fetch','getComputedStyle','history','indexedDB','location','performance','setInterval','setTimeout','window','alert','console','globalThis','SynthesisQueue','NovelProtocol','NovelDocumentStore'
].map(name => [name, 'readonly']));
const nodeGlobals = Object.fromEntries(['__dirname','console','globalThis','process','require','setImmediate','setInterval','setTimeout','clearInterval','clearTimeout','Buffer','AbortController','Response','Headers','TextDecoder','TextEncoder','URL','Blob','SynthesisQueue','performance'].map(name => [name, 'readonly']));
module.exports = [{ ignores: ['vendor/**'] }, {
  files: ['*.js'], ignores: ['vendor/**'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
  rules: {
    'no-undef': 'error',
    'no-unreachable': 'error',
    'no-dupe-keys': 'error',
    'valid-typeof': 'error'
  }
}, {
  files: ['reader.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: browserGlobals }
}, {
  files: ['eslint.config.js'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: {module:'readonly', ...nodeGlobals} }
}, {
  files: ['*.cjs', 'tests/*.cjs', 'tests/support/*.cjs'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'valid-typeof': 'error' }
}];
