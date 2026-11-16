import { logger } from "../logger.js";
import { deepFreeze } from "../store.js";

function failureStatus(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || /timeout|aborted/i.test(error?.message || "")) return "timeout";
  return "error";
}

export class MultiProvider {
  constructor(providers, { providerTimeoutMs = 8000, circuitThreshold = 2, circuitCooldownMs = 30 * 60 * 1000 } = {}) {
    this.providers = providers;
    this.byId = new Map(providers.map((provider) => [provider.id, provider]));
    this.names = providers.map((provider) => provider.id);
    this.providerTimeoutMs = providerTimeoutMs;
    this.circuitThreshold = circuitThreshold;
    this.circuitCooldownMs = circuitCooldownMs;
    this.circuits = new Map();
  }

  #isCircuitOpen(providerId) {
    const entry = this.circuits.get(providerId);
    if (!entry) return false;
    if (entry.until && Date.now() < entry.until) return true;
    if (entry.until && Date.now() >= entry.until) this.circuits.delete(providerId);
    return false;
  }

  #recordSuccess(providerId) {
    this.circuits.delete(providerId);
  }

  #recordFailure(providerId, error) {
    const message = String(error?.message || error || "");
    const hardBlock = error?.status === 403 || error?.status === 500 || /HTTP (?:403|500)/.test(message);
    const current = this.circuits.get(providerId) || { failures: 0, until: 0 };
    const failures = current.failures + 1;
    const threshold = hardBlock ? this.circuitThreshold : Math.max(this.circuitThreshold + 1, 3);
    const until = failures >= threshold ? Date.now() + this.circuitCooldownMs : 0;
    this.circuits.set(providerId, { failures, until, reason: message.slice(0, 80) });
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
  async searchSnapshot(context, maxPages, timeoutMs = 0, { onLate, providerTimeoutMs = this.providerTimeoutMs, earlyMinCandidates = 0, earlyAfterMs = 2500 } = {}) {
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
      if (this.#isCircuitOpen(provider.id)) {
        const reason = this.circuits.get(provider.id)?.reason || "circuit open";
        providers[provider.id] = { status: "skipped", count: 0, ms: 0, at: Date.now(), reason: `circuit:${reason}` };
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("provider timeout", "TimeoutError")), providerTimeoutMs);
      timer.unref?.();
      const providerStarted = Date.now();
      let status;
      let found = [];
      try {
        const value = await provider.search(context, maxPages, { signal: controller.signal });
        this.#recordSuccess(provider.id);
        found = (Array.isArray(value) ? value : []).map((candidate) => deepFreeze({ ...candidate, provider: candidate.provider || provider.id }));
        status = { status: found.length ? "ok" : "empty", count: found.length, ms: Date.now() - providerStarted, at: Date.now() };
      } catch (error) {
        this.#recordFailure(provider.id, error);
        status = { status: controller.signal.aborted ? "timeout" : failureStatus(error), count: 0, ms: Date.now() - providerStarted, at: Date.now(), reason: String(error?.message || error).slice(0, 160) };
        logger.warn("subtitle provider search failed", { provider: provider.id, status: status.status, reason: status.reason });
      } finally {
        clearTimeout(timer);
      }
      if (!responded) {
        providers[provider.id] = status;
        candidates.push(...found);
        maybeEarly();
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

    let earlyResolve;
    const earlyPromise = earlyMinCandidates > 0 && timeoutMs > earlyAfterMs
      ? new Promise((resolve) => { earlyResolve = resolve; })
      : null;
    const maybeEarly = () => {
      if (earlyResolve && !responded && candidates.length >= earlyMinCandidates && Date.now() - started >= earlyAfterMs - 10) {
        earlyResolve();
      }
    };
    let earlyCheckTimer;
    if (earlyPromise) {
      earlyCheckTimer = setTimeout(maybeEarly, earlyAfterMs);
      earlyCheckTimer.unref?.();
    }
    const all = Promise.allSettled(runs);
    if (timeoutMs > 0) {
      let deadline;
      const racers = [all, new Promise((resolve) => { deadline = setTimeout(resolve, timeoutMs); })];
      if (earlyPromise) racers.push(earlyPromise);
      await Promise.race(racers);
      clearTimeout(deadline);
    } else {
      await all;
    }
    clearTimeout(earlyCheckTimer);
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
    const complete = Object.values(providers).every((status) => status.status === "ok" || status.status === "empty" || status.status === "skipped");
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

  // Up to `limit` English references: OpenSubtitles.com gives at most one
  // (its downloads are rationed), OpenSubtitles.org the rest.
  async findTimingReferences(context, options = {}) {
    const limit = Math.max(1, Number(options.limit) || 3);
    const primary = !this.#isCircuitOpen("opensubtitles") ? this.byId.get("opensubtitles") : null;
    const secondary = !this.#isCircuitOpen("opensubtitles-org") ? this.byId.get("opensubtitles-org") : null;
    const subdl = !this.#isCircuitOpen("subdl") ? this.byId.get("subdl") : null;
    const [first, more] = await Promise.all([
      typeof primary?.findTimingReference === "function" ? primary.findTimingReference(context, options).catch((err) => { this.#recordFailure("opensubtitles", err); return null; }) : null,
      typeof secondary?.findTimingReferences === "function"
        ? secondary.findTimingReferences(context, { ...options, limit }).catch((err) => { this.#recordFailure("opensubtitles-org", err); return []; })
        : typeof secondary?.findTimingReference === "function" ? secondary.findTimingReference(context, options).then((one) => one ? [one] : []).catch((err) => { this.#recordFailure("opensubtitles-org", err); return []; }) : []
    ]);
    let extraRefs = [];
    if (subdl && typeof subdl.findTimingReferences === "function" && ((first ? 1 : 0) + more.length) < limit) {
      extraRefs = await subdl.findTimingReferences(context, { ...options, limit: limit - ((first ? 1 : 0) + more.length) }).catch(() => []);
    }
    const rank = (item) => item.timingReferenceKind === "exact-hash" ? 2 : 1;
    const all = [...(first ? [first] : []), ...more, ...extraRefs].sort((a, b) => rank(b) - rank(a));
    const seen = new Set();
    return all.filter((item) => {
      const name = String(item.fileName || item.release || item.fileId).toLowerCase();
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    }).slice(0, limit);
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
