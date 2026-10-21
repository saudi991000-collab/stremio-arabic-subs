import { logger } from "../logger.js";
import { deepFreeze } from "../store.js";

function failureStatus(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || /timeout|aborted/i.test(error?.message || "")) return "timeout";
  return "error";
}

export class MultiProvider {
  constructor(providers, { providerTimeoutMs = 8000 } = {}) {
    this.providers = providers;
    this.byId = new Map(providers.map((provider) => [provider.id, provider]));
    this.names = providers.map((provider) => provider.id);
    this.providerTimeoutMs = providerTimeoutMs;
  }

  /**
   * Searches every provider in parallel. Each provider has its own
   * AbortController and hard timeout, so one slow source cannot hold the
   * others back or keep sockets open forever.
   *
   * Returns an immutable snapshot once all providers answered or `timeoutMs`
   * elapsed. Providers still running at that point keep going until their own
   * timeout; their results are delivered through `onLate` as a separate
   * snapshot instead of mutating the array that was already returned.
   */
  async searchSnapshot(context, maxPages, timeoutMs = 0, { onLate, providerTimeoutMs = this.providerTimeoutMs } = {}) {
    const started = Date.now();
    const providers = {};
    const candidates = [];
    let responded = false;
    const late = { candidates: [], providers: {} };
    let lateTimer;

    const flushLate = () => {
      lateTimer = undefined;
      if (!late.candidates.length && !Object.keys(late.providers).length) return;
      const snapshot = deepFreeze({ candidates: late.candidates.splice(0), providers: { ...late.providers }, complete: false });
      for (const key of Object.keys(late.providers)) delete late.providers[key];
      onLate?.(snapshot);
    };

    const runs = this.providers.map(async (provider) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("provider timeout", "TimeoutError")), providerTimeoutMs);
      timer.unref?.();
      const providerStarted = Date.now();
      let status;
      let found = [];
      try {
        const value = await provider.search(context, maxPages, { signal: controller.signal });
        found = (Array.isArray(value) ? value : []).map((candidate) => deepFreeze({ ...candidate, provider: candidate.provider || provider.id }));
        status = { status: found.length ? "ok" : "empty", count: found.length, ms: Date.now() - providerStarted, at: Date.now() };
      } catch (error) {
        status = { status: controller.signal.aborted ? "timeout" : failureStatus(error), count: 0, ms: Date.now() - providerStarted, at: Date.now(), reason: String(error?.message || error).slice(0, 160) };
        logger.warn("subtitle provider search failed", { provider: provider.id, status: status.status, reason: status.reason });
      } finally {
        clearTimeout(timer);
      }
      if (!responded) {
        providers[provider.id] = status;
        candidates.push(...found);
      } else {
        late.providers[provider.id] = status;
        late.candidates.push(...found);
        // Batch late arrivals so the cache is rewritten a few times, not once
        // per provider.
        if (!lateTimer) {
          lateTimer = setTimeout(flushLate, 50);
          lateTimer.unref?.();
        }
      }
    });

    const all = Promise.allSettled(runs);
    if (timeoutMs > 0) {
      let deadline;
      await Promise.race([all, new Promise((resolve) => { deadline = setTimeout(resolve, timeoutMs); })]);
      clearTimeout(deadline);
    } else {
      await all;
    }
    responded = true;
    for (const provider of this.providers) {
      if (!providers[provider.id]) providers[provider.id] = { status: "partial", count: 0, ms: Date.now() - started, at: Date.now(), pending: true };
    }
    const pending = Object.values(providers).some((status) => status.pending);
    if (pending) {
      logger.warn("subtitle provider search deadline reached", {
        pending: Object.entries(providers).filter(([, status]) => status.pending).map(([id]) => id),
        timeoutMs
      });
      all.then(() => {
        clearTimeout(lateTimer);
        flushLate();
      });
    }
    const complete = Object.values(providers).every((status) => status.status === "ok" || status.status === "empty");
    return deepFreeze({ candidates: [...candidates], providers: { ...providers }, complete });
  }

  // Backwards-compatible array API used by scripts and older tests.
  async search(context, maxPages, timeoutMs = 0) {
    const snapshot = await this.searchSnapshot(context, maxPages, timeoutMs);
    const failures = Object.values(snapshot.providers).filter((status) => status.status === "error" || status.status === "timeout").length;
    if (!snapshot.candidates.length && this.providers.length && failures === this.providers.length) {
      throw new Error("All configured subtitle providers failed");
    }
    return snapshot.candidates;
  }

  async warm() {
    await Promise.allSettled(this.providers.map((provider) => provider.warm?.()));
  }

  async download(item, options = {}) {
    const provider = this.byId.get(item.provider);
    if (!provider) throw new Error(`Unknown subtitle provider: ${item.provider}`);
    return provider.download(item.ref, options);
  }

  async findTimingReference(context, options = {}) {
    for (const id of ["opensubtitles", "opensubtitles-org"]) {
      const provider = this.byId.get(id);
      if (typeof provider?.findTimingReference !== "function") continue;
      const found = await provider.findTimingReference(context, options).catch(() => null);
      if (found) return found;
    }
    return null;
  }
}
