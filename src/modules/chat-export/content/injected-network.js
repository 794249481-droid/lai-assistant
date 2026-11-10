(() => {
  if (window.__chatExportNetworkHooked) return;
  window.__chatExportNetworkHooked = true;

  const KEYWORDS = ["chat", "message", "reception", "diversion", "selfcheck", "record"];
  const DIRECT_API_METHODS = new Map([
    ["mtop.ali.ww.cbu.solution.querySubAccountList", "GET"],
    ["mtop.ali.ww.cbu.listUserHistoryConversationView", "POST"],
    ["mtop.ali.ww.cbu.getListUserMessages", "POST"]
  ]);
  let bridgePort = null;
  let bridgeNonce = "";

  function acceptBridge(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== "GD_CHAT_NETWORK_INIT" || !event.data?.nonce || !event.ports?.[0]) return;
    bridgeNonce = String(event.data.nonce);
    bridgePort = event.ports[0];
    bridgePort.start?.();
    bridgePort.onmessage = (portEvent) => {
      const message = portEvent.data;
      if (!message || message.type !== "GD_CHAT_DIRECT_REQUEST" || message.nonce !== bridgeNonce || !message.id) return;
      if (!DIRECT_API_METHODS.has(message.api)) {
        bridgePort.postMessage({
          type: "GD_CHAT_DIRECT_RESPONSE",
          nonce: bridgeNonce,
          id: message.id,
          ok: false,
          message: "不允许的聊天接口请求"
        });
        return;
      }
      const client = window.lib?.mtop;
      if (!client || typeof client.request !== "function") {
        bridgePort.postMessage({
          type: "GD_CHAT_DIRECT_RESPONSE",
          nonce: bridgeNonce,
          id: message.id,
          ok: false,
          retryable: true,
          message: "1688 页面接口组件尚未加载完成"
        });
        return;
      }
      Promise.resolve()
        .then(() => client.request({
          api: message.api,
          v: "1.0",
          data: message.data || {},
          type: DIRECT_API_METHODS.get(message.api),
          dataType: "originaljsonp",
          timeout: 20000,
          preventFallback: true
        }))
        .then((response) => bridgePort?.postMessage({
          type: "GD_CHAT_DIRECT_RESPONSE",
          nonce: bridgeNonce,
          id: message.id,
          ok: true,
          data: response?.data || {}
        }))
        .catch((error) => {
          const detail = Array.isArray(error?.ret) ? error.ret.join("; ") : String(error?.message || error || "接口请求失败");
          const retryable = /TOKEN|BUSY|繁忙|稍后|TIMEOUT|FLOW_LIMIT|限流|系统异常/i.test(detail) && !/USER_VALIDATE/i.test(detail);
          bridgePort?.postMessage({
            type: "GD_CHAT_DIRECT_RESPONSE",
            nonce: bridgeNonce,
            id: message.id,
            ok: false,
            retryable,
            message: detail
          });
        });
    };
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
