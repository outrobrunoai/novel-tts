'use strict';
// Test-only. The extension targets Firefox 144 or newer, which ships these built-ins natively,
// and the vendored PDF.js calls them without any polyfill. Node releases that predate them
// (CI runs Node 24) get equivalents here so the tests exercise the same PDF.js code paths
// the extension runs. Only missing methods are defined, so a newer Node is left untouched.
// Never loaded by the extension itself.
function define(target, name, value) {
  if (typeof target[name] === 'function') return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

define(Uint8Array.prototype, 'toHex', function toHex() {
  let hex = '';
  for (const byte of this) hex += byte.toString(16).padStart(2, '0');
  return hex;
});

for (const Collection of [Map, WeakMap]) {
  define(Collection.prototype, 'getOrInsert', function getOrInsert(key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define(Collection.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, callback) {
    if (!this.has(key)) this.set(key, callback(key));
    return this.get(key);
  });
}
