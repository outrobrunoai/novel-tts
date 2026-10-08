import * as pdfjsLib from "./vendor/pdf.mjs";
import { unzipSync } from "./vendor/fflate.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("vendor/pdf.worker.mjs");

const i18n = globalThis.NovelLocalReader.i18n;
const tr = (key, values) => i18n.t(key, values);
let currentStatus = null;
function showStatus(key, values = {}) {
  currentStatus = {key, values};
  status.textContent = tr(key, values);
}
const languageReady = i18n.loadFromBackground(browser)
  .catch(() => i18n.setLanguage('auto', browser))
  .then(() => {
    i18n.apply(document);
    if (currentStatus) showStatus(currentStatus.key, currentStatus.values);
  });
const removeLanguageListener = i18n.observeSettings(browser, () => {
  i18n.apply(document);
  if (currentStatus) showStatus(currentStatus.key, currentStatus.values);
  if (autoTrimButton) autoTrimButton.textContent = tr(detectedStart ? 'reader.detectedToc' : 'reader.removeCover');
});
window.addEventListener('pagehide', removeLanguageListener, {once: true});

const fileInput = document.querySelector("#file");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#status");
const cancelImportButton = document.querySelector("#cancel-import");
const content = document.querySelector("#reader-content");
const documentActions = document.querySelector("#document-actions");
const autoTrimButton = document.querySelector("#auto-trim");
const chooseStartButton = document.querySelector("#choose-start");
const undoTrimButton = document.querySelector("#undo-trim");
const savedSection = document.querySelector("#saved-section");
const savedDocuments = document.querySelector("#saved-documents");
const store = globalThis.NovelDocumentStore;
const importer = globalThis.NovelDocumentImport;
const importPolicy = importer.DEFAULT_IMPORT_POLICY;
let currentDocumentId = "";
let activeImportController = null;
let removedNodes = [];
let detectedStart = null;
let choosingStart = false;

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  // Clearing the native input permits choosing the same file again after a failed import.
  fileInput.value = "";
  void importFile(file);
});
for (const eventName of ["dragenter", "dragover"]) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("drag");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  document.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag");
  });
}
document.addEventListener("drop", (event) => importFile(event.dataTransfer.files[0]));
autoTrimButton.addEventListener("click", autoTrim);
chooseStartButton.addEventListener("click", beginChoosingStart);
undoTrimButton.addEventListener("click", undoTrim);
content.addEventListener("click", chooseStartAtParagraph, true);
cancelImportButton.addEventListener("click", cancelImport);

initialize();
reportReaderStage("ready");

async function initialize() {
  await languageReady;
  await renderSavedDocuments();
  const id = new URL(location.href).searchParams.get("document");
  if (id) await openSavedDocument(id);
}

async function importFile(file) {
  if (!file) return;
  const controller = beginImport();
  reportReaderStage("validating");
  let parsed;
  try {
    parsed = await parseFile(file, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      if (activeImportController === controller) showStatus('reader.cancelled');
    }
    else failDocument(error);
    return;
  } finally {
    finishImport(controller);
  }
  reportReaderStage("saving");
  let temporaryRead = false;
  try {
    const saved = await store.saveFile(file, parsed.data);
    currentDocumentId = saved.id;
    setDocumentUrl(saved.id);
    await renderSavedDocuments();
  } catch (error) {
    console.warn("Não foi possível persistir o arquivo", error);
    currentDocumentId = "";
    temporaryRead = true;
  }
  await displayFile(file, parsed.blocks);
  if (temporaryRead && document.body.dataset.nlrDocumentReady === "true") {
    showStatus('reader.temporary');
  }
}

async function openSavedDocument(id) {
  showStatus('reader.openingSaved');
  try {
    const record = await store.getDocument(id);
    if (!record) throw new Error("arquivo não encontrado na biblioteca local");
    const file = new File([record.data], record.name, {
      type: record.type,
      lastModified: record.lastModified
    });
    await loadFile(file, id);
  } catch (error) {
    console.error(error);
    showStatus('reader.openSavedFailed', {error: error.message});
  }
}

