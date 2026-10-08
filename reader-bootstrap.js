(() => {
  "use strict";

  const status = document.querySelector("#status");
  const moduleScript = document.querySelector("#reader-module");
  const messages = Object.freeze({
    loading: "reader.bootstrapLoading",
    ready: "reader.ready",
    validating: "reader.validating",
    reading: "reader.reading",
    classifying: "reader.classifying",
    extractingPdf: "reader.extractingPdf",
    extractingEpub: "reader.extractingEpub",
    saving: "reader.saving",
    displaying: "reader.displaying",
    moduleError: "reader.moduleError",
    asyncError: "reader.asyncError"
  });

  function show(stage) {
    const key = messages[stage];
    const message = key && globalThis.NovelLocalReader?.i18n?.t(key);
    if (status && message) status.textContent = message;
  }

  show("loading");
  moduleScript?.addEventListener("error", () => show("moduleError"), { once: true });
  window.addEventListener("error", (event) => {
    if (event.target === moduleScript) show("moduleError");
  });
  window.addEventListener("unhandledrejection", () => show("asyncError"));
  window.addEventListener("nlr-reader-stage", (event) => {
    show(event.detail?.stage);
  });
})();
