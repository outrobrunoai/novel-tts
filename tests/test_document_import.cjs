const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'document-import.js'), 'utf8');
let unexpectedNetworkCalls = 0;
const unexpectedNetwork = () => { unexpectedNetworkCalls += 1; throw new Error('unexpected network access'); };
const sandbox = { TextDecoder, Uint8Array, DataView, ArrayBuffer, URL, console,
  setTimeout, clearTimeout,
  fetch: unexpectedNetwork, XMLHttpRequest: class { constructor() { unexpectedNetwork(); } } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.NovelDocumentImport;

function metadataZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const records = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const compressedSize = entry.compressedSize ?? 10;
    const originalSize = entry.originalSize ?? 20;
    const compression = entry.compression ?? 8;
    const flags = entry.flags || 0;
    const local = new Uint8Array(30 + name.length + compressedSize);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, compression, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, originalSize, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, compression, true);
    centralView.setUint32(20, compressedSize, true);
    centralView.setUint32(24, originalSize, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    records.push(central);
    localOffset += local.length;
  }
  const centralSize = records.reduce((sum, value) => sum + value.length, 0);
  const bytes = new Uint8Array(localOffset + centralSize + 22);
  let offset = 0;
  for (const local of locals) { bytes.set(local, offset); offset += local.length; }
  for (const record of records) { bytes.set(record, offset); offset += record.length; }
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, localOffset, true);
  return bytes;
}

test('default import limits are finite named values with room for long novels', () => {
  const limits = api.DEFAULT_IMPORT_POLICY;
  for (const value of Object.values(limits)) assert.ok(Number.isFinite(value) && value > 0);
  assert.ok(limits.extractedChars >= 10_000_000);
  assert.ok(limits.epubTotalBytes > limits.epubEntryBytes);
  assert.equal(limits.pdfPages, 20_000);
});

test('classification accepts exact limits and rejects one byte above', () => {
  const limits = api.policy({ textBytes: 4, pdfBytes: 8, epubBytes: 8, pdfSignatureOffset: 3 });
  assert.equal(api.classifyFile({ name: 'a.txt', type: 'text/plain', size: 4 }, Uint8Array.of(65), limits), 'text');
  assert.throws(() => api.classifyFile({ name: 'a.txt', type: 'text/plain', size: 5 }, Uint8Array.of(65), limits), /limite/);
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal(api.classifyFile({ name: 'a.pdf', type: 'application/pdf', size: 5 }, pdf, limits), 'pdf');
  assert.throws(() => api.classifyFile({ name: 'a.pdf', type: 'application/pdf', size: 9 }, pdf, limits), /tamanho/);
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  assert.equal(api.classifyFile({ name: 'a.epub', type: 'application/epub+zip', size: 8 }, zip, limits), 'epub');
  assert.throws(() => api.classifyFile({ name: 'a.epub', type: 'application/epub+zip', size: 9 }, zip, limits), /tamanho/);
});

test('preflight rejects oversized files before any body read', () => {
  const limits = api.policy({ pdfBytes: 4, epubBytes: 4, textBytes: 4 });
  for (const file of [
    { name: 'a.pdf', type: 'application/pdf', size: 5 },
    { name: 'a.epub', type: 'application/epub+zip', size: 5 },
    { name: 'a.html', type: 'text/html', size: 5 }
  ]) assert.throws(() => api.preflightFile(file, limits), /tamanho/);
  const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
  assert.ok(reader.indexOf('preflightFile(file') < reader.indexOf('file.arrayBuffer()'));
});

test('type checks combine extension MIME and signatures', () => {
  assert.throws(() => api.classifyFile({ name: 'fake.pdf', type: 'application/pdf', size: 4 }, Uint8Array.of(1, 2, 3, 4)), /assinatura/i);
  assert.throws(() => api.classifyFile({ name: 'fake.epub', type: 'application/epub+zip', size: 4 }, Uint8Array.of(1, 2, 3, 4)), /ZIP/);
  assert.throws(() => api.classifyFile({ name: 'bad.txt', type: 'text/plain', size: 3 }, Uint8Array.of(65, 0, 66)), /binários/);
  assert.throws(() => api.classifyFile({ name: 'image.bin', type: 'application/octet-stream', size: 1 }, Uint8Array.of(1)), /não suportado/);
});

test('UTF-8 decoding is strict and readable', () => {
  assert.equal(api.decodeUtf8(Uint8Array.from([0x6f, 0x6b])), 'ok');
  assert.throws(() => api.decodeUtf8(Uint8Array.from([0xc3, 0x28])), /UTF-8/);
});

test('EPUB paths preserve fragments and reject traversal and malformed URI', () => {
  assert.equal(api.normalizeEpubPath('chapter.xhtml#part', 'OPS', true), 'OPS/chapter.xhtml');
  assert.equal(api.normalizeEpubPath('../chapter.xhtml', 'OPS/text', true), 'OPS/chapter.xhtml');
  for (const value of ['../outside', '%2e%2e/outside', '%252e%252e/outside', '/absolute', '%2Fabsolute', 'C:/drive', 'a\\b', 'a%5Cb', 'a%255Cb', 'a\0b', 'a%00b', 'a%2500b', 'a?query=1', 'a%3Fquery=1']) {
    assert.throws(() => api.normalizeEpubPath(value), /EPUB|Query|absoluto|inseguro/);
  }
  assert.throws(() => api.normalizeEpubPath('%E0%A4%A'), /malformada/);
});

test('EPUB OPF references reject nested encoding just like ZIP names', () => {
  for (const href of ['%252e%252e/outside', 'a%255Cb', 'a%2500b', 'a%253Fquery=1']) {
    assert.throws(
      () => api.epubPackagePlan('OPS/book.opf', [{ id: 'c', href }], ['c'], []),
      /codificação URI aninhada/
    );
  }
});

test('ZIP metadata accepts a small EPUB-shaped archive', () => {
  const entries = api.zipMetadata(metadataZip([
    { name: 'META-INF/container.xml' }, { name: 'OPS/book.opf' }, { name: 'OPS/chapter.xhtml' }
  ]), api.policy({ epubEntryBytes: 100, epubTotalBytes: 300, epubCompressionRatio: 10 }));
  assert.equal(entries.length, 3);
});

