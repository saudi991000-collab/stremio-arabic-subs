import { logger } from "../logger.js";

export class MultiProvider {
  constructor(providers) {
    this.providers = providers;
    this.byId = new Map(providers.map((provider) => [provider.id, provider]));
    this.names = providers.map((provider) => provider.id);
  }

  async search(context, maxPages, timeoutMs = 0) {
    const results = [];
    let failures = 0;
    let finished = 0;
    const searches = this.providers.map(async (provider) => {
      try {
        const value = await provider.search(context, maxPages);
        results.push(...value.map((candidate) => ({ ...candidate, provider: candidate.provider || provider.id })));
      } catch (error) {
        failures += 1;
        logger.warn("subtitle provider search failed", { provider: provider.id, reason: error?.message || String(error) });
      } finally {
        finished += 1;
      }
    });
    if (timeoutMs > 0) {
      await Promise.race([
        Promise.allSettled(searches),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    } else {
      await Promise.allSettled(searches);
    }
    if (!results.length && this.providers.length && finished === this.providers.length && failures === this.providers.length) {
      throw new Error("All configured subtitle providers failed");
    }
    if (finished < this.providers.length) {
      logger.warn("subtitle provider search deadline reached", { finished, total: this.providers.length, timeoutMs });
    }
    return results;
  }

  async download(item) {
    const provider = this.byId.get(item.provider);
    if (!provider) throw new Error(`Unknown subtitle provider: ${item.provider}`);
    return provider.download(item.ref);
  }

  async findTimingReference(context) {
    const provider = this.byId.get("opensubtitles");
    return typeof provider?.findTimingReference === "function" ? provider.findTimingReference(context) : null;
  }

}
