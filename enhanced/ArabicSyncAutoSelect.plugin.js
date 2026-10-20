/**
 * @name Arabic SyncRank Companion
 * @description Pins Arabic SyncRank first and links local playback for accurate subtitle timing.
 * @updateUrl none
 * @version 0.7.1
 * @author Local
 */

(() => {
  "use strict";
  const api = window.StremioEnhancedAPI;
  const ADDON_ID = "com.arabicsyncrank.subtitles";
  const ORDER_BACKUP_KEY = "arabic-syncrank-addon-order-backup-v1";
  const state = { lastMedia: "", capturedStream: "", busy: false, observer: null };
  const LOCAL_COMPANION = "http://127.0.0.1:7000/companion/session";

  function log(message) {
    api?.logger?.info?.(`[Arabic SyncRank] ${message}`);
    console.info(`[Arabic SyncRank] ${message}`);
  }

  async function settings() {
    if (!api?.getSetting) return { enabled: false, delay: 1600, pinFirst: true };
    return {
      enabled: (await api.getSetting("arabic_sync_enabled")) ?? false,
      delay: Number((await api.getSetting("arabic_sync_delay")) ?? 1600),
      pinFirst: (await api.getSetting("arabic_sync_pin_first")) ?? true
    };
  }

  function profile() {
    try { return JSON.parse(localStorage.getItem("profile")); }
    catch { return null; }
  }

  async function pinAddonFirst() {
    const options = await settings();
    if (!options.pinFirst) return;
    const current = profile();
    if (!current?.addons?.length) return;
    const index = current.addons.findIndex((addon) => addon?.manifest?.id === ADDON_ID);
    if (index <= 0) return;
    if (!localStorage.getItem(ORDER_BACKUP_KEY)) {
      localStorage.setItem(ORDER_BACKUP_KEY, JSON.stringify(current.addons.map((addon) => ({
        id: addon?.manifest?.id,
        transportUrl: addon?.transportUrl
      }))));
    }
    const next = [...current.addons];
    const [ours] = next.splice(index, 1);
    next.unshift(ours);
    current.addons = next;
    localStorage.setItem("profile", JSON.stringify(current));
    if (!current.auth?.key) {
      log("Moved the addon first locally; sign in to sync this order to other devices.");
      return;
    }
    const response = await fetch("https://api.strem.io/api/addonCollectionSet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "AddonCollectionSet", authKey: current.auth.key, addons: next })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.result?.success) throw new Error(payload?.error || "Addon order sync failed");
    log("Pinned the addon first and synced the order to the Stremio account.");
  }

  function visible(element) {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function subtitleRows() {
    const nodes = [...document.querySelectorAll("button,[role=option],[role=menuitem],li")];
    return nodes
      .filter(visible)
      .map((element) => {
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const percent = Number(text.match(/(\d{1,3})\s*%/)?.[1] || 0);
        const addonMatch = /Arabic\s*SyncRank/i.test(text);
        const score = (text.includes("👍") ? 100000 : 0) + (text.includes("💪") ? 10000 : 0) + percent;
        return { element, text, percent, addonMatch, score };
      })
      .filter((item) => item.addonMatch && item.percent > 0)
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  }

  function subtitleButton() {
    return [...document.querySelectorAll("button")].find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.textContent || ""}`;
      return /subtitle|captions|ترجم/i.test(label) && visible(button);
    });
  }

  function currentStreamUrl() {
    if (state.capturedStream) return state.capturedStream;
    const video = document.querySelector("video");
    const direct = [video?.currentSrc, video?.src].find((value) => /^http:\/\/(?:127\.0\.0\.1|localhost):11470\//i.test(value || ""));
    if (direct) return direct;
    const entries = performance.getEntriesByType("resource").map((entry) => entry.name).reverse();
    return entries.find((value) => /^http:\/\/(?:127\.0\.0\.1|localhost):11470\//i.test(value || ""));
  }

  async function registerCurrentStream() {
    const video = document.querySelector("video");
    const streamUrl = currentStreamUrl();
    if (!streamUrl) return;
    await fetch(LOCAL_COMPANION, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streamUrl, duration: video?.duration, playbackTime: video?.currentTime, title: document.title })
    }).catch(() => null);
  }

  function captureStream(value) {
    const url = typeof value === "string" ? value : value?.url || value?.href || "";
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):11470\/hlsv2\/[^/]+\/master\.m3u8/i.test(url)) return;
    state.capturedStream = url;
    registerCurrentStream();
  }

  function installNetworkCapture() {
    const nativeFetch = window.fetch;
    window.fetch = function(input, ...args) {
      captureStream(typeof input === "string" ? input : input?.url);
      return nativeFetch.call(this, input, ...args);
    };
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      captureStream(url);
      return nativeOpen.call(this, method, url, ...args);
    };
    try {
      new PerformanceObserver((list) => list.getEntries().forEach((entry) => captureStream(entry.name)))
        .observe({ type: "resource", buffered: true });
    } catch {}
  }

  async function attempt() {
    if (state.busy || !document.querySelector("video")) return;
    await registerCurrentStream();
    const current = document.querySelector("video")?.currentSrc || location.href;
    if (current === state.lastMedia) return;
    const options = await settings();
    if (!options.enabled) return;
    state.busy = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delay));
      let best = subtitleRows()[0];
      if (!best) {
        subtitleButton()?.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        best = subtitleRows()[0];
      }
      if (best) {
        best.element.click();
        state.lastMedia = current;
        log(`Selected ${best.text}`);
      }
    } finally {
      state.busy = false;
    }
  }

  async function start() {
    installNetworkCapture();
    if (api?.registerSettings) {
      try {
        await api.registerSettings([
          { key: "arabic_sync_enabled", type: "toggle", label: "Arabic subtitle auto-select", description: "Optional. Leave off to choose manually from the ranked choices.", defaultValue: false },
          { key: "arabic_sync_pin_first", type: "toggle", label: "Keep addon first", description: "Sync Arabic SyncRank as the first addon in your Stremio account.", defaultValue: true },
          { key: "arabic_sync_delay", type: "input", label: "Selection delay (ms)", description: "Wait for deep subtitle analysis to finish.", defaultValue: "1600" }
        ]);
      } catch (error) {
        console.warn(`[Arabic SyncRank] Settings UI unavailable: ${error.message}`);
      }
    }
    await pinAddonFirst();
    state.observer = new MutationObserver(() => attempt());
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(registerCurrentStream, 2000);
    attempt();
  }

  start().catch((error) => console.error(`[Arabic SyncRank] ${error.message}`, error));
})();