async function loadFile(file, documentId = currentDocumentId) {
  if (!file) return;
  const controller = beginImport();
  showStatus('reader.openingFile', {name: file.name});
  try {
    const parsed = await parseFile(file, controller.signal);
    cancelImportButton.hidden = true;
    currentDocumentId = documentId;
    await displayFile(file, parsed.blocks);
  } catch (error) {
    if (controller.signal.aborted) {
      if (activeImportController === controller) showStatus('reader.cancelled');
    }
    else failDocument(error);
  } finally {
    finishImport(controller);
  }
}

async function parseFile(file, signal = null) {
  const expectedType = importer.preflightFile(file, importPolicy);
  if (expectedType === "pdf") {
    cancelImportButton.hidden = false;
    showStatus('reader.readingPdf');
  }
  reportReaderStage("reading");
  const data = await waitForImport(file.arrayBuffer(), signal);
  if (signal?.aborted) throw createImportCancelledError();
  reportReaderStage("classifying");
  const bytes = new Uint8Array(data);
  const type = importer.classifyFile(file, bytes, importPolicy);
  // PDF.js may transfer its TypedArray to the worker. This one bounded copy is
  // necessary to retain the original bytes for IndexedDB after parsing.
  if (type === "pdf") return { data, blocks: await readPdf(bytes.slice(), signal) };
  if (type === "epub") return { data, blocks: await readEpub(bytes) };
  const text = importer.decodeUtf8(bytes, type === "html" ? "HTML" : "TXT");
  return { data, blocks: type === "html" ? readHtml(text) : readText(text) };
}

async function displayFile(file, blocks) {
  reportReaderStage("displaying");
  content.replaceChildren();
  delete document.body.dataset.nlrDocumentReady;
  removedNodes = [];
  detectedStart = null;
  undoTrimButton.hidden = true;
  stopChoosingStart();
  try {
    await appendBlocks(blocks);
    dropZone.hidden = true;
    savedSection.hidden = true;
    documentActions.hidden = false;
    document.title = `${file.name} · Novel TTS`;
    document.body.dataset.nlrDocumentId = currentDocumentId;
    document.body.dataset.nlrDocumentName = file.name;
    const restored = await restoreSavedStart();
    detectedStart = restored ? null : detectStoryStart();
    autoTrimButton.textContent = tr(detectedStart ? 'reader.detectedToc' : 'reader.removeCover');
    if (!restored) {
      showStatus('reader.loaded', {count: content.querySelectorAll("p").length});
    }
    document.body.dataset.nlrDocumentReady = "true";
    window.dispatchEvent(new CustomEvent("nlr-document-ready", {
      detail: { id: currentDocumentId, name: file.name }
    }));
  } catch (error) {
    failDocument(error);
  }
}

function failDocument(error) {
  console.error(error);
  content.replaceChildren();
  delete document.body.dataset.nlrDocumentReady;
  delete document.body.dataset.nlrDocumentId;
  delete document.body.dataset.nlrDocumentName;
  currentDocumentId = "";
  documentActions.hidden = true;
  dropZone.hidden = false;
  showStatus(error?.code === 'PDF_NO_TEXT' ? 'reader.noPdfText' : 'reader.openFailed', {
    error: error?.message || ''
  });
}

async function renderSavedDocuments() {
  try {
    const documents = await store.listDocuments();
    savedSection.hidden = documents.length === 0 || dropZone.hidden;
    savedDocuments.replaceChildren(...documents.slice(0, 8).map(savedDocumentRow));
  } catch (error) {
    console.warn("Não foi possível listar os arquivos salvos", error);
  }
}

