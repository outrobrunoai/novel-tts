const i18n = globalThis.NovelLocalReader.i18n;
const tr = (key, values) => i18n.t(key, values);
const languageReady = i18n.loadFromBackground(browser)
  .catch(() => i18n.setLanguage('auto', browser))
  .then(() => i18n.apply(document));
const removeLanguageListener = i18n.observeSettings(browser, () => render());

const progressList = document.querySelector("#progress-list");
const historyList = document.querySelector("#history-list");
const searchInput = document.querySelector("#search");
const empty = document.querySelector("#empty");
const summary = document.querySelector("#summary");
const documentsList = document.querySelector("#documents-list");
const documentsSection = document.querySelector("#documents-section");
let libraryData = { progress: [], history: [], documents: [] };

loadLibrary();
searchInput.addEventListener("input", render);
document.querySelector("#open-file").addEventListener("click", () => {
  location.href = browser.runtime.getURL("reader.html");
});
document.querySelector("#clear-history").addEventListener("click", async () => {
  if (!confirm(tr('library.clearConfirm'))) return;
  await browser.storage.local.set({ nlrHistory: [] });
  await loadLibrary();
});
window.addEventListener('pagehide', removeLanguageListener, {once: true});

async function loadLibrary() {
  await languageReady;
  const [saved, documents] = await Promise.all([
    browser.storage.local.get(["nlrProgress", "nlrHistory"]),
    NovelDocumentStore.listDocuments().catch((error) => {
      console.warn("Não foi possível abrir a biblioteca de arquivos", error);
      return [];
    })
  ]);
  const normalized = normalizeLocalReaderData(saved, documents);
  await browser.storage.local.set({
    nlrProgress: normalized.progress,
    nlrHistory: normalized.history
  });
  libraryData.progress = Object.values(normalized.progress).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  libraryData.history = normalized.history.sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
  libraryData.documents = documents;
  render();
}

function normalizeLocalReaderData(saved, documents) {
  const documentById = new Map(documents.map((item) => [item.id, item]));
  const progress = {};

  for (const [originalKey, originalItem] of Object.entries(saved.nlrProgress || {})) {
    const info = localReaderInfo(originalItem.url);
    if (info.isReader && !info.id && /leitor de arquivos/i.test(originalItem.chapterTitle || originalItem.title || "")) {
      continue;
    }
    const key = info.id ? `local-document:${info.id}` : originalKey;
    const documentRecord = info.id ? documentById.get(info.id) : null;
    const item = documentRecord
      ? {
          ...originalItem,
          novelTitle: "Arquivo local",
          chapterTitle: documentRecord.name,
          title: `${documentRecord.name} · Novel TTS`,
          url: readerUrl(info.id)
        }
      : originalItem;
    if (!progress[key] || Number(item.updatedAt) >= Number(progress[key].updatedAt)) {
      progress[key] = item;
    }
  }

  const historyByKey = new Map();
  for (const originalItem of saved.nlrHistory || []) {
    const info = localReaderInfo(originalItem.url);
    if (info.isReader && !info.id && /leitor de arquivos/i.test(originalItem.chapterTitle || originalItem.title || "")) {
      continue;
    }
    const documentRecord = info.id ? documentById.get(info.id) : null;
    const item = documentRecord
      ? {
          ...originalItem,
          novelTitle: "Arquivo local",
          chapterTitle: documentRecord.name,
          url: readerUrl(info.id)
        }
      : originalItem;
    const key = info.id ? `local-document:${info.id}` : normalizeUrl(item.url);
    const existing = historyByKey.get(key);
    if (!existing || Number(item.updatedAt) >= Number(existing.updatedAt)) {
      historyByKey.set(key, item);
    }
  }

  return { progress, history: [...historyByKey.values()] };
}

function localReaderInfo(value) {
  try {
    const url = new URL(value);
    return {
      isReader: url.pathname.endsWith("/reader.html"),
      id: url.searchParams.get("document") || ""
    };
  } catch {
    return { isReader: false, id: "" };
  }
}

