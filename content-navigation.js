(() => {
  if (globalThis.NovelLocalReader?.contentNavigation) return;
  const root = globalThis.NovelLocalReader || (globalThis.NovelLocalReader = Object.create(null));

  function create({
    document = globalThis.document,
    panel = null,
    normalizeText = value => String(value || '').trim().replace(/\s+/g, ' '),
    looksLikeNavigationText = () => false,
    isOriginAllowed = async () => false,
    getStyle = globalThis.getComputedStyle,
    location = globalThis.location,
    scheduler = globalThis
    , storage = null
    , navigate = async () => undefined
    , currentUrl = () => location.href
  } = {}) {
    let nextTimer = null;
    let continuationTimer = null;
    let nextOperation = 0;
    let continuationOperation = 0;
    let disposed = false;
    const safe = callback => { try { callback?.(); } catch { /* callbacks are isolated */ } };
    const cancel = kind => {
      const timer = kind === 'next' ? nextTimer : continuationTimer;
      if (timer !== null) scheduler.clearTimeout(timer);
      if (kind === 'next') { nextTimer = null; nextOperation += 1; }
      else { continuationTimer = null; continuationOperation += 1; }
    };
    const validHandoff = value => value && typeof value === 'object' &&
      typeof value.targetUrl === 'string' && typeof value.origin === 'string' &&
      Number.isFinite(value.expiresAt);
    const targetStillValid = target => {
      if (!target?.available || typeof target.url !== 'string') return false;
      // A <button> target has no URL; it stays valid while it is in the page.
      if (!target.url) return target.element?.tagName === 'BUTTON' && target.element.isConnected !== false;
      try {
        const parsed = new URL(target.url, location.href);
        if (!/^https?:$/.test(parsed.protocol)) return false;
        if (target.element && ('isConnected' in target.element) &&
            (!target.element.isConnected || target.element.href !== target.url)) return false;
        return true;
      } catch { return false; }
    };
    const usable = element => {
      if (!element || panel?.contains?.(element)) return false;
      if (element.tagName === 'LINK' && element.href) {
        return /^https?:$/.test(new URL(element.href, location.href).protocol);
      }
      // A disabled "next" (the last chapter) must not become a target that does nothing.
      if (element.disabled === true || element.getAttribute?.('aria-disabled') === 'true') return false;
      const style = getStyle?.(element);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
      if (!element.href) return element.tagName === 'BUTTON';
      const url = new URL(element.href, location.href);
      return /^https?:$/.test(url.protocol) && url.href !== location.href;
    };
    const score = element => {
      if (!usable(element)) return -100;
      const label = normalizeText([
        element.innerText, element.getAttribute?.('aria-label'), element.getAttribute?.('title'),
        element.id, element.className
      ].filter(Boolean).join(' ')).toLocaleLowerCase();
      if (/\b(previous|prev|anterior|back|voltar|chapter list|lista de capítulos|comments?)\b/.test(label)) return -100;
      let value = 0;
      const fullNext = new RegExp(
        '\\b(next chapter|next chap|próximo capítulo|proximo capitulo|' +
        'capítulo seguinte|capitulo seguinte)\\b'
      );
      if (fullNext.test(label)) {
        value += 80;
      }
      else if (/\b(next|próximo|proximo|seguinte)\b/.test(label)) value += 35;
      if (/\b(chapter|capítulo|capitulo)\b/.test(label)) value += 20;
      if (/\bnext\b/.test(`${element.id} ${element.className}`.toLowerCase())) value += 25;
      return value;
    };
    const query = (selector, rootNode = document) => {
      if (!selector) return null;
      try { return rootNode.querySelector(selector); } catch { return null; }
    };
    // A <button> has no href: navigation clicks it instead of assigning a
    // "<page>/undefined" address.
    const resolved = (element, source) => ({
      available: true,
      url: element.href ? new URL(element.href, location.href).href : '',
      element,
      source
    });
    const target = ({siteSelector = '', globalSelector = ''} = {}) => {
      const selectors = [siteSelector, globalSelector].filter(Boolean);
      for (const selector of selectors) {
        const candidate = query(selector);
        if (usable(candidate)) {
          return resolved(candidate, selector === siteSelector ? 'site-selector' : 'global-selector');
        }
      }
      const related = document.querySelector("a[rel~='next'], link[rel~='next']");
      if (usable(related)) return resolved(related, 'rel-next');
      const candidate = [...document.querySelectorAll('a[href], button')]
        .map(element => ({element, score: score(element)})).filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.element;
      if (candidate) return resolved(candidate, 'text');
      return {available: false, url: '', element: null, source: null};
    };
    const findInDocument = (rootDocument, baseUrl, {siteSelector = '', globalSelector = ''} = {}) => {
      const configured = query(siteSelector || globalSelector, rootDocument);
      const related = rootDocument.querySelector("a[rel~='next'], link[rel~='next']");
      const direct = configured?.getAttribute('href') || related?.getAttribute('href');
      if (direct) return new URL(direct, baseUrl).href;
      const candidate = [...rootDocument.querySelectorAll('a[href]')].map(element => {
        const label = normalizeText(
          `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.className}`
        ).toLocaleLowerCase();
        let value = 0;
        if (/next chapter|próximo capítulo|capítulo seguinte|proximo capitulo/.test(label)) value += 80;
        else if (/\bnext\b|\bpróximo\b|\bseguinte\b/.test(label)) value += 30;
        if (/previous|anterior|prev/.test(label)) value -= 100;
        return {element, value};
      }).sort((a, b) => b.value - a.value)[0];
      return candidate?.value > 0 ? new URL(candidate.element.getAttribute('href'), baseUrl).href : '';
    };
    return Object.freeze({
      findNext: target,
      findNextInDocument: findInDocument,
      checkPermission: async (origin, expected, valid = () => true) => {
        if (!valid(expected)) return {allowed: false, stale: true};
        try { return {allowed: Boolean(await isOriginAllowed(origin)), stale: !valid(expected)}; }
        catch { return {allowed: false, error: true, stale: !valid(expected)}; }
      },
      scheduleNext({token, delayMs, target, isValid = () => true, onDue} = {}) {
        cancel('next');
        if (disposed) return;
        nextTimer = scheduler.setTimeout(() => {
          nextTimer = null;
          if (!disposed && isValid(token)) safe(() => onDue?.(target, token));
        }, delayMs);
      },
      scheduleNextChapter({token, delayMs, target, origin, expiresAt, isValid = () => true} = {}) {
        cancel('next');
        if (disposed) return;
        const operation = nextOperation;
        nextTimer = scheduler.setTimeout(async () => {
          nextTimer = null;
          if (disposed || operation !== nextOperation || !isValid(token) || !target?.available) return;
          // Never leave a handoff behind for a target that is already gone.
          if (!targetStillValid(target)) return;
          // fromUrl lets a click-through (no URL) be told apart from a page that merely loads later.
          const handoff = {targetUrl: target.url || '', origin, fromUrl: currentUrl(), expiresAt};
          const discard = () => { try { return storage?.removeAutoContinue?.(); } catch { return undefined; } };
          try {
            await storage?.writeAutoContinue?.(handoff);
            if (!disposed && operation === nextOperation && isValid(token) && targetStillValid(target)) {
              await navigate(target);
            } else {
              await discard();
            }
          } catch { await discard(); /* failed handoff never navigates */ }
        }, delayMs);
      },
      cancelNext() { cancel('next'); },
      scheduleContinuation({token, delayMs, handoff, isValid = () => true, onDue} = {}) {
        cancel('continuation');
        if (disposed) return;
        continuationTimer = scheduler.setTimeout(() => {
          continuationTimer = null;
          if (!disposed && isValid(token)) safe(() => onDue?.(handoff, token));
        }, delayMs);
      },
      async resumeContinuation({token, delayMs = 700, isValid = () => true, onContinue} = {}) {
        const request = await storage?.readAutoContinue?.();
        if (!validHandoff(request) || request.expiresAt < Date.now()) {
          if (request) await storage?.removeAutoContinue?.();
          return false;
        }
        const target = new URL(currentUrl());
        if (request.origin !== target.origin) return false;
        if (request.targetUrl) {
          if (request.targetUrl !== target.href) return false;
        } else if (!request.fromUrl || request.fromUrl === target.href) {
          // A click-through handoff has no URL to compare: accept it only on a different page.
          return false;
        }
        await storage?.removeAutoContinue?.();
        cancel('continuation');
        if (disposed || !isValid(token)) return false;
        const operation = continuationOperation;
        continuationTimer = scheduler.setTimeout(() => {
          continuationTimer = null;
          if (!disposed && operation === continuationOperation && isValid(token)) {
            safe(() => onContinue?.(request, token));
          }
        }, delayMs);
        return true;
      },
      cancelHandoff() { return storage?.removeAutoContinue?.(); },
      cancelContinuation() { cancel('continuation'); },
      cancelAll() { cancel('next'); cancel('continuation'); },
      dispose() { if (disposed) return; disposed = true; cancel('next'); cancel('continuation'); },
      looksLikeNavigationText
    });
  }
  root.contentNavigation = Object.freeze({create});
})();