function savedDocumentRow(documentRecord) {
  const row = document.createElement("article");
  row.className = "saved-document";
  const details = document.createElement("div");
  const title = document.createElement("strong");
  const metadata = document.createElement("small");
  title.textContent = documentRecord.name;
  metadata.textContent = tr('reader.savedMetadata', {size: formatBytes(documentRecord.size), date: formatDate(documentRecord.updatedAt)});
  details.append(title, metadata);
  const buttons = document.createElement("div");
  buttons.className = "document-buttons";
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = tr('reader.openButton');
  open.addEventListener("click", () => {
    location.href = documentUrl(documentRecord.id);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = tr('reader.delete');
  remove.addEventListener("click", async () => {
    if (!confirm(tr('reader.deleteConfirm', {name: documentRecord.name}))) return;
    await store.deleteDocument(documentRecord.id);
    await cleanupDocumentData(documentRecord.id);
    await renderSavedDocuments();
  });
  buttons.append(open, remove);
  row.append(details, buttons);
  return row;
}

function detectStoryStart() {
  const nodes = [...content.children];
  const chapters = nodes
    .map((node, index) => ({ ...parseChapter(node.textContent), node, index }))
    .filter((entry) => Number.isFinite(entry.number));

  for (let start = 0; start <= chapters.length - 6; start += 1) {
    const run = chapters.slice(start, start + 5);
    const isTocRun = run.every((entry, index) =>
      index === 0 ||
      (entry.number > run[index - 1].number && entry.index - run[index - 1].index <= 5)
    );
    if (!isTocRun || run[0].index > nodes.length * 0.65) continue;

    const first = run[0];
    const exactRepeat = chapters.slice(start + 5).find(
      (entry) => entry.index > run[4].index && entry.titleKey === first.titleKey
    );
    if (exactRepeat) return exactRepeat.node;

    let highest = run[4].number;
    for (const entry of chapters.slice(start + 5)) {
      if (entry.number <= first.number + 1 && highest >= first.number + 4) {
        return entry.node;
      }
      highest = Math.max(highest, entry.number);
    }
  }
  return null;
}

function parseChapter(text) {
  const clean = normalizeText(text)
    .replace(/^\d+\s*[.)]\s*/, "")
    .replace(/^[•·-]\s*/, "");
  const match = clean.match(/^(?:chapter|cap[ií]tulo|episode|epis[oó]dio|ep\.?|part|parte)\s*(\d+)\b/i);
  return {
    number: match ? Number(match[1]) : Number.NaN,
    titleKey: clean.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  };
}

async function autoTrim() {
  const target = detectedStart || detectStoryStart();
  if (!target) {
    showStatus('reader.tocFailure');
    beginChoosingStart();
    return;
  }
  await trimBefore(target);
}

function beginChoosingStart() {
  choosingStart = true;
  document.documentElement.classList.add("nlr-choose-start");
  chooseStartButton.textContent = tr('reader.chooseParagraph');
  showStatus('reader.chooseInstruction');
  content.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function chooseStartAtParagraph(event) {
  if (!choosingStart) return;
  const target = event.target.closest("#reader-content > h1, #reader-content > h2, #reader-content > h3, #reader-content > p, #reader-content > blockquote");
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  stopChoosingStart();
  await trimBefore(target);
}

function stopChoosingStart() {
  choosingStart = false;
  document.documentElement.classList.remove("nlr-choose-start");
  if (chooseStartButton) chooseStartButton.textContent = tr('reader.chooseStartButton');
}

async function trimBefore(target) {
  if (!target || target.parentElement !== content) return;
  const originalNodes = [...content.children];
  const currentStartIndex = originalNodes.indexOf(target);
  const startIndex = removedNodes.length + currentStartIndex;
  const newlyRemoved = originalNodes.slice(0, currentStartIndex);
  removedNodes.push(...newlyRemoved);
  for (const node of newlyRemoved) node.remove();
  detectedStart = null;
  autoTrimButton.textContent = tr('reader.removeCover');
  undoTrimButton.hidden = removedNodes.length === 0;
  showStatus('reader.trimmed', {count: removedNodes.length, text: shortText(target.textContent)});
  await saveStartPreference(startIndex, target.textContent);
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function undoTrim() {
  if (removedNodes.length) content.prepend(...removedNodes);
  const restoredCount = removedNodes.length;
  removedNodes = [];
  undoTrimButton.hidden = true;
  detectedStart = detectStoryStart();
  autoTrimButton.textContent = tr(detectedStart ? 'reader.detectedToc' : 'reader.removeCover');
  await removeDocumentPreferences(currentDocumentId);
  showStatus('reader.restoredBlocks', {count: restoredCount});
  content.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveStartPreference(startIndex, startText) {
  if (!currentDocumentId) return;
  const saved = await browser.storage.local.get("nlrDocumentPrefs");
  const preferences = saved.nlrDocumentPrefs || {};
  preferences[currentDocumentId] = {
    startIndex,
    startText: normalizeText(startText),
    updatedAt: Date.now()
  };
  await browser.storage.local.set({ nlrDocumentPrefs: preferences });
}

async function restoreSavedStart() {
  if (!currentDocumentId) return false;
  const saved = await browser.storage.local.get("nlrDocumentPrefs");
  const preference = saved.nlrDocumentPrefs?.[currentDocumentId];
  if (!preference) return false;
  const nodes = [...content.children];
  let target = nodes[preference.startIndex];
  if (!target || normalizeText(target.textContent) !== preference.startText) {
    target = nodes.find((node, index) =>
      index >= Math.max(0, preference.startIndex - 5) &&
      normalizeText(node.textContent) === preference.startText
    );
  }
  if (!target) return false;
  await trimBefore(target);
  showStatus('reader.restoredStart', {text: shortText(target.textContent)});
  return true;
}

async function removeDocumentPreferences(id) {
  if (!id) return;
  const saved = await browser.storage.local.get("nlrDocumentPrefs");
  const preferences = saved.nlrDocumentPrefs || {};
  delete preferences[id];
  await browser.storage.local.set({ nlrDocumentPrefs: preferences });
}

async function cleanupDocumentData(id) {
  if (!id) return;
  const saved = await browser.storage.local.get(["nlrDocumentPrefs", "nlrProgress", "nlrHistory"]);
  const preferences = saved.nlrDocumentPrefs || {};
  delete preferences[id];
  const belongsToDocument = (item) => {
    try {
      return new URL(item.url).searchParams.get("document") === id;
    } catch {
      return false;
    }
  };
  const progress = Object.fromEntries(
    Object.entries(saved.nlrProgress || {}).filter(([, item]) => !belongsToDocument(item))
  );
  const history = (saved.nlrHistory || []).filter((item) => !belongsToDocument(item));
  await browser.storage.local.set({ nlrDocumentPrefs: preferences, nlrProgress: progress, nlrHistory: history });
}

function setDocumentUrl(id) {
  history.replaceState({}, "", documentUrl(id));
}

function documentUrl(id) {
  const url = new URL(browser.runtime.getURL("reader.html"));
  url.searchParams.set("document", id);
  return url.href;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shortText(value) {
  const text = normalizeText(value);
  return text.length > 75 ? `${text.slice(0, 72)}…` : text;
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(i18n.currentLanguage(), { dateStyle: "short" }).format(timestamp);
}

function readText(text) {
  const budget = importer.textBudget(importer.policy({ extractedChars: importPolicy.textExtractedChars })); budget.addText(text);
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n|\n(?=[—“"A-Z])/).map((part) => part.trim()).filter(Boolean);
  return blocks.map((text) => ({ tag: "p", text }));
}

function readHtml(html) {
  return importer.textBlocksFromDocument(parseInertHtml(html), importer.policy({ extractedChars: importPolicy.textExtractedChars }));
}

function parseInertHtml(html) {
  // Parse imported markup in an inert document. It is converted to text blocks
  // immediately; no imported bytes are ever assigned to innerHTML.
  return new DOMParser().parseFromString(html, "text/html").body;
}

async function readPdf(bytes, signal = null) {
  reportReaderStage("extractingPdf");
  cancelImportButton.hidden = false;
  showStatus('reader.pdfPreparing');
  const blocks = await importer.readPdfPages(pdfjsLib, bytes, importPolicy, (page, total) => {
    cancelImportButton.hidden = false;
    showStatus('reader.pdfPage', {page, total});
  }, ({ items, width }) =>
    reconstructPdfParagraphs(extractPdfLines(items), width).map((text) => ({ tag: "p", text })),
  {signal, yieldControl: yieldToUi}
  );
  if (!blocks.length) {
    const error = new Error(tr('reader.noPdfText'));
    error.code = 'PDF_NO_TEXT';
    throw error;
  }
  return blocks;
}

function beginImport() {
  activeImportController?.abort();
  activeImportController = new AbortController();
  cancelImportButton.hidden = true;
  return activeImportController;
}

function finishImport(controller) {
  if (activeImportController !== controller) return;
  activeImportController = null;
  cancelImportButton.hidden = true;
}

function cancelImport() {
  if (!activeImportController) return;
  activeImportController.abort();
  cancelImportButton.hidden = true;
  showStatus('reader.canceling');
}

function createImportCancelledError() {
  const error = new Error("Importação cancelada");
  error.name = "AbortError";
  return error;
}

function waitForImport(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(createImportCancelledError());
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(createImportCancelledError());
    signal.addEventListener("abort", onAbort, {once: true});
  });
  return Promise.race([Promise.resolve(value), aborted])
    .finally(() => signal.removeEventListener("abort", onAbort));
}

function yieldToUi() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function reportReaderStage(stage) {
  window.dispatchEvent(new CustomEvent("nlr-reader-stage", { detail: { stage } }));
}

function extractPdfLines(items) {
  const rows = new Map();
  for (const item of items) {
    const rawText = String(item.str || "");
    if (!rawText.trim()) continue;
    const transform = item.transform || [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const fontSize = Math.max(
      1,
      Math.abs(Number(item.height)) ||
        Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0) ||
        12
    );
    const width = Math.max(
      0,
      Number(item.width) || rawText.length * fontSize * 0.48
    );
    const rowKey = Math.round(y / Math.max(1.5, fontSize * 0.18));
    if (!rows.has(rowKey)) rows.set(rowKey, []);
    rows.get(rowKey).push({ x, y, width, fontSize, text: rawText });
  }

  return [...rows.values()]
    .map((rowItems) => {
      rowItems.sort((a, b) => a.x - b.x);
      const text = cleanPdfText(rowItems.map((item) => item.text).join(" "));
      return {
        text,
        y: rowItems.reduce((sum, item) => sum + item.y, 0) / rowItems.length,
        xStart: Math.min(...rowItems.map((item) => item.x)),
        xEnd: Math.max(...rowItems.map((item) => item.x + item.width)),
        fontSize: Math.max(...rowItems.map((item) => item.fontSize))
      };
    })
    .filter((line) => line.text)
    .sort((a, b) => b.y - a.y);
}

function reconstructPdfParagraphs(lines, pageWidth) {
  if (!lines.length) return [];
  const usefulLines = lines.filter(
    (line, index) =>
      !looksLikePageNumber(line.text) || (index >= 2 && index < lines.length - 2)
  );
  if (!usefulLines.length) return [];

  const candidateWidths = usefulLines
    .filter((line) => line.text.length >= 28)
    .map((line) => line.xEnd - line.xStart)
    .filter((width) => width > 0);
  const fullLineWidth = percentile(
    candidateWidths.length ? candidateWidths : [pageWidth * 0.75],
    0.8
  );
  const gaps = usefulLines
    .slice(0, -1)
    .map((line, index) => line.y - usefulLines[index + 1].y)
    .filter((gap) => gap > 1 && gap < 80);
  const typicalGap = percentile(gaps.length ? gaps : [14], 0.35);
  const baseLeft = percentile(usefulLines.map((line) => line.xStart), 0.2);
  const metrics = { fullLineWidth, typicalGap, baseLeft };
  const paragraphs = [];
  let paragraph = usefulLines[0].text;

  for (let index = 1; index < usefulLines.length; index += 1) {
    const previous = usefulLines[index - 1];
    const current = usefulLines[index];
    if (shouldJoinPdfLines(previous, current, metrics)) {
      paragraph = joinPdfText(paragraph, current.text);
    } else {
      paragraphs.push(cleanPdfText(paragraph));
      paragraph = current.text;
    }
  }
  paragraphs.push(cleanPdfText(paragraph));
  return paragraphs.filter(Boolean);
}

function shouldJoinPdfLines(previous, current, metrics) {
  const verticalGap = previous.y - current.y;
  const normalGapLimit = Math.max(
    metrics.typicalGap * 1.5,
    Math.max(previous.fontSize, current.fontSize) * 1.65
  );
  if (verticalGap > normalGapLimit) return false;

  const previousWidth = previous.xEnd - previous.xStart;
  const widthRatio = previousWidth / Math.max(1, metrics.fullLineWidth);
  const terminal = /[.!?…][\s”’"'»)\]}」』]*$/u.test(previous.text);
  const nextStartsDialogue = /^[“"'‘«「『—–]/u.test(current.text);
  const nextIsIndented =
    current.xStart > metrics.baseLeft + Math.max(9, current.fontSize * 0.7);

  if (terminal && nextStartsDialogue) return false;
  if (terminal && widthRatio < 0.78) return false;
  if (nextIsIndented) return false;
  if (looksLikeStandaloneMetadata(previous.text)) return false;
  return true;
}

function joinPdfText(left, right) {
  if (/[-‐‑]\s*$/u.test(left)) return cleanPdfText(`${left}${right}`);
  return cleanPdfText(`${left} ${right}`);
}

function cleanPdfText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([{“‘«「『])\s+/g, "$1")
    .replace(/\s+([)\]}”’»」』])/g, "$1")
    .trim();
}

function looksLikePageNumber(value) {
  return /^(?:page\s+)?\d{1,4}$/i.test(value.trim());
}

function looksLikeStandaloneMetadata(value) {
  return /^(?:author|translator|translation|editor|illustrator|artist|publisher|version|volume)\s*:/i.test(value.trim());
}

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.round((ordered.length - 1) * ratio))
  );
  return ordered[index];
}