function render() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const matches = (item) =>
    !query || `${item.novelTitle} ${item.chapterTitle} ${item.title}`.toLocaleLowerCase().includes(query);
  const progress = libraryData.progress.filter(matches);
  const history = libraryData.history.filter(matches);
  const documents = libraryData.documents.filter((item) =>
    !query || item.name.toLocaleLowerCase().includes(query)
  );

  progressList.replaceChildren(...progress.map(progressCard));
  historyList.replaceChildren(...history.map(historyRow));
  documentsList.replaceChildren(...documents.map(documentCard));
  documentsSection.hidden = documents.length === 0;
  document.querySelector("#continue-section").hidden = progress.length === 0;
  empty.hidden = progress.length + history.length + documents.length > 0;
  summary.textContent = tr('library.summary', {documents: documents.length, progress: progress.length, history: history.length});
}

function documentCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  const body = makeElement("div");
  body.append(
    makeElement("small", fileType(item.name)),
    makeElement("h3", item.name),
    Object.assign(makeElement("p", tr('library.fileMetadata', {
      size: formatBytes(item.size), date: formatDate(item.updatedAt)
    })), { className: "file-size" })
  );
  const footer = makeElement("footer");
  footer.append(makeElement("small", tr('library.storedFirefox')));
  const actions = makeElement("div");
  actions.className = "card-actions";
  const removeButton = makeElement("button", tr('reader.delete'));
  removeButton.className = "danger";
  removeButton.addEventListener("click", async () => {
    if (!confirm(tr('library.deleteConfirm', {name: item.name}))) return;
    await NovelDocumentStore.deleteDocument(item.id);
    await cleanupDocumentData(item.id);
    await loadLibrary();
  });
  const openButton = makeElement("button", tr('reader.openButton'));
  openButton.addEventListener("click", () => {
    location.href = readerUrl(item.id);
  });
  actions.append(removeButton, openButton);
  footer.append(actions);
  card.append(body, footer);
  return card;
}

function progressCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  const body = makeElement("div");
  body.append(
    makeElement("small", item.novelTitle || sourceName(item.url)),
    makeElement("h3", item.chapterTitle || item.title || tr('library.chapter')),
    makeElement("p", tr('library.progress', {index: Number(item.index) + 1, date: formatDate(item.updatedAt)}))
  );
  const footer = makeElement("footer");
  const continueButton = makeElement("button", tr('panel.continue'));
  footer.append(makeElement("small", sourceName(item.url)), continueButton);
  card.append(body, footer);
  continueButton.addEventListener("click", async () => {
    await browser.storage.local.set({
      nlrAutoContinue: {
        targetUrl: normalizeUrl(item.url),
        origin: new URL(item.url).origin,
        expiresAt: Date.now() + 120000,
        resume: true
      }
    });
    location.assign(item.url);
  });
  return card;
}

function historyRow(item) {
  const row = document.createElement("article");
  row.className = `history-item${item.completed ? " completed" : ""}`;
  const details = makeElement("div");
  const link = makeElement("a", item.chapterTitle || tr('library.chapter'));
  link.href = item.url;
  details.append(
    link,
    document.createElement("br"),
    makeElement("small", item.novelTitle || sourceName(item.url))
  );
  row.append(
    details,
    makeElement(
      "small",
      `${tr(item.completed ? 'library.completed' : 'library.inProgress')} · ${formatDate(item.updatedAt)}`
    )
  );
  return row;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(i18n.currentLanguage(), { dateStyle: "short", timeStyle: "short" }).format(timestamp);
}
function makeElement(tag, text = "") {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  return element;
}
function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function readerUrl(id) {
  const url = new URL(browser.runtime.getURL("reader.html"));
  url.searchParams.set("document", id);
  return url.href;
}

function sourceName(value) {
  const url = new URL(value);
  return url.hostname || (url.pathname.endsWith("reader.html") ? tr('library.localFile') : tr('library.novel'));
}

function fileType(name) {
  return tr('library.fileType', {type: name.split(".").pop()?.toLocaleUpperCase() || "FILE"});
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

async function cleanupDocumentData(id) {
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