test('ZIP metadata rejects a central directory with inconsistent declared size', () => {
  const bytes = metadataZip([{ name: 'a' }]);
  const view = new DataView(bytes.buffer);
  const eocd = bytes.length - 22;
  view.setUint32(eocd + 12, view.getUint32(eocd + 12, true) + 1, true);
  assert.throws(() => api.zipMetadata(bytes), /diretório ZIP inválido/i);
});

test('ZIP metadata rejects entry count, individual, total and compression limits', () => {
  assert.throws(() => api.zipMetadata(metadataZip([{ name: 'a' }, { name: 'b' }]), api.policy({ epubEntries: 1 })), /entradas demais/);
  assert.throws(() => api.zipMetadata(metadataZip([{ name: 'a', originalSize: 11 }]), api.policy({ epubEntryBytes: 10 })), /individual/);
  assert.throws(() => api.zipMetadata(metadataZip([{ name: 'a', originalSize: 6 }, { name: 'b', originalSize: 6 }]), api.policy({ epubEntryBytes: 10, epubTotalBytes: 10 })), /total/);
  assert.throws(() => api.zipMetadata(metadataZip([{ name: 'a', compressedSize: 1, originalSize: 20 }]), api.policy({ epubCompressionRatio: 10 })), /compressão insegura/);
});

test('ZIP metadata rejects encrypted and unsafe or duplicate names', () => {
  assert.throws(() => api.zipMetadata(metadataZip([{ name: 'a', flags: 1 }])), /criptografado/);
  for (const name of ['../a', '%2e%2e/a', '%252e%252e/a', '/a', 'a\\b', 'a%255Cb', 'a\0b', 'a%2500b']) {
    assert.throws(() => api.zipMetadata(metadataZip([{ name }])), /EPUB|absoluto|inseguro/);
  }
  assert.throws(() => api.zipMetadata(metadataZip([{ name: 'a/./b' }, { name: 'a/b' }])), /duplicados/);
  assert.throws(() => api.zipMetadata(metadataZip([{ name: '%61' }, { name: 'a' }])), /duplicados/);
});

test('ZIP metadata rejects local headers divergent from the central directory', () => {
  const compressionMismatch = metadataZip([{ name: 'a' }]);
  new DataView(compressionMismatch.buffer).setUint16(8, 0, true);
  assert.throws(() => api.zipMetadata(compressionMismatch), /divergentes/);

  const sizeMismatch = metadataZip([{ name: 'a' }]);
  new DataView(sizeMismatch.buffer).setUint32(22, 1, true);
  assert.throws(() => api.zipMetadata(sizeMismatch), /Tamanhos.*divergem/);

  const nameMismatch = metadataZip([{ name: 'a' }]);
  nameMismatch[30] = 'b'.charCodeAt(0);
  assert.throws(() => api.zipMetadata(nameMismatch), /divergentes/);
});

test('actual expanded EPUB sizes and ratios are revalidated after unzip', async () => {
  const { unzipSync, zipSync } = await import(pathToFileURL(path.join(root, 'vendor/fflate.mjs')).href);
  const original = zipSync({ 'chapter.xhtml': [new TextEncoder().encode('ABCD'), { level: 0 }] });
  const tampered = original.slice();
  const view = new DataView(tampered.buffer, tampered.byteOffset, tampered.byteLength);
  const eocd = tampered.length - 22;
  const central = view.getUint32(eocd + 16, true);
  const local = view.getUint32(central + 42, true);
  view.setUint32(central + 24, 1, true);
  view.setUint32(local + 22, 1, true);
  const metadata = api.zipMetadata(tampered, api.policy({ epubEntryBytes: 8, epubTotalBytes: 8, epubCompressionRatio: 8 }));
  const archive = unzipSync(tampered);
  assert.equal(archive['chapter.xhtml'].byteLength, 4);
  assert.throws(() => api.validateExpandedEpub(archive, metadata, api.policy({ epubEntryBytes: 8, epubTotalBytes: 8, epubCompressionRatio: 8 })), /Tamanho real/);

  const zeroCompressed = [{ name: 'empty', compressedSize: 0, originalSize: 0 }];
  assert.doesNotThrow(() => api.validateExpandedEpub({ empty: new Uint8Array() }, zeroCompressed, api.policy({ epubCompressionRatio: 1 })));
  assert.throws(
    () => api.validateExpandedEpub({ empty: Uint8Array.of(1, 2) }, zeroCompressed, api.policy({ epubEntryBytes: 4, epubTotalBytes: 4, epubCompressionRatio: 1 })),
    /Tamanho real/
  );

  const metadataForLimits = [
    { name: 'a', compressedSize: 1, originalSize: 3 },
    { name: 'b', compressedSize: 1, originalSize: 3 }
  ];
  assert.throws(
    () => api.validateExpandedEpub({ a: new Uint8Array(3) }, metadataForLimits, api.policy({ epubEntryBytes: 2 })),
    /limite individual após/
  );
  assert.throws(
    () => api.validateExpandedEpub({ a: new Uint8Array(3), b: new Uint8Array(3) }, metadataForLimits, api.policy({ epubEntryBytes: 3, epubTotalBytes: 5 })),
    /limite real descompactado total/
  );
  assert.throws(
    () => api.validateExpandedEpub({ a: new Uint8Array(3) }, metadataForLimits, api.policy({ epubEntryBytes: 3, epubTotalBytes: 3, epubCompressionRatio: 2 })),
    /compressão real insegura/
  );
});

test('fflate filter runs before expansion and CRC is not claimed as validated', async () => {
  const fflateSource = fs.readFileSync(path.join(root, 'vendor/fflate.mjs'), 'utf8');
  const unzipBody = fflateSource.slice(fflateSource.indexOf('export function unzipSync'));
  assert.ok(unzipBody.indexOf('fltr({') < unzipBody.indexOf('inflateSync('));

  const { unzipSync, zipSync } = await import(pathToFileURL(path.join(root, 'vendor/fflate.mjs')).href);
  const bytes = zipSync({ 'chapter.xhtml': new TextEncoder().encode('safe') });
  const badCrc = bytes.slice();
  const view = new DataView(badCrc.buffer, badCrc.byteOffset, badCrc.byteLength);
  const eocd = badCrc.length - 22;
  const central = view.getUint32(eocd + 16, true);
  view.setUint32(central + 16, 0, true);
  view.setUint32(14, 0, true);
  assert.equal(new TextDecoder().decode(unzipSync(badCrc)['chapter.xhtml']), 'safe');
});

