(function () {
  const REPORT_ENDPOINT = window.__NOTIFY_ENDPOINT__;
  if (!REPORT_ENDPOINT) return;

  const TARGET_TIMEOUT_MS = 3500;   // 每个目标请求最多等待 3.5 秒
  const PAGE_WATCHDOG_MS = 10000;   // 整页 10 秒还没跳转就兜底通知

  const state = {
    urls: [],
    urlSet: new Set(),
    results: new Map(),
    hasSuccess: false,
    reportSent: false,
    configLoaded: false,
    watchdogStarted: false,
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__monitor = {
      method: String(method || ""),
      rawUrl: String(url || ""),
      absUrl: safeAbsoluteUrl(url),
      startedAt: 0,
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const meta = this.__monitor || {};
    meta.startedAt = Date.now();

    // 给目标线路请求强制加超时，避免一直卡住
    if (state.configLoaded && state.urlSet.has(meta.absUrl)) {
      if (!this.timeout || this.timeout === 0) {
        this.timeout = TARGET_TIMEOUT_MS;
      }
    }

    this.addEventListener("load", () => handleXhrResult(this, "load"));
    this.addEventListener("error", () => handleXhrResult(this, "error"));
    this.addEventListener("timeout", () => handleXhrResult(this, "timeout"));
    this.addEventListener("abort", () => handleXhrResult(this, "abort"));

    return originalSend.apply(this, arguments);
  };

  function handleXhrResult(xhr, eventName) {
    const meta = xhr.__monitor || {};
    const absUrl = meta.absUrl || "";

    // 先抓 config.json，拿目标列表
    if (isConfigRequest(absUrl) && eventName === "load") {
      tryParseConfig(xhr);
      return;
    }

    if (!state.configLoaded) return;
    if (!state.urlSet.has(absUrl)) return;

    const elapsed = meta.startedAt ? Date.now() - meta.startedAt : "";
    const result = classify(xhr, eventName);

    state.results.set(absUrl, {
      url: absUrl,
      browser_result: result.browser_result,
      browser_http_status: result.browser_http_status,
      browser_elapsed_ms: elapsed,
    });

    // 一旦任意目标成功，就视为即将跳转，不再通知
    if (result.browser_result === "ok") {
      state.hasSuccess = true;
    }

    maybeReportAllFailed();
  }

  function tryParseConfig(xhr) {
    if (xhr.status < 200 || xhr.status >= 300) return;

    try {
      const config = JSON.parse(xhr.responseText || "{}");
      const urls = Array.isArray(config.urls) ? config.urls : [];

      const decoded = urls
        .map(decodeMaybeBase64)
        .map(safeAbsoluteUrl)
        .filter(Boolean);

      state.urls = decoded;
      state.urlSet = new Set(decoded);
      state.configLoaded = true;

      startWatchdog();
    } catch (err) {
      console.error("monitor parse config failed:", err);
    }
  }

  function startWatchdog() {
    if (state.watchdogStarted) return;
    state.watchdogStarted = true;

    setTimeout(() => {
      if (state.hasSuccess || state.reportSent) return;
      if (!state.configLoaded) return;

      const targets = state.urls.map((url) => {
        return state.results.get(url) || {
          url,
          browser_result: "pending_or_timeout",
          browser_http_status: "",
          browser_elapsed_ms: "",
        };
      });

      state.reportSent = true;

      sendPayload({
        event: "page_watchdog_timeout",
        reason: "no_redirect_within_10s",
        page: location.href,
        referrer: document.referrer || "",
        ua: navigator.userAgent || "",
        lang: navigator.language || "",
        title: document.title || "",
        targets,
      });
    }, PAGE_WATCHDOG_MS);
  }

  function maybeReportAllFailed() {
    if (state.reportSent) return;
    if (state.hasSuccess) return;
    if (!state.configLoaded) return;
    if (state.urlSet.size === 0) return;

    // 只有当每个目标都已经有结果了，才判断“全部失败”
    if (state.results.size < state.urlSet.size) return;

    const targets = state.urls.map((url) => {
      return state.results.get(url) || {
        url,
        browser_result: "unknown",
        browser_http_status: "",
        browser_elapsed_ms: "",
      };
    });

    const allFailed = targets.every((t) => t.browser_result !== "ok");
    if (!allFailed) return;

    state.reportSent = true;

    sendPayload({
      event: "all_routes_failed",
      reason: "all_targets_failed",
      page: location.href,
      referrer: document.referrer || "",
      ua: navigator.userAgent || "",
      lang: navigator.language || "",
      title: document.title || "",
      targets,
    });
  }

  function sendPayload(payload) {
    const text = JSON.stringify(payload);

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([text], { type: "application/json" });
        const ok = navigator.sendBeacon(REPORT_ENDPOINT, blob);
        if (ok) return;
      }
    } catch (err) {
      console.error("sendBeacon failed:", err);
    }

    fetch(REPORT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: text,
      mode: "cors",
      keepalive: true,
    }).catch((err) => {
      console.error("notify fetch failed:", err);
    });
  }

  function classify(xhr, eventName) {
    if (eventName === "load") {
      const status = Number(xhr.status || 0);

      if (status >= 200 && status < 400) {
        return {
          browser_result: "ok",
          browser_http_status: status,
        };
      }

      return {
        browser_result: `http_${status || 0}`,
        browser_http_status: status || "",
      };
    }

    if (eventName === "timeout") {
      return {
        browser_result: "timeout",
        browser_http_status: "",
      };
    }

    if (eventName === "abort") {
      return {
        browser_result: "aborted",
        browser_http_status: "",
      };
    }

    return {
      browser_result: "network_or_cors_blocked",
      browser_http_status: "",
    };
  }

  function isConfigRequest(absUrl) {
    try {
      const u = new URL(absUrl);
      return u.origin === location.origin && u.pathname === "/config.json";
    } catch {
      return false;
    }
  }

  function decodeMaybeBase64(value) {
    if (typeof value !== "string") return "";
    try {
      const decoded = atob(value);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch (_) {}
    return value;
  }

  function safeAbsoluteUrl(url) {
    try {
      return new URL(String(url), location.href).toString();
    } catch {
      return "";
    }
  }
})();
