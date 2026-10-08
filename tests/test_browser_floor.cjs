const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const minimum = manifest.browser_specific_settings.gecko.strict_min_version;

// Built-ins that the vendored PDF.js calls without any polyfill, with the oldest real Firefox
// in which each one was OBSERVED to exist (headless probes of Firefox 142, 143, 144 and 157
// running the product's own PDF import on real PDFs; see TESTING.md). When vendor/ is updated,
// extend this table: the declared minimum must never be lower than what the library needs.
const OBSERVED_IN_FIREFOX = Object.freeze({
  'Uint8Array.prototype.toHex': { pattern: /\.toHex\(/, firefox: 142 },
  'Uint8Array base64 methods': { pattern: /\.(?:toBase64|fromBase64)\(/, firefox: 142 },
  'Math.sumPrecise': { pattern: /Math\.sumPrecise\(/, firefox: 142 },
  'Promise.try': { pattern: /Promise\.try\(/, firefox: 142 },
  'Float16Array / Math.f16round': { pattern: /Float16Array|Math\.f16round/, firefox: 142 },
  'Set.prototype.union': { pattern: /\.union\(/, firefox: 142 },
  'URL.parse': { pattern: /URL\.parse\(/, firefox: 142 },
  'ArrayBuffer.prototype.transfer': { pattern: /\.transfer\(/, firefox: 142 },
  'Map/WeakMap.prototype.getOrInsert': { pattern: /\.getOrInsert\(/, firefox: 144 },
  'Map/WeakMap.prototype.getOrInsertComputed': { pattern: /\.getOrInsertComputed\(/, firefox: 144 }
});

test('the declared Firefox minimum covers every built-in the vendored PDF.js calls', () => {
  const declared = Number.parseInt(minimum, 10);
  assert.ok(Number.isInteger(declared), `strict_min_version ${minimum}`);
  const vendored = ['vendor/pdf.mjs', 'vendor/pdf.worker.mjs'].map(read).join('\n');
  const needed = Object.entries(OBSERVED_IN_FIREFOX)
    .filter(([, entry]) => entry.pattern.test(vendored))
    .map(([name, entry]) => ({ name, firefox: entry.firefox }));
  assert.ok(needed.length >= 5, 'the table still matches the vendored library');
  const tooNew = needed.filter((entry) => entry.firefox > declared);
  assert.deepEqual(tooNew, [], `strict_min_version ${minimum} is older than what PDF.js needs`);
});

test('the Firefox minimum is stated the same way in the manifest and the documentation', () => {
  const major = Number.parseInt(minimum, 10);
  assert.match(minimum, /^\d+\.0$/);
  assert.match(read('README.md'), new RegExp(`Firefox ${major}\\+`));
  assert.match(read('README.md'), new RegExp(`Desktop ${major} ou superior`));
  assert.match(read('CONTRIBUTING.md'), new RegExp(`Firefox ${major} or newer`));
});
