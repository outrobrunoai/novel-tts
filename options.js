const i18n = globalThis.NovelLocalReader.i18n;
const tr = (key, values) => i18n.t(key, values);
const removeLanguageListener = i18n.observeSettings(browser, () => {
  refreshOrigins().catch(() => undefined);
});
const languageReady = i18n.loadFromBackground(browser)
  .catch(() => i18n.setLanguage('auto', browser))
  .then(() => i18n.apply(document));

const statusElement = document.querySelector('#pair-status');
const originStatus = document.querySelector('#origin-status');
const originList = document.querySelector('#origin-list');
const pairForm = document.querySelector('#pair-form');
const pairInput = document.querySelector('#pair-token');
const pairButton = pairForm.querySelector('button[type="submit"]');
const ALL_SITES = ['http://*/*', 'https://*/*'];
const CONNECTION_TIMEOUT_MS = 10000;
// Only the origin form a content-script match accepts, e.g. https://site.tld/*
const ORIGIN_PATTERN = /^https?:\/\/[^\s/*]+\/\*$/;

function connectionFailureMessage(code) {
  const messages = {
    DATA_CONSENT_REQUIRED: 'options.consentUnavailable',
    PERMISSION_CHECK_FAILED: 'options.consentCheckFailed',
    AUTH_REQUIRED: 'options.keyRejected',
    HOST_TIMEOUT: 'options.hostTimeout',
    HOST_UNAVAILABLE: 'options.hostUnavailable',
    PAIRING_KEY_MISSING: 'options.keyNotSaved',
    HOST_FORBIDDEN: 'options.hostDenied',
    ORIGIN_FORBIDDEN: 'options.originDenied',
    INTERNAL_ERROR: 'options.hostError',
    ENDPOINT_NOT_FOUND: 'options.hostUnsupported',
    HOST_RESPONSE_INVALID: 'options.invalidResponse'
  };
  return tr(messages[code] || 'options.unexpectedError');
}

pairForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (pairButton.disabled) return;
  const token = pairInput.value.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    statusElement.textContent = tr('options.invalidToken');
    return;
  }
  let step = 'storage';
  let timedOut = false;
  let timer;
  pairButton.disabled = true;
  statusElement.textContent = tr('options.connecting');
  const operation = (async () => {
    await browser.storage.local.set({ nlrConnection: { token } });
    if (timedOut) return null;
    pairInput.value = '';
    step = 'background';
    return browser.runtime.sendMessage({ type: 'health' });
  })();
  const deadline = new Promise((resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      timedOut = true;
      const error = new Error('NLR_CONNECTION_CHECK_TIMEOUT');
      error.code = step === 'storage' ? 'STORAGE_TIMEOUT' : 'BACKGROUND_TIMEOUT';
      reject(error);
    }, CONNECTION_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([operation, deadline]);
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      statusElement.textContent = tr('options.backgroundUnavailable');
    } else {
      statusElement.textContent = result.ok
        ? tr('options.connected')
        : connectionFailureMessage(result.code);
    }
  } catch (error) {
    const code = error?.code;
    if (code === 'BACKGROUND_TIMEOUT') {
      statusElement.textContent = tr('options.backgroundTimeout');
    } else if (code === 'STORAGE_TIMEOUT' || step === 'storage') {
      statusElement.textContent = tr('options.saveFailed');
    } else if (code === 'DATA_CONSENT_REQUIRED' || code === 'PERMISSION_CHECK_FAILED') {
      statusElement.textContent = connectionFailureMessage(code);
    } else {
      const detail = typeof error?.message === 'string' ? error.message : '';
      const transportFailure = /receiving end does not exist|message port closed|could not establish connection|extension context invalidated/i
        .test(detail);
      statusElement.textContent = transportFailure
        ? tr('options.backgroundUnavailable')
        : tr('options.unexpectedError');
    }
  } finally {
    globalThis.clearTimeout(timer);
    pairButton.disabled = false;
  }
});

async function refreshOrigins() {
  const result = await browser.runtime.sendMessage({ type: 'granted-origins' });
  const origins = result?.origins || [];
  originList.replaceChildren();
  if (!origins.length) {
    const item = document.createElement('li');
    item.textContent = tr('library.noSites');
    originList.appendChild(item);
    return;
  }
  for (const origin of origins) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = tr('options.remove');
    remove.addEventListener('click', async () => {
      await browser.runtime.sendMessage({ type: 'forget-origin', origin });
      originStatus.textContent = tr('options.permissionRemoved', {origin});
      refreshOrigins();
    });
    item.append(label, remove);
    originList.appendChild(item);
  }
}

// permissions.request must run inside a user gesture on an extension page, so
// the panel links here instead of asking for the permission from the site.
async function request(origins, descriptionKey) {
  try {
    const granted = await browser.permissions.request({ origins });
    originStatus.textContent = granted
      ? tr('options.permissionGranted', {description: tr(descriptionKey)})
      : tr('options.permissionDenied');
    refreshOrigins();
  } catch (error) {
    originStatus.textContent = tr('status.operationError');
  }
}

const requested = decodeURIComponent(location.hash.slice(1));
if (ORIGIN_PATTERN.test(requested)) {
  const button = document.querySelector('#allow-origin');
  button.textContent = `${tr('options.authorize')} ${requested}`;
  button.addEventListener('click', () => request([requested], 'options.site'));
  document.querySelector('#origin-request').hidden = false;
}

document.querySelector('#allow-all').addEventListener('click', () =>
  request(ALL_SITES, 'options.allSites')
);

languageReady.then(() => refreshOrigins()).catch(() => {
  originStatus.textContent = tr('status.operationError');
});

window.addEventListener('pagehide', removeLanguageListener, {once: true});
