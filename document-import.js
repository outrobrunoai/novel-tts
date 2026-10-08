(() => {
  "use strict";

  const MiB = 1024 * 1024;
  const DEFAULT_IMPORT_POLICY = Object.freeze({
    epubBytes: 64 * MiB,
    pdfBytes: 100 * MiB,
    textBytes: 10 * MiB,
    epubEntries: 4096,
    epubEntryBytes: 16 * MiB,
    epubTotalBytes: 128 * MiB,
    epubCompressionRatio: 200,
    sections: 2000,
    textItems: 100_000,
    extractedChars: 20_000_000,
    textExtractedChars: 10_000_000,
    pdfPages: 20_000,
    pdfItemsPerPage: 50_000,
    pdfCharsPerPage: 1_000_000,
    pdfItemsTotal: 2_000_000,
    pdfSignatureOffset: 1024
  });

  function policy(overrides = {}) {
    return Object.freeze({ ...DEFAULT_IMPORT_POLICY, ...overrides });
  }

  function extensionOf(name) {
    const match = String(name || "").toLowerCase().match(/\.([^.]+)$/);
    return match ? match[1] : "";
  }

  function startsWith(bytes, signature, offset = 0) {
    return signature.every((value, index) => bytes[offset + index] === value);
  }

  function pdfSignatureOffset(bytes, maximum) {
    const signature = [0x25, 0x50, 0x44, 0x46, 0x2d];
    const end = Math.min(maximum, Math.max(0, bytes.length - signature.length));
    for (let offset = 0; offset <= end; offset += 1) {
      if (startsWith(bytes, signature, offset)) return offset;
    }
    return -1;
  }

  function looksBinary(bytes) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
    let controls = 0;
    for (const value of sample) {
      if (value === 0) return true;
      if (value < 9 || (value > 13 && value < 32)) controls += 1;
    }
    return sample.length > 0 && controls / sample.length > 0.02;
  }

  function preflightFile(file, limits = DEFAULT_IMPORT_POLICY) {
    const extension = extensionOf(file.name);
    const mime = String(file.type || "").toLowerCase();
    if (extension === "pdf" || mime === "application/pdf") {
      if (file.size > limits.pdfBytes) throw new Error("PDF excede o limite de tamanho");
      return "pdf";
    }
    if (extension === "epub" || mime === "application/epub+zip") {
      if (file.size > limits.epubBytes) throw new Error("EPUB excede o limite de tamanho");
      return "epub";
    }
    if (!["txt", "html", "htm"].includes(extension) && !mime.startsWith("text/")) {
      throw new Error("Formato de arquivo não suportado");
    }
    if (file.size > limits.textBytes) throw new Error("Documento de texto excede o limite de tamanho");
    return extension === "html" || extension === "htm" || mime === "text/html" ? "html" : "text";
  }

  function classifyFile(file, bytes, limits = DEFAULT_IMPORT_POLICY) {
    const type = preflightFile(file, limits);
    if (type === "pdf") {
      if (pdfSignatureOffset(bytes, limits.pdfSignatureOffset) < 0) throw new Error("Assinatura PDF inválida");
      return type;
    }
    if (type === "epub") {
      if (!(startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))) {
        throw new Error("EPUB não é um arquivo ZIP válido");
      }
      return type;
    }
    if (looksBinary(bytes)) throw new Error("Documento de texto contém dados binários");
    return type;
  }

  function decodeUtf8(bytes, label = "texto") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`${label} não está em UTF-8 válido`, { cause: error });
    }
  }

  function safeDecodeUri(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      throw new Error("URI malformada no EPUB", { cause: error });
    }
  }

  function normalizeEpubPath(value, base = "", reference = false) {
    let raw = String(value || "");
    if (raw.includes("\0") || raw.includes("\\")) throw new Error("Caminho inseguro no EPUB");
    const hash = raw.indexOf("#");
    if (hash >= 0) {
      if (!reference) throw new Error("Nome de entrada EPUB contém fragmento");
      raw = raw.slice(0, hash);
    }
    if (raw.includes("?")) throw new Error("Query string não suportada no EPUB");
    raw = safeDecodeUri(raw);
    if (raw.includes("\0") || raw.includes("\\")) throw new Error("Caminho inseguro no EPUB");
    if (/%[0-9a-f]{2}/i.test(raw)) throw new Error("Caminho EPUB contém codificação URI aninhada");
    if (raw.includes("?")) throw new Error("Query string não suportada no EPUB");
    if (!raw || raw.startsWith("/") || /^[a-z]:/i.test(raw)) throw new Error("Caminho absoluto ou vazio no EPUB");
    const parts = base ? base.split("/").filter(Boolean) : [];
    for (const part of raw.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) throw new Error("Caminho EPUB tenta sair da raiz");
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    if (!parts.length) throw new Error("Caminho vazio no EPUB");
    return parts.join("/");
  }

  function u16(view, offset) { return view.getUint16(offset, true); }
  function u32(view, offset) { return view.getUint32(offset, true); }

  function zipMetadata(bytes, limits = DEFAULT_IMPORT_POLICY) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = bytes.length - 22;
    const minimum = Math.max(0, bytes.length - 65558);
    while (eocd >= minimum && (eocd + 4 > bytes.length || u32(view, eocd) !== 0x06054b50)) eocd -= 1;
    if (eocd < minimum) throw new Error("ZIP do EPUB está corrompido");
    const entriesCount = u16(view, eocd + 10);
    const centralSize = u32(view, eocd + 12);
    const centralOffset = u32(view, eocd + 16);
    if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0 || u16(view, eocd + 8) !== entriesCount) {
      throw new Error("EPUB ZIP multidisco não é suportado");
    }
    if (entriesCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      throw new Error("EPUB ZIP64 não é suportado");
    }
    if (entriesCount > limits.epubEntries) throw new Error("EPUB contém entradas demais");
    if (centralOffset + centralSize > eocd) throw new Error("Diretório ZIP inválido");
    const entries = [];
    const names = new Set();
    let offset = centralOffset;
    let total = 0;
    for (let index = 0; index < entriesCount; index += 1) {
      if (offset + 46 > bytes.length || u32(view, offset) !== 0x02014b50) throw new Error("Diretório ZIP inválido");
      const flags = u16(view, offset + 8);
      const compression = u16(view, offset + 10);
      const compressedSize = u32(view, offset + 20);
      const originalSize = u32(view, offset + 24);
      const nameLength = u16(view, offset + 28);
      const extraLength = u16(view, offset + 30);
      const commentLength = u16(view, offset + 32);
      const localOffset = u32(view, offset + 42);
      if (flags & 1) throw new Error("EPUB criptografado não é suportado");
      if (![0, 8].includes(compression)) throw new Error("Compressão EPUB não suportada");
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > bytes.length) throw new Error("Diretório ZIP truncado");
      const rawName = decodeUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength), "Nome de entrada EPUB");
      const name = normalizeEpubPath(rawName);
      if (names.has(name)) throw new Error("EPUB contém caminhos duplicados após normalização");
      names.add(name);
      if (originalSize > limits.epubEntryBytes) throw new Error("Entrada EPUB excede o limite individual");
      total += originalSize;
      if (total > limits.epubTotalBytes) throw new Error("EPUB excede o limite descompactado total");
      const ratio = originalSize / Math.max(1, compressedSize);
      if (ratio > limits.epubCompressionRatio) throw new Error("EPUB possui taxa de compressão insegura");
      if (localOffset + 30 > centralOffset || u32(view, localOffset) !== 0x04034b50) {
        throw new Error("Local header ZIP inválido");
      }
      const localFlags = u16(view, localOffset + 6);
      const localCompression = u16(view, localOffset + 8);
      const localCompressedSize = u32(view, localOffset + 18);
      const localOriginalSize = u32(view, localOffset + 22);
      const localNameLength = u16(view, localOffset + 26);
      const localExtraLength = u16(view, localOffset + 28);
      const localNameEnd = localOffset + 30 + localNameLength;
      const dataOffset = localNameEnd + localExtraLength;
      if (dataOffset > centralOffset || dataOffset + compressedSize > centralOffset) {
        throw new Error("Dados ZIP ultrapassam a central directory");
      }
      const localRawName = decodeUtf8(bytes.subarray(localOffset + 30, localNameEnd), "Nome local EPUB");
      if (normalizeEpubPath(localRawName) !== name || localFlags !== flags || localCompression !== compression) {
        throw new Error("Central directory e local header divergentes");
      }
      if (!(flags & 8) && (localCompressedSize !== compressedSize || localOriginalSize !== originalSize)) {
        throw new Error("Tamanhos do local header divergem da central directory");
      }
      entries.push({ name, compressedSize, originalSize, compression, directory: rawName.endsWith("/") });
      offset = end;
    }
    if (offset !== centralOffset + centralSize) throw new Error("Tamanho do diretório ZIP inválido");
    return entries;
  }

  function validateExpandedEpub(archive, metadata, limits = DEFAULT_IMPORT_POLICY) {
    const expected = new Map(metadata.map((entry) => [entry.name, entry]));
    let total = 0;
    for (const [rawName, value] of Object.entries(archive)) {
      const name = normalizeEpubPath(rawName);
      const entry = expected.get(name);
      if (!entry || !(value instanceof Uint8Array)) throw new Error("Entrada descompactada inesperada no EPUB");
      const actualSize = value.byteLength;
      if (actualSize !== entry.originalSize) throw new Error("Tamanho real da entrada EPUB diverge do metadata");
      if (actualSize > limits.epubEntryBytes) throw new Error("Entrada EPUB excede o limite individual após descompactação");
      total += actualSize;
      if (total > limits.epubTotalBytes) throw new Error("EPUB excede o limite real descompactado total");
      if (actualSize / Math.max(1, entry.compressedSize) > limits.epubCompressionRatio) {
        throw new Error("EPUB possui taxa de compressão real insegura");
      }
    }
    return archive;
  }

  function textBudget(limits = DEFAULT_IMPORT_POLICY) {
    let characters = 0;
    let sections = 0;
    let items = 0;
    return {
      addText(value) {
        characters += String(value || "").length;
        if (characters > limits.extractedChars) throw new Error("Texto extraído excede o limite");
      },
      addSection() {
        sections += 1;
        if (sections > limits.sections) throw new Error("Documento contém seções demais");
      },
      addItem() {
        items += 1;
        if (items > limits.textItems) throw new Error("Documento contém elementos textuais demais");
      },
      get characters() { return characters; },
      get sections() { return sections; },
      get items() { return items; }
    };
  }

  function epubPackagePlan(opfPath, manifestItems, spineIds, archiveNames, limits = DEFAULT_IMPORT_POLICY) {
    if (manifestItems.length > limits.sections || spineIds.length > limits.sections) {
      throw new Error("Manifesto ou spine EPUB excessivo");
    }
    const normalizedOpf = normalizeEpubPath(opfPath, "", true);
    const base = normalizedOpf.includes("/") ? normalizedOpf.slice(0, normalizedOpf.lastIndexOf("/")) : "";
    const manifest = new Map();
    for (const item of manifestItems) {
      if (!item.id || !item.href || manifest.has(item.id)) throw new Error("Manifesto EPUB inválido");
      manifest.set(item.id, normalizeEpubPath(item.href, base, true));
    }
    const available = new Set(archiveNames);
    return spineIds.map((id) => {
      const name = manifest.get(id);
      if (!name || !available.has(name)) throw new Error("Item do spine ausente no EPUB");
      return name;
    });
  }

  function importCancelledError() {
    const error = new Error("Importação cancelada");
    error.name = "AbortError";
    return error;
  }

  function awaitWithAbort(value, signal) {
    const pending = Promise.resolve(value);
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(importCancelledError());
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(importCancelledError());
      signal.addEventListener("abort", onAbort, {once: true});
    });
    return Promise.race([pending, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
  }

  async function readPdfPages(pdfjs, bytes, limits = DEFAULT_IMPORT_POLICY, progress = () => {}, consume = null,
    {signal = null, yieldControl = () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
      yieldEvery = 16} = {}) {
    const throwIfAborted = () => { if (signal?.aborted) throw importCancelledError(); };
    throwIfAborted();
    const options = { data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
      disableRange: true, disableStream: true, disableAutoFetch: true, useWorkerFetch: false };
    const task = pdfjs.getDocument(options);
    let document; let totalItems = 0; let totalChars = 0; let primaryError = null; const pages = [];
    let destroyPromise = null;
    const destroyTask = () => {
      if (!destroyPromise) {
        destroyPromise = Promise.resolve().then(() => {
          if (typeof document?.destroy === "function") return document.destroy();
          return task.destroy?.();
        });
      }
      return destroyPromise;
    };
    const abortTask = () => { void destroyTask().catch(() => undefined); };
    signal?.addEventListener("abort", abortTask, {once: true});
    try {
      document = await awaitWithAbort(task.promise, signal);
      throwIfAborted();
      if (document.numPages > limits.pdfPages) {
        throw new Error(`PDF contém ${document.numPages} páginas; limite configurado: ${limits.pdfPages}`);
      }
      for (let number = 1; number <= document.numPages; number += 1) {
        throwIfAborted();
        progress(number, document.numPages);
        if (yieldEvery > 0 && number % yieldEvery === 0) {
          await yieldControl();
          throwIfAborted();
        }
        const page = await awaitWithAbort(document.getPage(number), signal);
        let pageError = null;
        try {
          throwIfAborted();
          const text = await awaitWithAbort(page.getTextContent(), signal);
          throwIfAborted();
          if (text.items.length > limits.pdfItemsPerPage) throw new Error("Página PDF contém itens demais");
          totalItems += text.items.length;
          if (totalItems > limits.pdfItemsTotal) throw new Error("PDF contém itens de texto demais");
          const pageChars = text.items.reduce((sum, item) => sum + String(item.str || "").length, 0);
          if (pageChars > limits.pdfCharsPerPage) throw new Error("Página PDF contém texto demais");
          totalChars += pageChars;
          if (totalChars > limits.extractedChars) throw new Error("Texto extraído excede o limite");
          const value = { items: text.items, width: page.getViewport({ scale: 1 }).width };
          const output = consume ? await awaitWithAbort(consume(value), signal) : [value];
          for (const item of output) pages.push(item);
        } catch (error) {
          pageError = error;
          throw error;
        } finally {
          try {
            page.cleanup?.();
          } catch (cleanupError) {
            if (!pageError) throw cleanupError;
          }
        }
      }
      return pages;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortTask);
      try {
        await destroyTask();
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
  }

  function textBlocksFromDocument(document, limits = DEFAULT_IMPORT_POLICY, budget = textBudget(limits)) {
    const blocks = [];
    for (const node of document.querySelectorAll("h1,h2,h3,p,blockquote,li")) {
      budget.addItem();
      budget.addText(node.textContent);
      blocks.push({ tag: String(node.tagName || "p").toLowerCase(), text: node.textContent });
    }
    return blocks;
  }

  function epubBlocks(archive, parseXml, parseHtml, limits = DEFAULT_IMPORT_POLICY, progress = () => {}) {
    if (archive["META-INF/encryption.xml"]) throw new Error("EPUB criptografado não é suportado");
    const containerBytes = archive["META-INF/container.xml"];
    if (!containerBytes) throw new Error("EPUB sem META-INF/container.xml");
    if (!archive.mimetype || decodeUtf8(archive.mimetype, "mimetype").trim() !== "application/epub+zip") {
      throw new Error("EPUB sem mimetype válido");
    }
    const container = parseXml(decodeUtf8(containerBytes, "container.xml"));
    const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
    const normalizedOpf = opfPath && normalizeEpubPath(opfPath, "", true);
    if (!normalizedOpf || !archive[normalizedOpf]) throw new Error("EPUB sem package OPF válido");
    const opf = parseXml(decodeUtf8(archive[normalizedOpf], "package OPF"));
    const manifestItems = [...opf.querySelectorAll("manifest item")];
    const spineItems = [...opf.querySelectorAll("spine itemref")];
    const spine = epubPackagePlan(
      normalizedOpf,
      manifestItems.map((item) => ({ id: item.getAttribute("id"), href: item.getAttribute("href") })),
      spineItems.map((item) => item.getAttribute("idref")), Object.keys(archive), limits
    );
    const budget = textBudget(limits); const blocks = [];
    spine.forEach((name, index) => {
      progress(index + 1, spine.length);
      blocks.push(...textBlocksFromDocument(parseHtml(decodeUtf8(archive[name], name)), limits, budget));
    });
    return blocks;
  }

  globalThis.NovelDocumentImport = Object.freeze({
    DEFAULT_IMPORT_POLICY,
    policy,
    classifyFile,
    decodeUtf8,
    epubPackagePlan,
    epubBlocks,
    normalizeEpubPath,
    pdfSignatureOffset,
    preflightFile,
    textBudget,
    textBlocksFromDocument,
    readPdfPages,
    validateExpandedEpub,
    zipMetadata
  });
})();