test('text budget rejects excessive text and sections without large fixtures', () => {
  const budget = api.textBudget(api.policy({ extractedChars: 5, sections: 2 }));
  budget.addText('12345'); budget.addSection(); budget.addSection();
  assert.throws(() => budget.addText('6'), /Texto extraído/);
  assert.throws(() => budget.addSection(), /seções demais/);
});

test('HTML and EPUB text extraction has an explicit item budget', () => {
  const fakeDocument = {
    querySelectorAll() {
      return [{ tagName: 'P', textContent: 'a' }, { tagName: 'P', textContent: 'b' }];
    }
  };
  assert.throws(
    () => api.textBlocksFromDocument(fakeDocument, api.policy({ textItems: 1 })),
    /elementos textuais demais/
  );
});

test('EPUB package planning enforces manifest, spine, missing items and safe references', () => {
  const files = ['OPS/chapter.xhtml'];
  assert.deepEqual(
    Array.from(api.epubPackagePlan('OPS/book.opf', [{ id: 'c', href: 'chapter.xhtml#start' }], ['c'], files)),
    files
  );
  assert.throws(() => api.epubPackagePlan('OPS/book.opf', [], ['missing'], files), /spine ausente/);
  assert.throws(() => api.epubPackagePlan('OPS/book.opf', [{ id: 'c', href: '../../outside' }], ['c'], files), /raiz/);
  assert.throws(() => api.epubPackagePlan('OPS/book.opf', [{ id: 'c', href: 'x' }, { id: 'd', href: 'y' }], [], [], api.policy({ sections: 1 })), /excessivo/);
});

function epubParsers({ malformedOpf = false } = {}) {
  return {
    xml(text) {
      if (text === 'container') return { querySelector() { return { getAttribute() { return 'OPS/book.opf'; } }; } };
      if (malformedOpf) throw new Error('XML inválido no EPUB');
      return {
        querySelectorAll(selector) {
          if (selector === 'manifest item') return [{ getAttribute(name) { return name === 'id' ? 'c1' : 'chapter.xhtml'; } }];
          if (selector === 'spine itemref') return [{ getAttribute() { return 'c1'; } }];
          return [];
        }
      };
    },
    html() {
      return { querySelectorAll(selector) {
        assert.equal(selector, 'h1,h2,h3,p,blockquote,li');
        return [{ tagName: 'P', textContent: 'Safe chapter' }];
      } };
    }
  };
}

test('minimal EPUB package produces only safe text blocks', () => {
  const encode = (value) => new TextEncoder().encode(value);
  const archive = {
    mimetype: encode('application/epub+zip'),
    'META-INF/container.xml': encode('container'),
    'OPS/book.opf': encode('opf'),
    'OPS/chapter.xhtml': encode('<p>Safe chapter</p>')
  };
  const parsers = epubParsers();
  assert.deepEqual(JSON.parse(JSON.stringify(api.epubBlocks(archive, parsers.xml, parsers.html))), [{ tag: 'p', text: 'Safe chapter' }]);
});

test('EPUB package rejects missing container, malformed OPF, missing spine and encryption', () => {
  const encode = (value) => new TextEncoder().encode(value);
  const parsers = epubParsers();
  assert.throws(() => api.epubBlocks({}, parsers.xml, parsers.html), /container/);
  assert.throws(() => api.epubBlocks({ 'META-INF/container.xml': encode('container') }, parsers.xml, parsers.html), /mimetype/);
  const base = { mimetype: encode('application/epub+zip'), 'META-INF/container.xml': encode('container'), 'OPS/book.opf': encode('opf') };
  assert.throws(() => api.epubBlocks(base, epubParsers({ malformedOpf: true }).xml, parsers.html), /XML inválido/);
  assert.throws(() => api.epubBlocks(base, parsers.xml, parsers.html), /spine ausente/);
  assert.throws(() => api.epubBlocks({ ...base, 'META-INF/encryption.xml': encode('encrypted') }, parsers.xml, parsers.html), /criptografado/);
});

test('EPUB extracted text and spine counts use injected small limits', () => {
  const encode = (value) => new TextEncoder().encode(value);
  const archive = { mimetype: encode('application/epub+zip'), 'META-INF/container.xml': encode('container'), 'OPS/book.opf': encode('opf'), 'OPS/chapter.xhtml': encode('html') };
  const parsers = epubParsers();
  assert.throws(() => api.epubBlocks(archive, parsers.xml, parsers.html, api.policy({ extractedChars: 4 })), /Texto extraído/);
  assert.throws(() => api.epubBlocks(archive, parsers.xml, parsers.html, api.policy({ sections: 0 })), /excessivo/);
});

function pdfMock({ pages = [[{ str: 'hello' }]], failPage = 0, textError = null, cleanupError = null,
  onTextContent = null, onGetPage = null } = {}) {
  const state = { destroyed: 0, cleaned: 0, options: null };
  const document = {
    numPages: pages.length,
    async getPage(number) {
      if (number === failPage) throw new Error('mock page failure');
      if (onGetPage) await onGetPage(number);
      return {
        async getTextContent() {
          if (textError) throw textError;
          return onTextContent ? onTextContent(number) : { items: pages[number - 1] };
        },
        getViewport() { return { width: 500 }; },
        cleanup() { state.cleaned += 1; if (cleanupError) throw cleanupError; }
      };
    },
    async destroy() { state.destroyed += 1; }
  };
  return { state, pdfjs: { getDocument(options) { state.options = options; return { promise: Promise.resolve(document) }; } } };
}

test('PDF extraction accepts local bytes and destroys documents on success and failure', async () => {
  const good = pdfMock(); const bytes = Uint8Array.of(1, 2, 3);
  const pages = await api.readPdfPages(good.pdfjs, bytes, api.policy({ pdfPages: 2, pdfItemsPerPage: 2, pdfItemsTotal: 2, pdfCharsPerPage: 10, extractedChars: 10, sections: 2 }));
  assert.equal(pages.length, 1); assert.equal(good.state.destroyed, 1); assert.equal(good.state.cleaned, 1);
  assert.equal(good.state.options.data, bytes); assert.equal('url' in good.state.options, false);
  assert.equal(good.state.options.disableAutoFetch, true); assert.equal(good.state.options.disableStream, true);
  assert.equal(unexpectedNetworkCalls, 0);
  const bad = pdfMock({ pages: [[{ str: 'ok' }], [{ str: 'no' }]], failPage: 2 });
  await assert.rejects(api.readPdfPages(bad.pdfjs, bytes, api.policy({ pdfPages: 2 })), /mock page failure/);
  assert.equal(bad.state.destroyed, 1);
});

