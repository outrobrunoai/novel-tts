(() => {
  const DB_NAME = "novel-local-reader-documents";
  const STORE_NAME = "documents";
  const BLOB_STORE = "document-data";
  const DB_VERSION = 2;

  // v1 kept the file bytes inside the metadata record, so listing the library
  // deserialised every book in full just to throw the bytes away. v2 splits the
  // payload into its own store keyed by the same id; listing now reads metadata
  // only, and the bytes are fetched one document at a time.
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.addEventListener("upgradeneeded", (event) => {
        const database = request.result;
        const transaction = request.transaction;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "id" });
        if (!store.indexNames.contains("fingerprint")) {
          store.createIndex("fingerprint", "fingerprint", { unique: true });
        }
        if (!store.indexNames.contains("updatedAt")) {
          store.createIndex("updatedAt", "updatedAt");
        }
        if (!database.objectStoreNames.contains(BLOB_STORE)) {
          database.createObjectStore(BLOB_STORE, { keyPath: "id" });
        }
        if (event.oldVersion < 2) {
          const blobs = transaction.objectStore(BLOB_STORE);
          const cursorRequest = store.openCursor();
          cursorRequest.addEventListener("success", () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const { data, ...details } = cursor.value;
            if (data !== undefined) {
              blobs.put({ id: details.id, data });
              cursor.update(details);
            }
            cursor.continue();
          });
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
      request.addEventListener("blocked", () =>
        reject(new Error("Feche as outras abas do leitor para atualizar a biblioteca."))
      );
    });
  }

  function settled(transaction, value) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(value()));
      transaction.addEventListener("abort", () => reject(transaction.error));
      transaction.addEventListener("error", () => reject(transaction.error));
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  }

  async function saveFile(file, parsedData) {
    const fingerprint = `${file.name}\u0000${file.size}\u0000${file.lastModified || 0}`;
    const data = parsedData || await file.arrayBuffer();
    const database = await openDatabase();
    try {
      const transaction = database.transaction([STORE_NAME, BLOB_STORE], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const existing = await requestResult(store.index("fingerprint").get(fingerprint));
      const now = Date.now();
      const record = {
        id: existing?.id || crypto.randomUUID(),
        fingerprint,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        lastModified: file.lastModified || now,
        addedAt: existing?.addedAt || now,
        updatedAt: now
      };
      store.put(record);
      transaction.objectStore(BLOB_STORE).put({ id: record.id, data });
      return await settled(transaction, () => record);
    } finally {
      database.close();
    }
  }

  async function getDocument(id) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction([STORE_NAME, BLOB_STORE], "readonly");
      const record = await requestResult(transaction.objectStore(STORE_NAME).get(id));
      if (!record) return undefined;
      const payload = await requestResult(transaction.objectStore(BLOB_STORE).get(id));
      return { ...record, data: payload?.data };
    } finally {
      database.close();
    }
  }

  async function listDocuments() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      return await new Promise((resolve, reject) => {
        const documents = [];
        const request = store.index("updatedAt").openCursor(null, "prev");
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(documents);
            return;
          }
          documents.push(metadata(cursor.value));
          cursor.continue();
        });
        request.addEventListener("error", () => reject(request.error));
      });
    } finally {
      database.close();
    }
  }

  async function deleteDocument(id) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction([STORE_NAME, BLOB_STORE], "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.objectStore(BLOB_STORE).delete(id);
      return await settled(transaction, () => true);
    } finally {
      database.close();
    }
  }

  function metadata(record) {
    const { data, ...details } = record;
    return details;
  }

  globalThis.NovelDocumentStore = {
    saveFile,
    getDocument,
    listDocuments,
    deleteDocument
  };
})();
