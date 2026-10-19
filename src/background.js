function configureSidePanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(error => console.error("打开侧边栏配置失败", error));
}

configureSidePanel();
chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);

importScripts(
  "version.js",
  "platform/shared/download-filename-router.js",
  "modules/chat-export/shared/download-filename.js",
  "modules/chat-export/shared/compatible-json.js",
  "modules/chat-export/shared/feishu-sync.js",
  "modules/chat-export/background/service-worker.js"
);