test('PDF extraction rejects page, item and text budgets with small mocks', async () => {
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[], []] }).pdfjs, Uint8Array.of(1), api.policy({ pdfPages: 1 })), /2 páginas; limite configurado: 1/);
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[{ str: 'a' }, { str: 'b' }]] }).pdfjs, Uint8Array.of(1), api.policy({ pdfItemsPerPage: 1 })), /itens demais/);
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[{ str: 'long' }]] }).pdfjs, Uint8Array.of(1), api.policy({ pdfCharsPerPage: 3 })), /texto demais/);
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[{ str: 'abc' }], [{ str: 'def' }]] }).pdfjs, Uint8Array.of(1), api.policy({ pdfCharsPerPage: 4, extractedChars: 5 })), /Texto extraído/);
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[{ str: 'a' }], [{ str: 'b' }]] }).pdfjs, Uint8Array.of(1), api.policy({ pdfItemsPerPage: 2, pdfItemsTotal: 1 })), /itens de texto demais/);
});

test('PDF characterization accepts exactly 5000 pages and rejects the next page', async () => {
  const exact = pdfMock({ pages: Array.from({ length: 5000 }, () => []) });
  const visited = [];
  const result = await api.readPdfPages(exact.pdfjs, Uint8Array.of(1), api.policy({ pdfPages: 5000 }),
    (page, total) => { if (page === 1 || page === total) visited.push([page, total]); },
    () => [], {yieldControl: async () => {}});
  assert.deepEqual(visited, [[1, 5000], [5000, 5000]]);
  assert.deepEqual(Array.from(result), []);
  assert.equal(exact.state.cleaned, 5000);
  assert.equal(exact.state.destroyed, 1);

  const over = pdfMock({ pages: Array.from({ length: 5001 }, () => []) });
  await assert.rejects(api.readPdfPages(over.pdfjs, Uint8Array.of(1), api.policy({ pdfPages: 5000 })),
    /5001 páginas; limite configurado: 5000/);
  assert.equal(over.state.cleaned, 0);
  assert.equal(over.state.destroyed, 1);
});

test('PDF characterization preserves page text order and independent byte, item and character budgets', async () => {
  const pages = pdfMock({ pages: [[{ str: 'page one' }], [{ str: 'page two' }, { str: 'continued' }]] });
  const blocks = await api.readPdfPages(pages.pdfjs, Uint8Array.of(1),
    api.policy({ pdfPages: 2, pdfItemsPerPage: 2, pdfItemsTotal: 3, pdfCharsPerPage: 20, extractedChars: 30 }),
    () => {}, ({ items }) => items.map(item => item.str));
  assert.deepEqual(Array.from(blocks), ['page one', 'page two', 'continued']);

  assert.throws(() => api.preflightFile({ name: 'book.pdf', type: 'application/pdf', size: 9 },
    api.policy({ pdfBytes: 8 })), /tamanho/);
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[{ str: 'a' }, { str: 'b' }]] }).pdfjs,
    Uint8Array.of(1), api.policy({ pdfItemsTotal: 1 })), /itens de texto demais/);
  await assert.rejects(api.readPdfPages(pdfMock({ pages: [[{ str: 'abcd' }]] }).pdfjs,
    Uint8Array.of(1), api.policy({ pdfCharsPerPage: 3 })), /texto demais/);
});

test('PDF default page budget accepts exactly 20000 and reports the count and limit above it', async () => {
  const exact = pdfMock({ pages: Array.from({ length: 20_000 }, () => []) });
  const progress = [];
  let yields = 0;
  const result = await api.readPdfPages(exact.pdfjs, Uint8Array.of(1), undefined,
    (page, total) => { if (page === 1 || page === total) progress.push([page, total]); },
    () => [], {yieldControl: async () => { yields += 1; }});
  assert.equal(result.length, 0);
  assert.deepEqual(progress, [[1, 20_000], [20_000, 20_000]]);
  assert.equal(exact.state.cleaned, 20_000);
  assert.equal(exact.state.destroyed, 1);
  assert.equal(yields, Math.floor(20_000 / 16));

  const over = pdfMock({ pages: Array.from({ length: 20_001 }, () => []) });
  await assert.rejects(api.readPdfPages(over.pdfjs, Uint8Array.of(1)),
    /PDF contém 20001 páginas; limite configurado: 20000/);
  assert.equal(over.state.cleaned, 0);
  assert.equal(over.state.destroyed, 1);
});

test('PDF cancellation during extraction releases the active page and loading task', async () => {
  const controller = new AbortController();
  let consumed = 0;
  const mock = pdfMock({ pages: [[{str: 'must not escape'}]], onTextContent() {
    controller.abort();
    return {items: [{str: 'must not escape'}]};
  }});
  await assert.rejects(api.readPdfPages(mock.pdfjs, Uint8Array.of(1), undefined, () => {}, () => {
    consumed += 1;
    return [];
  }, {signal: controller.signal, yieldControl: async () => {}}), {name: 'AbortError'});
  assert.equal(consumed, 0);
  assert.equal(mock.state.cleaned, 1, 'page cleanup runs when cancellation interrupts text extraction');
  assert.equal(mock.state.destroyed, 1);
});

test('PDF page cleanup does not mask the original extraction failure', async () => {
  const mock = pdfMock({ textError: new Error('primary extraction error'), cleanupError: new Error('cleanup error') });
  await assert.rejects(api.readPdfPages(mock.pdfjs, Uint8Array.of(1)), /primary extraction error/);
  assert.equal(mock.state.cleaned, 1);
  assert.equal(mock.state.destroyed, 1);
});

test('PDF loading-task cleanup runs when proxy lacks destroy and does not mask parse failure', async () => {
  const state = { destroyed: 0 };
  const pdfjs = {
    getDocument() {
      return {
        promise: Promise.resolve({ numPages: 1, async getPage() { throw new Error('primary page error'); } }),
        async destroy() { state.destroyed += 1; throw new Error('cleanup error'); }
      };
    }
  };
  await assert.rejects(api.readPdfPages(pdfjs, Uint8Array.of(1)), /primary page error/);
  assert.equal(state.destroyed, 1);
});