async function readEpub(bytes) {
  reportReaderStage("extractingEpub");
  const metadata = importer.zipMetadata(bytes, importPolicy);
  const allowed = new Set(metadata.filter((entry) => entry.name === "mimetype" || /(?:^|\/)(?:container\.xml|encryption\.xml)$/i.test(entry.name) || /\.(?:opf|xhtml|html|htm|xml)$/i.test(entry.name)).map((entry) => entry.name));
  const rawArchive = unzipSync(bytes, { filter: (entry) => allowed.has(importer.normalizeEpubPath(entry.name)) });
  importer.validateExpandedEpub(rawArchive, metadata, importPolicy);
  const archive = {};
  for (const [name, value] of Object.entries(rawArchive)) archive[importer.normalizeEpubPath(name)] = value;
  return importer.epubBlocks(
    archive,
    parseXml,
    parseInertHtml,
    importPolicy,
    (section, total) => { showStatus('reader.epubSection', {section, total}); }
  );
}

function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("DTD e entidades externas não são aceitas no EPUB");
  const parsed = new DOMParser().parseFromString(text, "application/xml");
  if (parsed.querySelector("parsererror")) throw new Error("XML inválido no EPUB");
  return parsed;
}
async function appendBlocks(blocks) {
  const total = blocks.length;
  const batchSize = 250;
  for (let start = 0; start < total; start += batchSize) {
    const batch = [];
    const end = Math.min(total, start + batchSize);
    for (let index = start; index < end; index += 1) {
      const block = blocks[index];
      blocks[index] = null;
      const node = createBlockNode(block.tag || "p", block.text ?? block);
      if (node) batch.push(node);
    }
    content.append(...batch);
    if (end < total) {
      showStatus('reader.preparingReader', {end, total});
      await yieldToUi();
    }
  }
  blocks.length = 0;
}

function createBlockNode(tag, text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const allowed = ["h1", "h2", "h3", "blockquote"].includes(tag) ? tag : "p";
  const node = document.createElement(allowed);
  node.textContent = clean;
  return node;
}
