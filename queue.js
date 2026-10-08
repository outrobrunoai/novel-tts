/* Bounded, single-consumer queue. No stale session may enqueue after cancel. */
class SynthesisQueue {
  constructor(worker, limit = 40) {
    this.worker = worker;
    this.limit = limit;
    this.pending = [];
    this.running = null;
    this.closed = new Set();
  }
  enqueue(owner, scope, payload, priority = 0) {
    const group = `${owner}:${scope}`;
    if (this.closed.has(group)) return Promise.reject(new Error('Leitura cancelada.'));
    const key = JSON.stringify([group, payload]);
    const duplicate = [this.running, ...this.pending].find(t => t?.key === key);
    if (duplicate) {
      duplicate.priority = Math.max(priority, duplicate.priority);
      return duplicate.promise;
    }
    if (this.pending.length >= this.limit) return Promise.reject(new Error('Fila cheia. Aguarde ou pare a pré-geração.'));
    const task = { owner, group, key, payload, priority, controller: new AbortController() };
    task.promise = new Promise((resolve, reject) => Object.assign(task, {resolve, reject}));
    this.pending.push(task);
    this.pump();
    return task.promise;
  }
  cancel(owner, scope) {
    const group = `${owner}:${scope}`;
    if (scope !== undefined) this.closed.add(group);
    // Bound tombstones; scope IDs are random and old pages cannot revive jobs.
    if (this.closed.size > 1000) this.closed.delete(this.closed.values().next().value);
    const match = t => t.owner === owner && (scope === undefined || t.group === group);
    for (const t of this.pending.filter(match)) t.reject(new Error('Leitura cancelada.'));
    this.pending = this.pending.filter(t => !match(t));
    if (this.running && match(this.running)) {
      this.running.controller.abort();
      this.running.reject(new Error('Leitura cancelada. A GPU pode concluir o trecho em andamento.'));
    }
  }
  async pump() {
    if (this.running) return;
    while (this.pending.length) {
      this.pending.sort((a,b) => b.priority - a.priority);
      const t = this.pending.shift();
      this.running = t;
      try { t.resolve(await this.worker(t.payload, t.controller.signal)); }
      catch (error) { t.reject(error); }
      finally { this.running = null; }
    }
  }
}
globalThis.SynthesisQueue = SynthesisQueue;