test('PDF rejects a page before its content reaches the consumer', async () => {
  let consumed = 0;
  await assert.rejects(
    api.readPdfPages(
      pdfMock({ pages: [[{ str: 'too long' }]] }).pdfjs,
      Uint8Array.of(1),
      api.policy({ pdfCharsPerPage: 2 }),
      () => {},
      () => { consumed += 1; return []; }
    ),
    /texto demais/
  );
  assert.equal(consumed, 0);
});

test('reader parses before persistence, uses local PDF bytes and always destroys PDF', () => {
  const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
  assert.ok(reader.indexOf('parsed = await parseFile(file)') < reader.indexOf('store.saveFile(file, parsed.data)'));
  const store = fs.readFileSync(path.join(root, 'document-store.js'), 'utf8');
  assert.match(store, /const data = parsedData \|\| await file\.arrayBuffer\(\)/);
  assert.match(source, /data: bytes/);
  assert.match(source, /finally \{[\s\S]*destroy/);
  assert.doesNotMatch(source, /getDocument\(\{\s*url:/);
  assert.doesNotMatch(reader, /\bfetch\s*\(|XMLHttpRequest/);
});

function readerHarness({ pdfjsLib: injectedPdfjs = null, runtimeGetURL = null } = {}) {
  class Element {
    constructor(tagName = 'div', state = null) {
      this.state = state;
      this.tagName = tagName.toUpperCase(); this.children = []; this.dataset = {};
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        contains: (name) => this.classes.has(name)
      }; this.hidden = false; this.textContent = '';
      this.listeners = new Map(); this.files = []; this._value = '';
    }
    set value(value) { this._value = value; if (value === '') this.files = []; }
    get value() { return this._value; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener({ preventDefault() {}, ...event });
    }
    appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
    append(...nodes) {
      for (const node of nodes) { node.parentElement = this; this.children.push(node); }
    }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    querySelectorAll(selector) { return selector === 'p' ? this.children.filter((node) => node.tagName === 'P') : []; }
    contains(node) { return this.children.includes(node); }
    closest() { return null; }
    scrollIntoView() {}
  }
  const state = { saves: 0, failSave: false, record: null, stages: [], errors: [], renderYields: 0 };
  const elements = Object.fromEntries([
    '#file', '#drop-zone', '#status', '#cancel-import', '#reader-content', '#document-actions', '#auto-trim',
    '#choose-start', '#undo-trim', '#saved-section', '#saved-documents', '#reader-module'
  ].map((name) => [name, new Element()]));
  elements['#reader-content'].tagName = 'ARTICLE';
  elements['#reader-module'].id = 'reader-module';
  const body = new Element('body', state);
  const document = {
    body, documentElement: new Element('html'), title: '',
    listeners: new Map(),
    querySelector(selector) { return elements[selector]; },
    querySelectorAll(selector) {
      return selector === 'article' ? [elements['#reader-content']] : [];
    },
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener({ preventDefault() {}, ...event });
    },
    createElement(tag) { return new Element(tag, state); }
  };
  const store = {
    async saveFile(file, data) {
      state.saves += 1;
      if (state.failSave) throw new Error('quota');
      state.record = {
        id: 'saved-id', data, name: file.name, type: file.type,
        lastModified: file.lastModified, size: file.size, updatedAt: 1
      };
      return { id: 'saved-id' };
    },
    async listDocuments() { return []; }, async getDocument() { return state.record; }, async deleteDocument() {}
  };
  class FakeFile {
    constructor(parts, name, options = {}) {
      this.data = parts[0]; this.name = name; this.type = options.type || ''; this.lastModified = options.lastModified || 0;
      this.size = this.data.byteLength; this.arrayReads = 0;
    }
    async arrayBuffer() { this.arrayReads += 1; return this.data.slice(0); }
  }
  const pdfjsLib = injectedPdfjs || {
    GlobalWorkerOptions: {},
    getDocument(options) {
      const pdf = state.pdfMock;
      if (!pdf) throw new Error('PDF mock not configured');
      return pdf.getDocument(options);
    }
  };
  const context = {
    NovelDocumentStore: store, NovelDocumentImport: api, TextDecoder, Uint8Array, ArrayBuffer,
    URL, location: { href: 'moz-extension://test/reader.html' }, history: { replaceState() {} },
    document, window: {
      listeners: new Map(),
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      },
      dispatchEvent(event) {
        if (event.type === 'nlr-reader-stage') state.stages.push(event.detail.stage);
        for (const listener of this.listeners.get(event.type) || []) listener(event);
      }
    }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    File: FakeFile, DOMParser: class {}, AbortController, confirm: () => false,
    setTimeout(callback, delay) { state.renderYields += 1; return globalThis.setTimeout(callback, delay); },
    clearTimeout,
    browser: {
      i18n: { getUILanguage: () => 'pt-BR' },
      runtime: { getURL: runtimeGetURL || ((name) => `moz-extension://test/${name}`) },
      storage: { local: { async get() { return {}; }, async set() {} } }
    },
    console: {
      error(...args) { state.errors.push(args.map((value) => value?.message || String(value)).join(' ')); },
      warn(...args) { state.errors.push(args.map((value) => value?.message || String(value)).join(' ')); }
    }, pdfjsLib, unzipSync() {}
  };
  context.globalThis = context;
  const vmContext = vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'settings-schema.js'), 'utf8'), vmContext);
  vm.runInContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf8'), vmContext);
  vm.runInContext(fs.readFileSync(path.join(root, 'reader-bootstrap.js'), 'utf8'), vmContext);
  let readerSource = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
  readerSource = readerSource.replace(/^import .*$/gm, '');
  vm.runInContext(readerSource, vmContext);
  return { context: vmContext, elements, state, body, FakeFile, document };
}

