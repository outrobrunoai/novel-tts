(() => {
  if (globalThis.NovelLocalReader?.contentDocument) return;
  const root = globalThis.NovelLocalReader ||
    (globalThis.NovelLocalReader = Object.create(null));

  const normalizeText = value => String(value || '').replace(/\s+/gu, ' ').trim();
  const navigationPattern = new RegExp(
    '^(previous|next|prev|próximo|anterior|índice|index|table of contents|' +
    'chapter list|lista de capítulos|next chapter|previous chapter|' +
    'próximo capítulo|capítulo anterior)\\b', 'i'
  );
  const looksLikeNavigationText = text => {
    const compact = normalizeText(text).toLocaleLowerCase();
    if (compact.length > 140) return false;
    return navigationPattern.test(compact);
  };
  const splitLongSentence = (sentence, maxLength) => {
    const chunks = [];
    let current = '';
    for (const word of sentence.split(/\s+/)) {
      const combined = current ? `${current} ${word}` : word;
      if (combined.length > maxLength && current) {
        chunks.push(current);
        current = word;
      } else current = combined;
    }
    if (current) chunks.push(current);
    return chunks;
  };
  const splitText = (text, maxLength = 650) => {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const result = [];
    for (const block of normalized.split(/\n{2,}/).map(normalizeText).filter(Boolean)) {
      if (block.length <= maxLength) {
        result.push(block);
        continue;
      }
      const sentences = block.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g) || [block];
      let current = '';
      for (const raw of sentences) {
        const sentence = normalizeText(raw);
        if (!sentence) continue;
        if (sentence.length > maxLength) {
          if (current) result.push(current);
          current = '';
          result.push(...splitLongSentence(sentence, maxLength));
          continue;
        }
        const combined = current ? `${current} ${sentence}` : sentence;
        if (combined.length > maxLength && current) {
          result.push(current);
          current = sentence;
        } else current = combined;
      }
      if (current) result.push(current);
    }
    return result;
  };
  const mergeShortEntries = (entries, limit) => {
    const result = [];
    let pending = null;
    for (const entry of entries) {
      if (entry.text.length > limit) {
        if (pending) result.push(pending);
        pending = null;
        result.push({...entry});
        continue;
      }
      if (!pending) {
        pending = {...entry};
        continue;
      }
      const combined = `${pending.text}\n${entry.text}`;
      if (combined.length <= 320) pending = {text: combined, element: pending.element};
      else {
        result.push(pending);
        pending = {...entry};
      }
    }
    if (pending) result.push(pending);
    return result;
  };
  const safeQuery = (rootNode, selector) => {
    try { return rootNode.querySelector(selector); } catch { return null; }
  };
  const safeQueryAll = (rootNode, selector) => {
    try { return rootNode.querySelectorAll(selector); } catch { return []; }
  };
  const createSnapshot = entries => {
    const frozen = entries.map(entry => Object.freeze({
      text: String(entry.text), element: entry.element || null
    }));
    const snapshot = {entries: Object.freeze(frozen)};
    Object.defineProperty(snapshot, 'length', {
      enumerable: true, get: () => snapshot.entries.length
    });
    return Object.freeze(snapshot);
  };
  const readable = (element, {
    ignoreSelector = '', excludedRoot = null, getStyle = globalThis.getComputedStyle
  } = {}) => {
    if (!element || element === excludedRoot || excludedRoot?.contains?.(element)) return false;
    if (ignoreSelector && element.closest?.(ignoreSelector)) return false;
    const excluded = 'nav, header, footer, aside, form, dialog, [aria-hidden="true"], ' +
      '.comments, .comment, .navigation, .menu, .sidebar, .breadcrumb, .pagination, ' +
      '.chapter-nav, .chapter-navigation, .social, .share, .author-note, .translator-note, ' +
      '.ads, .advertisement, [class*="advert"], [id*="advert"], [class*="comment"], [id*="comment"]';
    if (element.closest?.(excluded)) return false;
    const style = getStyle?.(element) || {};
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const text = normalizeText(element.innerText ?? element.textContent);
    return /[\p{L}\p{N}]/u.test(text) && !looksLikeNavigationText(text);
  };
  const createPageSnapshot = ({
    document, contentSelector = '', ignoreSelector = '', excludedRoot = null,
    getStyle = globalThis.getComputedStyle
  } = {}) => {
    const selectors = [contentSelector, 'article', 'main', "[role='main']", '.chapter-content',
      '.chapter-content-container', '.entry-content', '.reading-content', '.chapter-text',
      '.chapter-body', '.novel-content', '.reader-content', '.text-left', '#chapter-container',
      '#chapter-content', '#chr-content'].filter(Boolean);
    const candidates = [...new Set(selectors.flatMap(selector => [...safeQueryAll(document, selector)]))]
      .filter(candidate => candidate !== excludedRoot && !excludedRoot?.contains?.(candidate));
    const scored = candidates.map(candidate => ({
      candidate,
      score: [...candidate.querySelectorAll('p')].reduce((total, paragraph) =>
        total + (readable(paragraph, {ignoreSelector, excludedRoot, getStyle})
          ? normalizeText(paragraph.innerText ?? paragraph.textContent).length : 0), 0)
    })).sort((a, b) => b.score - a.score);
    const rootNode = safeQuery(document, contentSelector) ||
      scored.find(item => item.score >= 100)?.candidate || document.body;
    const paragraphs = [...rootNode.querySelectorAll('p')]
      .filter(element => readable(element, {ignoreSelector, excludedRoot, getStyle}));
    if (!paragraphs.length) {
      return createSnapshot(splitText(rootNode.innerText ?? rootNode.textContent)
        .filter(text => text.length >= 20).map(text => ({text, element: rootNode})));
    }
    const entries = [];
    let previous = '';
    for (const paragraph of paragraphs) {
      const text = normalizeText(paragraph.innerText ?? paragraph.textContent);
      if (text === previous || looksLikeNavigationText(text)) continue;
      previous = text;
      for (const chunk of splitText(text)) entries.push({text: chunk, element: paragraph});
    }
    return createSnapshot(entries);
  };
  const createSelectionSnapshot = (selection, maxLength = 650) =>
    createSnapshot(splitText(selection?.toString?.() || '', maxLength)
      .map(text => ({text, element: null})));
  root.contentDocument = Object.freeze({normalizeText, splitText, splitLongSentence,
    mergeShortEntries, isReadableParagraph: readable, createPageSnapshot,
    createSelectionSnapshot, createSnapshot, looksLikeNavigationText});
})();
