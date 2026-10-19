(() => {
  if (window.__chatExportNetworkHooked) return;
  window.__chatExportNetworkHooked = true;

  const KEYWORDS = ["chat", "message", "reception", "diversion", "selfcheck", "record"];
  let bridgePort = null;
  let bridgeNonce = "";

  function acceptBridge(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== "GD_CHAT_NETWORK_INIT" || !event.data?.nonce || !event.ports?.[0]) return;
    bridgeNonce = String(event.data.nonce);
    bridgePort = event.ports[0];
    bridgePort.start?.();
    bridgePort.postMessage({ type: "GD_CHAT_NETWORK_READY", nonce: bridgeNonce });
  }

  window.addEventListener("message", acceptBridge);

  function shouldCapture(url) {
    const text = String(url || "").toLowerCase();
    return KEYWORDS.some((keyword) => text.includes(keyword));
  }

  function send(url, body) {
    if (!bridgePort || !bridgeNonce) return;
    bridgePort.postMessage({
      type: "CAPTURED_1688_CHAT_RESPONSE",
      nonce: bridgeNonce,
      payload: {
        url: String(url || ""),
        body,
        capturedAt: new Date().toISOString()
      }
    });
  }

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = args[0]?.url || args[0];
    if (shouldCapture(url)) {
      response.clone().json().then((body) => send(url, body)).catch(() => {});
    }
    return response;
  };

  const OriginalXhr = window.XMLHttpRequest;
  window.XMLHttpRequest = function PatchedXMLHttpRequest() {
    const xhr = new OriginalXhr();
    let url = "";
    const originalOpen = xhr.open;

    xhr.open = function open(method, requestUrl, ...rest) {
      url = requestUrl;
      return originalOpen.call(xhr, method, requestUrl, ...rest);
    };

    xhr.addEventListener("load", () => {
      if (!shouldCapture(url) || !xhr.responseText) return;
      try {
        send(url, JSON.parse(xhr.responseText));
      } catch {
        send(url, { rawText: xhr.responseText.slice(0, 5000) });
      }
    });

    return xhr;
  };
})();