function minimalPdf() {
  const stream = "BT /F1 12 Tf 20 200 Td (Smoke PDF paragraph.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function multiPagePdf(pageCount) {
  const kids = Array.from({length: pageCount}, (_, index) => `${4 + index * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  for (let index = 0; index < pageCount; index += 1) {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const label = `PAGE_${String(index + 1).padStart(5, '0')}`;
    const stream = `BT /F1 12 Tf 20 200 Td (${label}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function realPdfJs() {
  globalThis.DOMMatrix ||= class DOMMatrix {};
  const pdfjs = await import(pathToFileURL(path.join(root, 'vendor/pdf.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(root, 'vendor/pdf.worker.mjs')).href;
  const state = { destroyed: 0 };
  const pdfjsLib = {
    GlobalWorkerOptions: pdfjs.GlobalWorkerOptions,
    getDocument(options) {
      const loadingTask = pdfjs.getDocument(options);
      const destroy = loadingTask.destroy.bind(loadingTask);
      loadingTask.destroy = async () => {
        state.destroyed += 1;
        return destroy();
      };
      return loadingTask;
    }
  };
  return {
    pdfjs,
    pdfjsLib,
    state,
    runtimeGetURL: (name) => name === 'vendor/pdf.worker.mjs'
      ? pathToFileURL(path.join(root, 'vendor/pdf.worker.mjs')).href
      : `moz-extension://test/${name}`
  };
}

async function settleReader() {
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('reader integration parses every path before saving and keeps safe temporary reading', async () => {
  const { context, elements, state, body, FakeFile } = readerHarness();
  const invalid = [
    new FakeFile([Uint8Array.of(1, 2, 3, 4).buffer], 'bad.pdf', { type: 'application/pdf' }),
    new FakeFile([Uint8Array.of(1, 2, 3, 4).buffer], 'bad.epub', { type: 'application/epub+zip' }),
    new FakeFile([Uint8Array.of(65, 0, 66).buffer], 'bad.html', { type: 'text/html' }),
    new FakeFile([Uint8Array.of(65, 0, 66).buffer], 'bad.txt', { type: 'text/plain' })
  ];
  for (const file of invalid) await context.importFile(file);
  assert.equal(state.saves, 0);
  assert.equal(elements['#reader-content'].children.length, 0);
  assert.equal(body.dataset.nlrDocumentReady, undefined);
  assert.equal(body.dataset.nlrDocumentId, undefined);

  for (const name of ['large.txt', 'large.html']) {
    const oversized = new FakeFile([Uint8Array.of(65).buffer], name, { type: name.endsWith('html') ? 'text/html' : 'text/plain' });
    oversized.size = api.DEFAULT_IMPORT_POLICY.textBytes + 1;
    await context.importFile(oversized);
    assert.equal(oversized.arrayReads, 0);
  }
  assert.equal(state.saves, 0);

  const valid = new FakeFile([new TextEncoder().encode('Valid text').buffer], 'valid.txt', { type: 'text/plain' });
  await context.importFile(valid);
  assert.equal(state.saves, 1, `${elements['#status'].textContent}; ${state.errors.join('; ')}`);
  assert.equal(body.dataset.nlrDocumentReady, 'true');
  assert.equal(body.dataset.nlrDocumentId, 'saved-id');

  state.failSave = true;
  await context.importFile(valid);
  assert.equal(state.saves, 2);
  assert.equal(body.dataset.nlrDocumentReady, 'true');
  assert.equal(body.dataset.nlrDocumentId, '');
  assert.equal(elements['#reader-content'].children[0].textContent, 'Valid text');

  state.record = { data: Uint8Array.of(65, 0, 66).buffer, name: 'old.txt', type: 'text/plain', lastModified: 0 };
  await context.openSavedDocument('old-id');
  assert.equal(state.saves, 2);
  assert.equal(body.dataset.nlrDocumentReady, undefined);
  assert.equal(body.dataset.nlrDocumentId, undefined);
  assert.equal(elements['#reader-content'].children.length, 0);
});

test('reader loads the import guard before its module', () => {
  const html = fs.readFileSync(path.join(root, 'reader.html'), 'utf8');
  assert.ok(fs.existsSync(path.join(root, 'document-import.js')));
  assert.ok(html.indexOf('document-store.js') < html.indexOf('document-import.js'));
  assert.ok(html.indexOf('document-import.js') < html.indexOf('reader.js'));
  assert.ok(html.indexOf('reader-bootstrap.js') < html.indexOf('reader.js'));
  assert.ok(html.indexOf('settings-schema.js') < html.indexOf('i18n.js'));
  assert.ok(html.indexOf('i18n.js') < html.indexOf('reader.js'));
  assert.match(html, /id="reader-module" type="module" src="reader\.js"/);
  assert.equal(api, sandbox.globalThis.NovelDocumentImport);
});

test('local reader paragraphs keep their DOM identity through progress highlighting', async () => {
  const { pdfjsLib, runtimeGetURL } = await realPdfJs();
  const { context, elements, FakeFile, document } = readerHarness({ pdfjsLib, runtimeGetURL });
  const file = new FakeFile([multiPagePdf(2).buffer], 'local-document.pdf', { type: 'application/pdf' });
  await context.importFile(file);

  const readerContentSource = fs.readFileSync(path.join(root, 'content-document.js'), 'utf8');
  const progressSource = fs.readFileSync(path.join(root, 'content-progress.js'), 'utf8');
  vm.runInContext(readerContentSource, context);
  vm.runInContext(progressSource, context);

  const rendered = elements['#reader-content'].children;
  assert.equal(rendered.length, 2);
  const snapshot = context.NovelLocalReader.contentDocument.createPageSnapshot({
    document,
    contentSelector: '#reader-content'
  });
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].element, rendered[0]);
  assert.equal(snapshot.entries[1].element, rendered[1]);
  assert.deepEqual(Array.from(snapshot.entries, (entry) => entry.text), ['PAGE_00001', 'PAGE_00002']);

  const progress = context.NovelLocalReader.contentProgress.create({
    storage: { async get() { return {}; }, async set() {} },
    callbacks: {
      onClearHighlight: (entry) => entry?.element?.classList.remove('nlr-reading-paragraph'),
      onApplyHighlight: (entry) => entry?.element?.classList.add('nlr-reading-paragraph')
    }
  });
  const sessionToken = Object.freeze({ id: 'local-reader-session' });
  progress.setDocument(snapshot, { pageKey: 'local-document:saved-id' }, sessionToken);

  assert.equal(progress.activate(0, sessionToken), true);
  assert.equal(rendered[0].classList.contains('nlr-reading-paragraph'), true);
  assert.equal(rendered[1].classList.contains('nlr-reading-paragraph'), false);
  assert.equal(progress.activate(1, sessionToken), true);
  assert.equal(rendered[0].classList.contains('nlr-reading-paragraph'), false);
  assert.equal(rendered[1].classList.contains('nlr-reading-paragraph'), true);
  progress.dispose();
});

test('local reader links the paragraph highlight stylesheet', () => {
  const html = fs.readFileSync(path.join(root, 'reader.html'), 'utf8');
  assert.match(html, /<link\s+rel="stylesheet"\s+href="page-overlay\.css"\s*\/?\s*>/);
  const overlay = fs.readFileSync(path.join(root, 'page-overlay.css'), 'utf8');
  assert.match(overlay, /\.nlr-reading-paragraph\s*\{/);
});

test('reader bootstrap reports module load failure without file data', () => {
  const { elements } = readerHarness();
  elements['#reader-module'].dispatch('error');
  assert.equal(elements['#status'].textContent, 'Falha no bootstrap: reader-module-load');
  assert.doesNotMatch(elements['#status'].textContent, /\.pdf|moz-extension|\/home\//);
});

test('file input change imports and displays TXT, including same-file retry after failure', async () => {
  const { context, elements, state, body, FakeFile } = readerHarness();
  const fileInput = elements['#file'];
  const valid = new FakeFile([new TextEncoder().encode('Selector TXT').buffer], 'private-name.txt', { type: 'text/plain' });
  fileInput.files = [valid];
  fileInput.dispatch('change');
  assert.deepEqual(fileInput.files, [], 'input is cleared synchronously to enable selecting the same file again');
  await settleReader();
  assert.equal(valid.arrayReads, 1);
  assert.equal(state.saves, 1);
  assert.equal(elements['#reader-content'].children[0].textContent, 'Selector TXT');
  assert.equal(body.dataset.nlrDocumentReady, 'true');

  const invalid = new FakeFile([Uint8Array.of(1, 2, 3, 4).buffer], 'private-name.pdf', { type: 'application/pdf' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    fileInput.files = [invalid];
    fileInput.dispatch('change');
    await settleReader();
    assert.equal(elements['#status'].textContent, 'Não consegui abrir o arquivo: Assinatura PDF inválida');
    assert.equal(body.dataset.nlrDocumentReady, undefined);
  }
  assert.equal(invalid.arrayReads, 2);
  assert.equal(state.saves, 1, 'invalid file is never persisted');
});

test('reader file selection reaches PDF extraction and keeps temporary reading on store failure', async () => {
  const { context, elements, state, body, FakeFile } = readerHarness();
  const mock = pdfMock({ pages: [[{ str: 'A synthetic valid PDF paragraph.', transform: [1, 0, 0, 12, 10, 20], width: 180 }]] });
  state.pdfMock = mock.pdfjs;
  state.failSave = true;
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const file = new FakeFile([bytes.buffer], 'private-name.pdf', { type: 'application/pdf' });
  elements['#file'].files = [file];
  elements['#file'].dispatch('change');
  await settleReader();
  assert.equal(file.arrayReads, 1);
  assert.equal(state.saves, 1);
  assert.equal(elements['#reader-content'].children[0].textContent, 'A synthetic valid PDF paragraph.');
  assert.equal(body.dataset.nlrDocumentReady, 'true');
  assert.equal(body.dataset.nlrDocumentId, '');
  assert.equal(elements['#status'].textContent, 'Arquivo aberto temporariamente; não foi salvo na biblioteca local.');
  assert.ok(state.stages.includes('extractingPdf'));

  context.document.dispatch('drop', { dataTransfer: { files: [file] } });
  await settleReader();
  assert.equal(file.arrayReads, 2);
  assert.equal(state.saves, 2);
  assert.equal(mock.state.cleaned, 2);
  assert.equal(mock.state.destroyed, 2);
  assert.equal(elements['#reader-content'].children[0].textContent, 'A synthetic valid PDF paragraph.');
});

test('reader cancels pending PDF page loading and does not save or show partial content', async () => {
  const { context, elements, state, body, FakeFile } = readerHarness();
  const inputBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const slowFile = new FakeFile([inputBytes.buffer], 'private.pdf', {type: 'application/pdf'});
  slowFile.arrayBuffer = () => new Promise(() => {});
  const waitingForBytes = context.importFile(slowFile);
  assert.equal(elements['#cancel-import'].hidden, false);
  elements['#cancel-import'].dispatch('click');
  await waitingForBytes;
  assert.equal(elements['#status'].textContent, 'Importação cancelada.');
  assert.equal(state.saves, 0);

  let pageRequested;
  const requested = new Promise(resolve => { pageRequested = resolve; });
  const mock = pdfMock({ pages: [[{str: 'private PDF text'}]], onGetPage: async () => {
    pageRequested();
    await new Promise(() => {});
  }});
  state.pdfMock = mock.pdfjs;
  const file = new FakeFile([inputBytes.buffer], 'private.pdf', {type: 'application/pdf'});
  const pending = context.importFile(file);
  await requested;
  assert.equal(elements['#cancel-import'].hidden, false);
  assert.equal(elements['#status'].textContent, 'Extraindo PDF · página 1/1…');
  elements['#cancel-import'].dispatch('click');
  await pending;
  assert.equal(elements['#status'].textContent, 'Importação cancelada.');
  assert.equal(elements['#cancel-import'].hidden, true);
  assert.equal(mock.state.cleaned, 0, 'no page proxy was returned by the still-pending page request');
  assert.equal(mock.state.destroyed, 1);
  assert.equal(state.saves, 0);
  assert.equal(elements['#reader-content'].children.length, 0);
  assert.equal(body.dataset.nlrDocumentReady, undefined);

  state.pdfMock = pdfMock({pages: [[{
    str: 'Retry after cancellation.', transform: [1, 0, 0, 12, 10, 20], width: 180
  }]]}).pdfjs;
  await context.importFile(file);
  assert.equal(state.saves, 1, 'a fresh attempt succeeds after cancellation cleanup');
  assert.equal(body.dataset.nlrDocumentReady, 'true');
  assert.equal(elements['#reader-content'].children[0].textContent, 'Retry after cancellation.');
});

test('PDF with no extractable text explicitly reports that OCR is unavailable', async () => {
  const { context, elements, state, FakeFile } = readerHarness();
  state.pdfMock = pdfMock({pages: [[]]}).pdfjs;
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const file = new FakeFile([bytes.buffer], 'no-text.pdf', {type: 'application/pdf'});
  await context.importFile(file);
  assert.match(elements['#status'].textContent, /sem texto extraível; OCR não está disponível/);
  assert.equal(state.saves, 0);
  assert.equal(elements['#reader-content'].children.length, 0);
});

test('reader renders long block lists in bounded UI batches and preserves order', async () => {
  const { context, elements, state } = readerHarness();
  const blocks = Array.from({length: 751}, (_, index) => ({tag: 'p', text: `Block ${index}`}));
  await context.appendBlocks(blocks);
  const rendered = elements['#reader-content'].children;
  assert.equal(rendered.length, 751);
  assert.equal(rendered[0].textContent, 'Block 0');
  assert.equal(rendered[750].textContent, 'Block 750');
  assert.deepEqual(blocks, []);
  assert.equal(state.renderYields, 3);
});

test('real PDF.js modules import and reader input extracts a valid PDF through the packaged worker', async () => {
  const { pdfjs, pdfjsLib, state: pdfState, runtimeGetURL } = await realPdfJs();
  assert.equal(pdfjs.version, '6.2.108');
  const { context, elements, state, body, FakeFile } = readerHarness({ pdfjsLib, runtimeGetURL });
  const data = minimalPdf();
  const file = new FakeFile([data.buffer], 'synthetic.pdf', { type: 'application/pdf' });
  elements['#file'].files = [file];
  elements['#file'].dispatch('change');
  await settleReader();
  assert.equal(file.arrayReads, 1);
  assert.equal(state.saves, 1, `${elements['#status'].textContent}; ${state.errors.join('; ')}`);
  assert.equal(elements['#reader-content'].children[0].textContent, 'Smoke PDF paragraph.');
  assert.equal(body.dataset.nlrDocumentReady, 'true');
  assert.equal(pdfState.destroyed, 1, 'the real PDF loading task is destroyed after extraction');

  context.document.dispatch('drop', { dataTransfer: { files: [file] } });
  await settleReader();
  assert.equal(file.arrayReads, 2);
  assert.equal(state.saves, 2);
  assert.equal(pdfState.destroyed, 2, 'drag-and-drop also cleans up the real PDF loading task');
  await context.openSavedDocument('saved-id');
  assert.equal(state.saves, 2, 'opening a library record does not re-save it');
  assert.equal(pdfState.destroyed, 3, 'opening the saved PDF uses the same real cleanup path');
  assert.equal(body.dataset.nlrDocumentId, 'saved-id');
  assert.equal(elements['#reader-content'].children[0].textContent, 'Smoke PDF paragraph.');
});

test('synthetic 5001-page PDF imports, renders in order, and reopens from the library', async (t) => {
  const {pdfjsLib, state: pdfState, runtimeGetURL} = await realPdfJs();
  const {context, elements, state, body, FakeFile} = readerHarness({pdfjsLib, runtimeGetURL});
  const data = multiPagePdf(5001);
  const file = new FakeFile([data.buffer], 'synthetic-long-novel.pdf', {type: 'application/pdf'});
  const started = performance.now();
  const rssBefore = process.memoryUsage().rss;
  await context.importFile(file);
  const elapsedMs = performance.now() - started;
  const rssAfter = process.memoryUsage().rss;
  const peakRssMb = process.resourceUsage().maxRSS / 1024;
  const contentNodes = elements['#reader-content'].children;
  assert.equal(state.saves, 1, `${elements['#status'].textContent}; ${state.errors.join('; ')}`);
  assert.equal(body.dataset.nlrDocumentReady, 'true');
  assert.equal(contentNodes.length, 5001);
  assert.equal(contentNodes[0].textContent, 'PAGE_00001');
  assert.equal(contentNodes[2500].textContent, 'PAGE_02501');
  assert.equal(contentNodes[5000].textContent, 'PAGE_05001');
  assert.ok(state.renderYields >= Math.floor(5001 / 16), 'page extraction yielded regularly so progress can paint');
  assert.ok(state.renderYields >= Math.floor((5001 - 1) / 250), 'DOM construction yielded between bounded batches');
  assert.equal(pdfState.destroyed, 1);

  await context.openSavedDocument('saved-id');
  const reopened = elements['#reader-content'].children;
  assert.equal(state.saves, 1, 'opening from the library does not rewrite the file');
  assert.equal(reopened.length, 5001);
  assert.deepEqual([reopened[0].textContent, reopened[2500].textContent, reopened[5000].textContent],
    ['PAGE_00001', 'PAGE_02501', 'PAGE_05001']);
  assert.equal(pdfState.destroyed, 2);
  t.diagnostic(`synthetic PDF pages=5001 bytes=${data.byteLength} first-import-ms=${elapsedMs.toFixed(1)} ` +
    `rss-delta-mib=${((rssAfter - rssBefore) / (1024 ** 2)).toFixed(1)} process-peak-rss-mib=${peakRssMb.toFixed(1)}`);
});

test('HTML path selects text elements and renders only through textContent', () => {
  const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
  assert.match(source, /querySelectorAll\("h1,h2,h3,p,blockquote,li"\)/);
  assert.match(reader, /new DOMParser\(\)\.parseFromString\(html, "text\/html"\)\.body/);
  assert.doesNotMatch(reader, /template\.innerHTML/);
  assert.match(reader, /node\.textContent = clean/);
  assert.doesNotMatch(reader, /content\.innerHTML|insertAdjacentHTML/);
});

test('HTML extraction ignores scripts, event attributes, iframes and external resources', () => {
  let selector;
  const fakeDocument = {
    querySelectorAll(value) {
      selector = value;
      return [{ tagName: 'P', textContent: 'Fish & Chips <literal>', onclick: 'evil()', src: 'https://invalid.example' }];
    }
  };
  const blocks = api.textBlocksFromDocument(fakeDocument, api.policy({ extractedChars: 100 }));
  assert.equal(selector, 'h1,h2,h3,p,blockquote,li');
  assert.deepEqual(JSON.parse(JSON.stringify(blocks)), [{ tag: 'p', text: 'Fish & Chips <literal>' }]);
  assert.equal(JSON.stringify(blocks).includes('onclick'), false);
  assert.equal(JSON.stringify(blocks).includes('https://'), false);
  for (const forbidden of ['script', 'iframe', 'img', 'link', 'style']) assert.equal(selector.includes(forbidden), false);
});

test('invalid parsing cannot be persisted and failure clears partial content', () => {
  const reader = fs.readFileSync(path.join(root, 'reader.js'), 'utf8');
  assert.match(reader, /catch \(error\) \{\s*if \(controller\.signal\.aborted\)[\s\S]*?else failDocument\(error\);\s*return;/);
  assert.match(reader, /function failDocument[\s\S]*content\.replaceChildren\(\)/);
  assert.match(reader, /Não foi possível persistir[\s\S]*await displayFile\(file, parsed\.blocks\)/);
});
