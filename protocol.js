(() => {
  "use strict";
  const APP_VERSION = "1.0.0";
  const PROTOCOL = Object.freeze({ current: 1, minimum: 1, maximum: 1 });
  const RETRYABLE_CODES = new Set(["UPSTREAM_UNAVAILABLE", "UPSTREAM_TIMEOUT", "UPSTREAM_STARTING"]);
  const LEGACY_CAPABILITIES = Object.freeze({ voice_cloning: true, multiple_voices: false,
    deterministic_seed: true, temperature: true, style_instructions: false,
    cache_warming: false, offline_cache_hits: true });
  function range(value) {
    if (!value || !Number.isInteger(value.current) || !Number.isInteger(value.minimum) ||
      !Number.isInteger(value.maximum) || value.minimum < 1 || value.current < value.minimum ||
      value.current > value.maximum) throw new Error("Resposta de protocolo inválida.");
    return { current: value.current, minimum: value.minimum, maximum: value.maximum };
  }
  function compatible(remote) {
    const value = range(remote);
    return Math.max(PROTOCOL.minimum, value.minimum) <= Math.min(PROTOCOL.maximum, value.maximum);
  }
  function capabilities(data) {
    if (!data || typeof data !== "object" || typeof data.service_version !== "string" ||
      !data.backend || typeof data.backend.name !== "string" || typeof data.backend.variant !== "string" ||
      !data.capabilities || typeof data.capabilities !== "object") throw new Error("Capabilities inválidas.");
    const protocol = range(data.protocol);
    for (const key of Object.keys(LEGACY_CAPABILITIES)) if (typeof data.capabilities[key] !== "boolean") throw new Error("Capabilities inválidas.");
    return { legacy: false, compatible: compatible(protocol), serviceVersion: data.service_version,
      protocol, backend: { name: data.backend.name, variant: data.backend.variant },
      capabilities: Object.fromEntries(Object.keys(LEGACY_CAPABILITIES).map(key => [key, data.capabilities[key]])) };
  }
  function legacy(health = {}) {
    if (!health || typeof health !== "object" || typeof health.version !== "string" ||
      typeof (health.backend || health.mode) !== "string" || health.protocol) throw new Error("Resposta legada inválida.");
    return { legacy: true, compatible: true, serviceVersion: health.version,
    protocol: null, backend: { name: health.backend || "desconhecido", variant: "legado" }, capabilities: {...LEGACY_CAPABILITIES} }; }
  function error(status, raw) {
    let data; try { data = JSON.parse(String(raw).slice(0, 8192)); } catch { data = null; }
    const detail = data?.error;
    if (detail && typeof detail === "object" && typeof detail.code === "string" && typeof detail.message === "string" && typeof detail.retryable === "boolean") {
      return { code: detail.code, message: detail.message.slice(0, 300), retryable: detail.retryable, status };
    }
    return { code: status === 401 ? "AUTH_REQUIRED" : status === 404 ? "ENDPOINT_NOT_FOUND" : "INTERNAL_ERROR",
      message: status === 401 ? "Chave de pareamento inválida. Abra Sistema → Conexão." : "O serviço retornou um erro não reconhecido.", retryable: false, status };
  }
  function shouldRetry(value) { return Boolean(value?.retryable && RETRYABLE_CODES.has(value.code)); }
  globalThis.NovelProtocol = Object.freeze({ APP_VERSION, PROTOCOL, capabilities, legacy, error, shouldRetry });
})();
