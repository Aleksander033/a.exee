(function () {
  "use strict";

  const API_ORIGIN = "https://api.senpa.io";
  const LOCAL_ROOT = new URL("./", document.currentScript.src);
  const nativeFetch = window.fetch.bind(window);
  const nativeOpen = window.open.bind(window);
  let currentToken = null;
  let refreshTimer = null;
  let uiDeliveryTimer = null;
  let observedLegacyToken = null;
  const watchedLoginPopups = new WeakSet();
  let loginInProgress = false;
  let lastLoginRefresh = 0;
  let loginRefreshTimer = null;

  function deliverTokenToUi() {
    if (typeof window.__setLegacyUiAuthToken === "function") {
      clearTimeout(uiDeliveryTimer);
      uiDeliveryTimer = null;
      window.__setLegacyUiAuthToken(currentToken);
      return;
    }
    clearTimeout(uiDeliveryTimer);
    uiDeliveryTimer = setTimeout(deliverTokenToUi, 100);
  }

  function applyToken(token) {
    if (window.__legacyNativeAuthManager) return;
    currentToken = token || null;
    if (currentToken) {
      loginInProgress = false;
      clearInterval(loginRefreshTimer);
      loginRefreshTimer = null;
    }
    if (typeof window.__setPrimaryAuthToken === "function") {
      window.__setPrimaryAuthToken(currentToken);
    } else {
      setTimeout(function () {
        applyToken(currentToken);
      }, 100);
    }
    deliverTokenToUi();
  }

  window.fetch = function (input, init) {
    let url = typeof input === "string" ? input : input && input.url;
    if (
      typeof input === "string" &&
      /^(?:\.\/)?(?:build|static|img)\//.test(input)
    ) {
      input = new URL(input, LOCAL_ROOT).href;
      url = input;
    }
    if (!url || !url.startsWith(API_ORIGIN)) return nativeFetch(input, init);
    const options = Object.assign({}, init || {});
    const headers = new Headers(options.headers || {});
    const legacyToken = headers.get("auth");
    if (legacyToken && !headers.has("Authorization")) {
      headers.set("Authorization", "Bearer " + legacyToken);
      headers.delete("auth");
    }
    options.headers = headers;
    const request = nativeFetch(input, options);
    if (url.replace(/\/$/, "") === API_ORIGIN + "/tracker") {
      return request.then(async function (response) {
        if (!response.ok) return response;
        const servers = await response.clone().json();
        const legacyServers = Array.isArray(servers)
          ? servers.map(function (server) {
              if (!server) return server;
              return Object.assign({}, server, {
                IP: server.host,
                numPlayers: server.num_players,
                maxPlayers: server.max_players,
                mode: server.mode_name || server.mode,
              });
            })
          : servers;
        return new Response(JSON.stringify(legacyServers), {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json" },
        });
      });
    }
    return request;
  };

  const imageSrc = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "src",
  );
  if (imageSrc && imageSrc.set && imageSrc.get) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: imageSrc.configurable,
      enumerable: imageSrc.enumerable,
      get: imageSrc.get,
      set: function (value) {
        if (
          typeof value === "string" &&
          /^(?:\.\/)?(?:build|static|img)\//.test(value)
        ) {
          value = new URL(value, LOCAL_ROOT).href;
        }
        imageSrc.set.call(this, value);
      },
    });
  }

  async function refreshToken() {
    // The patched legacy bundle has the authoritative auth manager. Do not run
    // this shim's older popup poller/refresh loop alongside it.
    if (window.__legacyNativeAuthManager) return null;
    try {
      const response = await nativeFetch(API_ORIGIN + "/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      const data = response.ok ? await response.json() : null;
      console.info("[Senpa API] Session refresh completed.", {
        status: response.status,
        tokenPresent: !!(data && data.access_token),
      });
      applyToken(data && data.access_token);
      window.SenpaAuthDebug = Object.assign(window.SenpaAuthDebug || {}, {
        refreshStatus: response.status,
        tokenPresent: !!(data && data.access_token),
      });
    } catch (error) {
      console.warn("[Senpa API] Token refresh failed", error);
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshToken, 9 * 60 * 1000);
  }

  window.__refreshSenpaAuth = refreshToken;
  function watchLoginPopup(popup) {
    if (window.__legacyNativeAuthManager) return;
    if (!popup || watchedLoginPopups.has(popup)) return;
    watchedLoginPopups.add(popup);
    loginInProgress = true;
    clearInterval(loginRefreshTimer);
    loginRefreshTimer = setInterval(function () {
      if (loginInProgress) refreshToken();
    }, 2000);
    console.info("[Senpa API] Watching login popup for completion.");
    const closeWatcher = setInterval(function () {
      if (!popup.closed) return;
      clearInterval(closeWatcher);
      loginInProgress = false;
      console.info("[Senpa API] Login popup closed; refreshing session.");
      setTimeout(refreshToken, 100);
    }, 300);
    setTimeout(
      function () {
        clearInterval(closeWatcher);
      },
      5 * 60 * 1000,
    );
  }
  window.__watchSenpaLoginPopup = watchLoginPopup;

  function refreshAfterLoginActivity(reason) {
    if (window.__legacyNativeAuthManager) return;
    if (!loginInProgress) return;
    const now = Date.now();
    if (now - lastLoginRefresh < 1500) return;
    lastLoginRefresh = now;
    console.info("[Senpa API] Returned from login; refreshing session.", {
      reason: reason,
    });
    setTimeout(refreshToken, 100);
  }

  window.addEventListener("focus", function () {
    refreshAfterLoginActivity("window-focus");
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshAfterLoginActivity("page-visible");
  });

  window.open = function (url) {
    const popup = nativeOpen.apply(window, arguments);
    if (window.__legacyNativeAuthManager) return popup;
    if (window.__senpaOpeningConnection2Auth) return popup;
    let isSenpaLogin = false;
    try {
      const parsed = new URL(url, location.href);
      isSenpaLogin =
        parsed.origin === API_ORIGIN && parsed.pathname.startsWith("/auth/");
    } catch (_urlError) {}
    if (!popup || !isSenpaLogin) return popup;
    watchLoginPopup(popup);
    return popup;
  };

  // The legacy menu uses ordinary <a target="..."> links for OAuth, which do
  // not pass through window.open(). Open those ourselves so popup completion
  // can refresh the cookie-backed API session exactly like the new client.
  document.addEventListener(
    "click",
    function (event) {
      if (window.__legacyNativeAuthManager) return;
      const anchor =
        event.target && event.target.closest
          ? event.target.closest("a[href]")
          : null;
      if (!anchor) return;
      let loginUrl;
      try {
        loginUrl = new URL(anchor.href, location.href);
      } catch (_urlError) {
        return;
      }
      if (
        loginUrl.origin !== API_ORIGIN ||
        !loginUrl.pathname.startsWith("/auth/")
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      watchLoginPopup(nativeOpen(loginUrl.href, "senpa-auth", "popup=yes"));
    },
    true,
  );

  window.addEventListener(
    "message",
    function (event) {
      if (window.__legacyNativeAuthManager) return;
      if (event.origin !== API_ORIGIN) return;
      if (event.data && event.data.type === "senpa-auth-ready") {
        event.source &&
          event.source.postMessage({ type: "senpa-auth-hello" }, API_ORIGIN);
        return;
      }
      const token =
        event.data &&
        (event.data.access_token || event.data.auth || event.data.token);
      if (!token) return;
      applyToken(token);
      if (typeof window.onmessage === "function") {
        window.onmessage({
          data: { auth: token },
          origin: event.origin,
          source: event.source,
        });
      }
      event.source &&
        event.source.postMessage({ type: "senpa-auth-done" }, API_ORIGIN);
    },
    true,
  );

  setInterval(function () {
    if (window.__legacyNativeAuthManager) return;
    const store = window.__senpaLegacyStore;
    const token = store && store.authToken;
    if (!token || token === observedLegacyToken) return;
    observedLegacyToken = token;
    console.info("[Senpa API] Detected authenticated legacy UI session.");
    applyToken(token);
  }, 250);

  // The legacy UI bundle owns startup refresh and persisted-token recovery.
  // Running a second eager refresh here races new/guest sessions unnecessarily.
})();
