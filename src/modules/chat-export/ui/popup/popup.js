const CHAT_RECORD_URL = "https://work.1688.com/home/seller.htm?_path_=sellerPro/2017Sellerbase_Customer/cco_qcxy_zzh_chat";
const MODULE_ID = "chatExport";
const STORE_NAME_KEY = "integrated.chatExport.storeName";

function globalSettingsApi() {
  return globalThis.HmsGlobalSettings;
}

const TASK_STATUS = {
  IDLE: "idle",
  READING: "reading",
  RUNNING: "running",
  PAUSED: "paused",
  CANCELING: "canceling",
  DONE: "done",
  ERROR: "error"
};

const statusEl = document.querySelector("#status");
const runStatusBadgeEl = document.querySelector("#runStatusBadge");
const taskProgressCardEl = document.querySelector("#taskProgressCard");
const taskProgressStatusEl = document.querySelector("#taskProgressStatus");
const taskProgressBarEl = document.querySelector("#taskProgressBar");
const taskProgressFillEl = document.querySelector("#taskProgressFill");
const taskProgressTextEl = document.querySelector("#taskProgressText");
const taskProgressPercentEl = document.querySelector("#taskProgressPercent");
const employeeListEl = document.querySelector("#employeeList");
const selectedCountEl = document.querySelector("#selectedCount");
const customerAccountEl = document.querySelector("#customerAccount");
const searchCustomerEmployeesEl = document.querySelector("#searchCustomerEmployees");
const customerSearchResultEl = document.querySelector("#customerSearchResult");
const startDateEl = document.querySelector("#startDate");
const endDateEl = document.querySelector("#endDate");
const dateSelectionSectionEl = document.querySelector("#dateSelectionSection");
const customDatePanelEl = document.querySelector("#customDatePanel");
const datePresetPanelEl = document.querySelector("#datePresetPanel");
const dateModeEls = Array.from(document.querySelectorAll('input[name="dateMode"]'));
const datePresetButtons = Array.from(document.querySelectorAll("[data-date-preset]"));
const datePresetSummaryEl = document.querySelector("#datePresetSummary");
const storeNameEl = document.querySelector("#storeName");
const saveStoreNameEl = document.querySelector("#saveStoreName");
const syncToFeishuEl = document.querySelector("#syncToFeishu");
const feishuSyncConfigEl = document.querySelector("#feishuSyncConfig");
const toggleFeishuSyncConfigEl = document.querySelector("#toggleFeishuSyncConfig");
const feishuAppIdEl = document.querySelector("#feishuAppId");
const feishuAppSecretEl = document.querySelector("#feishuAppSecret");
const saveFeishuCredentialsEl = document.querySelector("#saveFeishuCredentials");
const feishuTableUrlEl = document.querySelector("#feishuTableUrl");
const saveFeishuTableEl = document.querySelector("#saveFeishuTable");
const feishuAttachmentFieldEl = document.querySelector("#feishuAttachmentField");
const feishuSyncHintEl = document.querySelector("#feishuSyncHint");
const refreshEl = document.querySelector("#refresh");
const exportExcelEl = document.querySelector("#exportExcel");
const exportJsonEl = document.querySelector("#exportJson");
const selectAllEl = document.querySelector("#selectAll");
const clearSelectionEl = document.querySelector("#clearSelection");
const taskControlsEl = document.querySelector("#taskControls");
const pauseEl = document.querySelector("#pause");
const cancelEl = document.querySelector("#cancel");
const clearLogEl = document.querySelector("#clearLog");
const copyLogEl = document.querySelector("#copyLog");
const progressEl = document.querySelector("#progress");
const usageNoticeEl = document.getElementById("usageNotice");
const acceptUsageNoticeEl = document.getElementById("acceptUsageNotice");
const declineUsageNoticeEl = document.getElementById("declineUsageNotice");
const usageNoticeConsent = globalThis.A1688IntegratedUsageNoticeConsent;
const preflightGuidance = globalThis.A1688ChatExportPreflightGuidance;
const dateSelection = globalThis.A1688ChatExportDateSelection;

let taskStatus = TASK_STATUS.IDLE;
let logLines = [];
let activeTaskId = "";
let activeTaskTabId = null;
let feishuSync = { enabled: false, fields: [] };
let feishuConfigCollapsed = false;
let selectedDatePreset = "";

const RUN_STATUS_LABELS = {
  [TASK_STATUS.IDLE]: "空闲",
  [TASK_STATUS.READING]: "读取中",
  [TASK_STATUS.RUNNING]: "运行中",
  [TASK_STATUS.PAUSED]: "已暂停",
  [TASK_STATUS.CANCELING]: "取消中",
  [TASK_STATUS.DONE]: "已完成",
  [TASK_STATUS.ERROR]: "错误"
};

const TASK_PROGRESS_STATES = {
  [TASK_STATUS.IDLE]: { label: "等待", percentage: 0, text: "等待开始导出任务。" },
  [TASK_STATUS.READING]: { label: "读取中", percentage: 12, text: "正在读取员工账号。" },
  [TASK_STATUS.RUNNING]: { label: "执行中", percentage: 5, text: "正在处理聊天记录。" },
  [TASK_STATUS.PAUSED]: { label: "已暂停", percentage: 5, text: "任务已暂停，等待继续执行。" },
  [TASK_STATUS.CANCELING]: { label: "取消中", percentage: 5, text: "正在取消当前任务。" },
  [TASK_STATUS.DONE]: { label: "已完成", percentage: 100, text: "任务已完成。" },
  [TASK_STATUS.ERROR]: { label: "失败", percentage: 0, text: "任务执行失败，请查看日志。" }
};

function updateRunStatusBadge(status) {
  const label = RUN_STATUS_LABELS[status] || RUN_STATUS_LABELS[TASK_STATUS.IDLE];
  runStatusBadgeEl.textContent = label;
  runStatusBadgeEl.dataset.status = status || TASK_STATUS.IDLE;
  runStatusBadgeEl.title = `运行状态：${label}`;
}

function taskProgressSnapshot(status, taskState) {
  if (status === TASK_STATUS.IDLE && preflightGuidance) {
    const dateRange = resolveSelectedDateRange();
    const reminder = preflightGuidance.getPreflightReminder({
      storeName: storeNameEl.value,
      dateMode: selectedDateMode(),
      datePreset: selectedDatePreset,
      startDate: dateRange?.startDate || "",
      endDate: dateRange?.endDate || "",
      selectedEmployeeCount: selectedEmployees().length
    });
    if (reminder) return reminder;
  }

  const base = TASK_PROGRESS_STATES[status] || TASK_PROGRESS_STATES[TASK_STATUS.IDLE];
  const logs = Array.isArray(taskState?.logs) ? taskState.logs : [];
  const latestLog = logs.at(-1) || "";
  let percentage = base.percentage;
  let text = base.text;

  if (status === TASK_STATUS.RUNNING && latestLog) {
    text = latestLog;
    const periodMatch = latestLog.match(/\[周期 (\d+)\/(\d+)\]/);
    const employeeMatch = latestLog.match(/\[员工\s+(\d+)\/(\d+)\]/);
    if (periodMatch && employeeMatch) {
      const periodIndex = Number(periodMatch[1]);
      const periodTotal = Number(periodMatch[2]);
      const employeeIndex = Number(employeeMatch[1]);
      const employeeTotal = Number(employeeMatch[2]);
      const periodFinished = /(?:本周期处理完成|检索完成|已下载|跳过下载|\[跳过\])/.test(latestLog);
      const completed = (employeeIndex - 1) * periodTotal + (periodFinished ? periodIndex : periodIndex - 1);
      const total = periodTotal * employeeTotal;
      if (total > 0) {
        percentage = Math.max(percentage, Math.min(95, Math.round((completed / total) * 100)));
      }
    } else if (employeeMatch) {
      const employeeIndex = Number(employeeMatch[1]);
      const employeeTotal = Number(employeeMatch[2]);
      const completed = /(?:完成|已下载|跳过)/.test(latestLog) ? employeeIndex : employeeIndex - 1;
      if (employeeTotal > 0) {
        percentage = Math.max(percentage, Math.min(95, Math.round((completed / employeeTotal) * 100)));
      }
    }
  } else if (taskState?.message && [TASK_STATUS.DONE, TASK_STATUS.ERROR, TASK_STATUS.PAUSED, TASK_STATUS.CANCELING].includes(status)) {
    text = taskState.message;
  }

  return { status, ...base, percentage, text };
}

function updateTaskProgress(status, taskState = null) {
  const { status: displayStatus, label, percentage, text } = taskProgressSnapshot(status, taskState);
  taskProgressCardEl.dataset.status = displayStatus;
  taskProgressStatusEl.textContent = label;
  taskProgressStatusEl.dataset.status = displayStatus;
  taskProgressFillEl.dataset.status = displayStatus;
  taskProgressPercentEl.dataset.status = displayStatus;
  taskProgressFillEl.style.width = `${percentage}%`;
  taskProgressBarEl.setAttribute("aria-valuenow", String(percentage));
  taskProgressBarEl.setAttribute("aria-valuetext", `${label}，${percentage}%`);
  taskProgressTextEl.textContent = text;
  taskProgressPercentEl.textContent = `${percentage}%`;
}

function refreshPreflightGuidance() {
  if (taskStatus === TASK_STATUS.IDLE) updateTaskProgress(taskStatus);
}

function selectedDateMode() {
  return dateModeEls.find((input) => input.checked)?.value || "custom";
}

function resolveSelectedDateRange(now = new Date()) {
  if (!dateSelection) {
    return selectedDateMode() === "custom"
      ? { startDate: startDateEl.value, endDate: endDateEl.value }
      : null;
  }

  return dateSelection.resolveDateRange({
    mode: selectedDateMode(),
    startDate: startDateEl.value,
    endDate: endDateEl.value,
    preset: selectedDatePreset,
    now
  });
}

function updateDateSelectionUi(now = new Date()) {
  const mode = selectedDateMode();
  const customActive = mode === "custom";
  dateSelectionSectionEl.dataset.mode = mode;
  customDatePanelEl.dataset.active = String(customActive);
  datePresetPanelEl.dataset.active = String(!customActive);

  if (!selectedDatePreset) {
    datePresetSummaryEl.textContent = "请选择一个快捷日期范围。";
  } else {
    const dateRange = dateSelection?.getPresetRange(selectedDatePreset, now);
    datePresetSummaryEl.textContent = dateRange
      ? `实际范围：${dateRange.startDate} 至 ${dateRange.endDate}（导出时重新计算）`
      : "请选择一个快捷日期范围。";
  }
}

function setDateMode(mode) {
  const modeEl = dateModeEls.find((input) => input.value === mode);
  if (modeEl) modeEl.checked = true;
  updateDateSelectionUi();
  refreshPreflightGuidance();
}

function selectDatePreset(preset) {
  if (!dateSelection?.getPresetRange(preset)) return;
  selectedDatePreset = preset;
  datePresetButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.datePreset === preset));
  });
  setDateMode("preset");
}

function appendLog(text) {
  logLines.push(text);
  if (logLines.length > 80) logLines = logLines.slice(-80);
  renderLogs();
}

function renderLogs() {
  progressEl.textContent = logLines.join("\n");
  progressEl.scrollTop = progressEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function storeNameValue() {
  return storeNameEl.value.trim();
}

async function saveStoreName({ announce = true } = {}) {
  const storeName = storeNameValue();
  if (!storeName) {
    setStatus("请先填写店铺名称。");
    refreshPreflightGuidance();
    storeNameEl.focus();
    return "";
  }

  try {
    await chrome.storage.local.set({ [STORE_NAME_KEY]: storeName });
    const settings = globalSettingsApi();
    if (settings?.update) {
      await settings.update({ storeName }, chrome.storage.local);
    }
    if (announce) setStatus("店铺名称已保存，导出文件将使用该名称。");
    refreshPreflightGuidance();
    return storeName;
  } catch (error) {
    setStatus(`店铺名称保存失败：${error.message || "请重试"}`);
    refreshPreflightGuidance();
    return "";
  }
}

async function restoreStoreName() {
  try {
    const [legacyResult, globalResult] = await Promise.all([
      chrome.storage.local.get(STORE_NAME_KEY),
      globalSettingsApi()?.read
        ? globalSettingsApi().read(chrome.storage.local).catch(() => null)
        : Promise.resolve(null)
    ]);
    const globalStoreName = String(globalResult?.storeName || "").trim();
    const legacyStoreName = String(legacyResult[STORE_NAME_KEY] || "").trim();
    storeNameEl.value = globalStoreName || legacyStoreName;
    refreshPreflightGuidance();
  } catch {
    setStatus("店铺名称读取失败，请重新填写后保存。");
  }
}

function statusFromTaskState(status) {
  if (status === "running") return TASK_STATUS.RUNNING;
  if (status === "paused") return TASK_STATUS.PAUSED;
  if (status === "canceling") return TASK_STATUS.CANCELING;
  if (status === "error") return TASK_STATUS.ERROR;
  if (status === "done") return TASK_STATUS.DONE;
  return TASK_STATUS.IDLE;
}

function applyTaskState(taskState) {
  if (!taskState) return;
  logLines = taskState.logs || [];
  renderLogs();

  const restoredStatus = statusFromTaskState(taskState.status);
  setTaskStatus(restoredStatus, taskState);
  const active = [TASK_STATUS.RUNNING, TASK_STATUS.PAUSED, TASK_STATUS.CANCELING].includes(restoredStatus);
  activeTaskId = active ? (taskState.taskId || activeTaskId) : "";
  activeTaskTabId = active ? (taskState.tabId || activeTaskTabId) : null;

  if (taskState.status === "running") {
    setStatus("任务正在进行中，已恢复之前的日志。");
    return;
  }

  if (taskState.status === "paused") {
    setStatus("任务已暂停，已恢复之前的日志。");
    return;
  }

  if (taskState.status === "canceling") {
    setStatus("任务正在取消，已恢复之前的日志。");
    return;
  }

  if (taskState.message) setStatus(taskState.message);
}

async function restoreTaskState() {
  try {
    const result = await chrome.runtime.sendMessage({ module: MODULE_ID, type: "GET_TASK_STATE" });
    if (result?.ok) applyTaskState(result.taskState);
  } catch {
    return;
  }
}

function setTaskStatus(nextStatus, taskState = null) {
  taskStatus = nextStatus;
  updateRunStatusBadge(taskStatus);
  updateTaskProgress(taskStatus, taskState);
  const active = [TASK_STATUS.RUNNING, TASK_STATUS.PAUSED, TASK_STATUS.CANCELING].includes(taskStatus);
  taskControlsEl.hidden = !active;
  refreshEl.disabled = active;
  exportExcelEl.disabled = active;
  exportJsonEl.disabled = active;
  storeNameEl.disabled = active;
  saveStoreNameEl.disabled = active;
  syncToFeishuEl.disabled = active;
  searchCustomerEmployeesEl.disabled = active;
  toggleFeishuSyncConfigEl.disabled = active || !feishuSync.enabled;
  feishuAppIdEl.disabled = active;
  feishuAppSecretEl.disabled = active;
  saveFeishuCredentialsEl.disabled = active;
  feishuTableUrlEl.disabled = active;
  saveFeishuTableEl.disabled = active;
  feishuAttachmentFieldEl.disabled = active || !(feishuSync.fields || []).some((field) => Number(field.type) === 17);
  pauseEl.disabled = taskStatus === TASK_STATUS.CANCELING;
  cancelEl.disabled = taskStatus === TASK_STATUS.CANCELING;
  pauseEl.textContent = taskStatus === TASK_STATUS.PAUSED ? "继续" : "暂停";
}

function hideUsageNotice() {
  if (!usageNoticeEl) return;
  usageNoticeEl.classList.add("isHidden");
  usageNoticeEl.setAttribute("aria-hidden", "true");
}

async function restoreUsageNoticeState() {
  if (!usageNoticeEl) return;
  try {
    const accepted = usageNoticeConsent ?
      await usageNoticeConsent.hasAccepted(chrome.storage.local) :
      false;
    if (accepted) {
      hideUsageNotice();
      return;
    }
  } catch {
    // Keep the notice visible if storage is temporarily unavailable.
  }

  usageNoticeEl.classList.remove("isHidden");
  usageNoticeEl.setAttribute("aria-hidden", "false");
  setTimeout(() => {
    if (acceptUsageNoticeEl) acceptUsageNoticeEl.focus();
  }, 0);
}

async function acceptUsageNotice() {
  try {
    if (usageNoticeConsent) {
      await usageNoticeConsent.accept(chrome.storage.local);
    }
    hideUsageNotice();
    setStatus("已确认使用须知。");
  } catch (error) {
    setStatus(`使用须知确认保存失败：${error.message}`);
  }
}

function declineUsageNotice() {
  setStatus("需阅读并同意使用须知与免责声明后，才可使用插件。");
  appendLog("[提示] 请先阅读并同意使用须知与免责声明");
  setTimeout(() => {
    if (acceptUsageNoticeEl) acceptUsageNoticeEl.focus();
  }, 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isChatRecordUrl(url = "") {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "air.1688.com" ||
      (parsed.hostname === "work.1688.com" && parsed.search.includes("cco_qcxy_zzh_chat"));
  } catch { return false; }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 12000);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureChatRecordPage() {
  const tab = await activeTab();
  if (!tab) throw new Error("没有找到当前浏览器标签页。");

  if (isChatRecordUrl(tab.url)) return tab;

  appendLog("[准备] 正在打开聊天记录查询页面");
  const updated = await chrome.tabs.update(tab.id, { url: CHAT_RECORD_URL });
  await waitForTabLoad(tab.id);
  await sleep(1800);
  return updated || await activeTab();
}

async function sendWithRetry(message, attempts = 12, tabId = null) {
  const tab = tabId != null ? { id: tabId } : await activeTab();
  if (!tab?.id) throw new Error("没有找到聊天记录所在标签页。");
  let target;
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      // Reinstall after an extension update, and include permitted child frames.
      // The content script guards against duplicate listeners in the same context.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["src/modules/chat-export/shared/download-filename.js", "src/modules/chat-export/shared/date-selection.js", "src/modules/chat-export/content/content.js"]
      });
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => Boolean(globalThis.__GD_CHAT_CONNECTION__?.isTargetPage())
      });
      target = frames.find(frame => frame.result === true);
      if (target) break;
      lastError = new Error("聊天记录查询页面尚未加载，请确认已登录并进入聊天记录查询。");
    } catch (error) {
      lastError = error;
    }
    if (index + 1 < attempts) await sleep(600);
  }
  if (!target) throw new Error(`无法连接聊天记录页面，请刷新 1688 页面后重试。${lastError?.message || ""}`);
  // Retry discovery only: replaying START_EXPORT after a port error could run it twice.
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { module: MODULE_ID, ...message },
      { frameId: target.frameId });
    if (!response) throw new Error("页面未返回结果");
    return response;
  } catch (error) {
    throw new Error(`与聊天记录页面的连接已断开，请确认页面没有刷新或关闭，再重新读取员工列表。${error.message || ""}`);
  }
}

function createTaskId() {
  return `chat-export-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function sendRuntimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage({ module: MODULE_ID, ...(message || {}) });
  } catch {
    return null;
  }
}

function setFeishuSyncHint(message, isError = false) {
  feishuSyncHintEl.textContent = message;
  feishuSyncHintEl.style.color = isError ? "#b91c1c" : "";
}

function renderFeishuAttachmentFields() {
  const attachmentFields = (feishuSync.fields || []).filter((field) => Number(field.type) === 17);
  feishuAttachmentFieldEl.replaceChildren();
  if (!attachmentFields.length) {
    feishuAttachmentFieldEl.append(new Option("请先读取附件字段", ""));
    feishuAttachmentFieldEl.disabled = true;
    return;
  }
  for (const field of attachmentFields) {
    feishuAttachmentFieldEl.append(new Option(field.fieldName, field.fieldId, false, field.fieldId === feishuSync.attachmentFieldId));
  }
  feishuAttachmentFieldEl.disabled = [TASK_STATUS.RUNNING, TASK_STATUS.PAUSED, TASK_STATUS.CANCELING].includes(taskStatus);
}

function updateFeishuSyncConfigVisibility() {
  feishuSyncConfigEl.hidden = !feishuSync.enabled || feishuConfigCollapsed;
  toggleFeishuSyncConfigEl.hidden = !feishuSync.enabled;
  toggleFeishuSyncConfigEl.disabled = [TASK_STATUS.RUNNING, TASK_STATUS.PAUSED, TASK_STATUS.CANCELING].includes(taskStatus);
  toggleFeishuSyncConfigEl.setAttribute("aria-expanded", String(!feishuConfigCollapsed));
  toggleFeishuSyncConfigEl.textContent = feishuConfigCollapsed ? "展开配置" : "收起配置";
}

function toggleFeishuSyncConfig() {
  if (!feishuSync.enabled) return;
  feishuConfigCollapsed = !feishuConfigCollapsed;
  updateFeishuSyncConfigVisibility();
}

function renderFeishuSyncSettings(settings = {}) {
  feishuSync = { ...feishuSync, ...settings, fields: Array.isArray(settings.fields) ? settings.fields : (feishuSync.fields || []) };
  syncToFeishuEl.checked = feishuSync.enabled === true;
  updateFeishuSyncConfigVisibility();
  feishuAppIdEl.value = feishuSync.feishuAppId || "";
  feishuAppSecretEl.value = "";
  feishuAppSecretEl.placeholder = feishuSync.feishuAppSecret
    ? "已保存，留空保持不变"
    : "输入飞书应用密钥";
  feishuTableUrlEl.value = feishuSync.feishuTableUrl || "";
  renderFeishuAttachmentFields();
  if (!feishuSync.enabled) {
    setFeishuSyncHint("关闭时只下载到本地，无需填写飞书配置。");
  } else if (feishuSync.attachmentFieldId) {
    setFeishuSyncHint("导出文件会同时保存到本地，并作为附件写入飞书多维表格。");
  } else {
    setFeishuSyncHint("请保存凭证、读取表格字段并选择附件字段。", true);
  }
}

async function restoreFeishuSyncSettings() {
  const result = await sendRuntimeMessage({ type: "GET_FEISHU_SYNC_SETTINGS" });
  if (!result?.ok) {
    setFeishuSyncHint(result?.message || "飞书配置读取失败，请重新打开插件。", true);
    return;
  }
  renderFeishuSyncSettings(result.settings || {});
}

async function updateFeishuSyncEnabled() {
  const enabled = syncToFeishuEl.checked;
  const result = await sendRuntimeMessage({ type: "SET_FEISHU_SYNC_ENABLED", enabled });
  if (!result?.ok) {
    syncToFeishuEl.checked = !enabled;
    setFeishuSyncHint(result?.message || "飞书同步开关保存失败。", true);
    return;
  }
  if (enabled) feishuConfigCollapsed = false;
  renderFeishuSyncSettings(result.settings || { enabled });
}

async function saveFeishuCredentials() {
  const appId = feishuAppIdEl.value.trim();
  const appSecret = feishuAppSecretEl.value.trim();
  const result = await sendRuntimeMessage({
    type: "SAVE_FEISHU_SYNC_CREDENTIALS",
    feishuAppId: appId,
    feishuAppSecret: appSecret
  });
  if (!result?.ok) {
    setFeishuSyncHint(result?.message || "飞书凭证保存失败。", true);
    return;
  }
  renderFeishuSyncSettings(result.settings || {});
  setFeishuSyncHint(result.message || "飞书 App 凭证已保存。");
}

async function saveFeishuTable() {
  setFeishuSyncHint("正在读取飞书数据表字段...");
  const result = await sendRuntimeMessage({
    type: "SAVE_FEISHU_SYNC_TABLE",
    feishuTableUrl: feishuTableUrlEl.value.trim(),
    attachmentFieldId: feishuAttachmentFieldEl.value
  });
  if (!result?.ok) {
    setFeishuSyncHint(result?.message || "飞书字段读取失败。", true);
    return;
  }
  renderFeishuSyncSettings(result.settings || {});
  setFeishuSyncHint(result.message || "已读取飞书字段，请确认附件字段。");
}

async function saveFeishuAttachmentField() {
  const result = await sendRuntimeMessage({
    type: "SAVE_FEISHU_SYNC_FIELD",
    attachmentFieldId: feishuAttachmentFieldEl.value
  });
  if (!result?.ok) {
    setFeishuSyncHint(result?.message || "附件字段保存失败。", true);
    return;
  }
  renderFeishuSyncSettings(result.settings || {});
}

async function validateFeishuSyncBeforeExport() {
  if (!feishuSync.enabled) return { ok: true, enabled: false };
  const result = await sendRuntimeMessage({ type: "VALIDATE_FEISHU_SYNC" });
  if (!result?.ok) {
    setFeishuSyncHint(result?.message || "飞书同步配置不完整。", true);
    return { ok: false, enabled: true, message: result?.message || "飞书同步配置不完整。" };
  }
  renderFeishuSyncSettings(result.settings || {});
  return { ok: true, enabled: true };
}

function updateSelectedCount() {
  const count = selectedEmployees().length;
  selectedCountEl.textContent = `已选择 ${count} 个员工`;
  refreshPreflightGuidance();
}

function renderEmployees(employees) {
  if (!employees.length) {
    employeeListEl.replaceChildren(Object.assign(document.createElement("div"), {
      className: "employee-empty",
      textContent: "没有读取到员工账号"
    }));
    updateSelectedCount();
    return;
  }

  employeeListEl.replaceChildren(...employees.map((name) => {
    const label = document.createElement("label");
    label.className = "employee-option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = name;
    input.addEventListener("change", updateSelectedCount);

    const span = document.createElement("span");
    span.textContent = name;

    label.append(input, span);
    return label;
  }));
  updateSelectedCount();
}

function employeeCheckboxes() {
  return Array.from(employeeListEl.querySelectorAll('input[type="checkbox"]'));
}

function selectedEmployees() {
  return employeeCheckboxes()
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function earliestAllowedDate(today = new Date()) {
  return A1688ChatExportDateSelection.formatLocalDate(A1688ChatExportDateSelection.threeMonthsEarlier(today));
}

function validDateRange(dateRange = resolveSelectedDateRange()) {
  if (selectedDateMode() === "preset" && !selectedDatePreset) return "请选择一个快捷日期范围。";
  if (!dateRange?.startDate || !dateRange?.endDate) return "请选择开始日期和结束日期。";
  if (dateRange.endDate < dateRange.startDate) return "结束日期不能早于开始日期。";
  if (selectedDatePreset !== "last3Months" && dateRange.startDate < earliestAllowedDate()) {
    return "页面只能查询三个月之内的聊天记录。";
  }
  return "";
}

async function refreshEmployees() {
  setTaskStatus(TASK_STATUS.READING);
  setStatus("正在读取员工列表...");
  logLines = [];

  try {
    const tab = await ensureChatRecordPage();
    appendLog("[准备] 页面已打开，正在读取员工账号");
    const result = await sendWithRetry({ type: "GET_EMPLOYEES" }, 12, tab.id);

    if (!result || !result.ok) {
      setTaskStatus(TASK_STATUS.ERROR);
      setStatus(result?.message || "没有读取到员工账号。");
      appendLog(`[错误] ${result?.message || "没有读取到员工账号"}`);
      setTaskStatus(TASK_STATUS.IDLE);
      return;
    }

    setDateMode("custom");
    startDateEl.value = earliestAllowedDate();
    endDateEl.value = todayLocalDate();
    refreshPreflightGuidance();
    renderEmployees(result.employees || []);
    setStatus(result.employees?.length
      ? `已读取 ${result.employees.length} 个员工账号`
      : "没有读取到员工账号，请确认页面加载完成后再刷新。");
    appendLog(`[完成] 已读取 ${result.employees?.length || 0} 个员工账号`);
  } catch (error) {
    setStatus("读取员工列表失败。");
    appendLog(`[错误] ${error.message || "读取员工列表失败"}`);
  } finally {
    setTaskStatus(TASK_STATUS.IDLE);
  }
}

function todayLocalDate() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

function recentThreeMonthsStartDate() {
  return A1688ChatExportDateSelection.getPresetRange("last3Months").startDate;
}

async function searchCustomerEmployees() {
  const customerAccount = customerAccountEl.value.trim();
  if (!customerAccount) {
    customerSearchResultEl.textContent = "请先输入客户旺旺号。";
    customerAccountEl.focus();
    return;
  }

  if (taskStatus !== TASK_STATUS.IDLE && taskStatus !== TASK_STATUS.DONE && taskStatus !== TASK_STATUS.ERROR) {
    customerSearchResultEl.textContent = "当前已有任务执行中，请等待任务完成。";
    return;
  }

  const taskId = createTaskId();
  const searchStartDate = recentThreeMonthsStartDate();
  const searchEndDate = todayLocalDate();
  setTaskStatus(TASK_STATUS.RUNNING);
  customerSearchResultEl.textContent = "正在检索近三个月聊天记录，请稍候...";
  const initialLog = `[准备] 开始检索客户旺旺号：${customerAccount}，日期 ${searchStartDate} 至 ${searchEndDate}`;
  appendLog(initialLog);

  try {
    const employees = employeeCheckboxes().filter((input) => input.checked).map((input) => input.value).filter(Boolean);
    if (employees.length === 0) throw new Error("没有读取到员工账号，请先打开聊天记录查询页面。");

    const tab = await ensureChatRecordPage();
    const taskStarted = await sendRuntimeMessage({
      type: "TASK_STARTED",
      formatLabel: "客户检索",
      employees,
      customerAccount,
      startDate: searchStartDate,
      endDate: searchEndDate,
      taskId,
      tabId: tab.id,
      initialLog
    });
    if (!taskStarted?.ok) throw new Error(taskStarted?.message || "客户检索任务未能开始。");
    const result = await sendWithRetry({
      type: "SEARCH_CUSTOMER_EMPLOYEES",
      taskId,
      customerAccount,
      employees,
      startDate: searchStartDate,
      endDate: searchEndDate
    }, 12, tab.id);

    if (!result?.ok) throw new Error(result?.message || "客户旺旺号检索失败。");
    selectDatePreset("last3Months");
    const matches = Array.isArray(result.matches) ? result.matches : [];
    renderEmployees((result.employees || []).map((employee) => String(employee)));
    employeeCheckboxes().forEach((input) => { input.checked = true; });
    updateSelectedCount();
    const matched = result.employees || [];
    customerSearchResultEl.textContent = matched.length
      ? `检索完成：\n${matches.map((item) => `${item.employee}：${item.messageCount || 0} 条消息`).join("\n")}\n已勾选检测到记录的销售，可分别导出 JSON。`
      : "检索完成：已勾选销售中没有找到对应客户记录。";
    setStatus(matched.length ? "已找到对应销售，请选择后导出 JSON。" : "未找到对应销售。");
    const countSummary = matches.length
      ? matches.map((item) => `${item.employee} ${item.messageCount || 0} 条`).join("；")
      : "没有匹配销售";
    const doneMessage = `检索完成：${countSummary}`;
    appendLog(`[完成] ${doneMessage}`);
    const taskState = await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "done", message: doneMessage });
    setTaskStatus(TASK_STATUS.DONE, taskState?.taskState || { status: "done", message: doneMessage, logs: logLines });
  } catch (error) {
    customerSearchResultEl.textContent = error.message || "客户旺旺号检索失败。";
    appendLog(`[错误] ${error.message || "客户旺旺号检索失败"}`);
    const taskState = await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "error", message: error.message || "客户旺旺号检索失败。" });
    setTaskStatus(TASK_STATUS.ERROR, taskState?.taskState || { status: "error", message: error.message, logs: logLines });
  } finally {
    if (taskStatus === TASK_STATUS.RUNNING) setTaskStatus(TASK_STATUS.IDLE);
  }
}

async function startExport(exportFormat) {
  const feishuSyncValidation = await validateFeishuSyncBeforeExport();
  if (!feishuSyncValidation.ok) {
    appendLog(`[错误] ${feishuSyncValidation.message}`);
    return;
  }
  const storeName = await saveStoreName({ announce: false });
  const dateRange = resolveSelectedDateRange(new Date());
  updateDateSelectionUi();
  const dateError = validDateRange(dateRange);
  const employees = selectedEmployees();
  const customerAccount = customerAccountEl.value.trim();
  const formatLabel = exportFormat === "json" ? "JSON" : "Excel";

  if (!storeName) {
    appendLog("[错误] 请先填写并保存店铺名称。");
    return;
  }

  if (dateError) {
    appendLog(`[错误] ${dateError}`);
    return;
  }

  if (employees.length === 0) {
    appendLog("[错误] 请选择至少一个员工账号。");
    return;
  }

  setTaskStatus(TASK_STATUS.RUNNING);
  setStatus("正在扫描聊天记录...");
  const syncLabel = feishuSync.enabled ? "，同步到飞书多维表格" : "，仅保存到本地";
  const customerLabel = customerAccount ? `，客户旺旺号 ${customerAccount}` : "，全部客户";
  const initialLog = `[准备] 开始导出 ${formatLabel}，店铺 ${storeName}，${employees.length} 个员工，日期 ${dateRange.startDate} 至 ${dateRange.endDate}${customerLabel}，按 7 天周期依次导出${syncLabel}`;
  const taskId = createTaskId();
  appendLog(initialLog);

  try {
    const tab = await ensureChatRecordPage();
    activeTaskId = taskId;
    activeTaskTabId = tab.id;
    const taskStarted = await sendRuntimeMessage({
      type: "TASK_STARTED",
      formatLabel,
      employees,
      customerAccount,
      storeName,
      syncToFeishu: feishuSync.enabled,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      taskId,
      tabId: tab.id,
      initialLog
    });
    if (!taskStarted || taskStarted.ok !== true) {
      throw new Error(taskStarted?.message || "任务未能开始，请刷新页面后重试。");
    }
    const result = await sendWithRetry({
      type: "START_EXPORT",
      taskId,
      exportFormat,
      employees,
      customerAccount,
      storeName,
      syncToFeishu: feishuSync.enabled,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate
    }, 12, tab.id);

    if (result?.canceled) {
      setStatus("任务已取消。");
      appendLog("[取消] 任务已取消");
      setTaskStatus(TASK_STATUS.IDLE);
      await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "canceled", message: "任务已取消。" });
      return;
    }

    if (!result?.ok) {
      setStatus("导出失败。");
      appendLog(`[错误] ${result?.message || "导出失败"}`);
      setTaskStatus(TASK_STATUS.ERROR, { status: "error", message: result?.message || "导出失败。", logs: logLines });
      await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "error", message: result?.message || "导出失败。" });
      return;
    }

    const downloadedText = result.downloadedCount
      ? `已下载 ${result.downloadedCount} 个 ${formatLabel} 文件`
      : "没有可下载的聊天记录";
    setStatus(`扫描完成，${downloadedText}。`);
    appendLog(`[完成] 全部员工处理完成，${downloadedText}`);
    setTaskStatus(TASK_STATUS.DONE, { status: "done", message: `扫描完成，${downloadedText}。`, logs: logLines });
  } catch (error) {
    setStatus("导出失败。");
    appendLog(`[错误] ${error.message || "导出失败，请确认页面已经打开到聊天记录查询。"}`);
    setTaskStatus(TASK_STATUS.ERROR, { status: "error", message: error.message || "导出失败。", logs: logLines });
    await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "error", message: error.message || "导出失败。" });
  } finally {
    activeTaskId = "";
    activeTaskTabId = null;
    if ([TASK_STATUS.RUNNING, TASK_STATUS.PAUSED, TASK_STATUS.CANCELING].includes(taskStatus)) {
      setTaskStatus(TASK_STATUS.IDLE);
    }
  }
}

async function togglePause() {
  if (taskStatus === TASK_STATUS.RUNNING) {
    const result = await sendWithRetry({ type: "PAUSE_EXPORT", taskId: activeTaskId }, 2, activeTaskTabId)
      .catch((error) => ({ ok: false, message: error.message }));
    if (!result?.ok) {
      appendLog(`[错误] 暂停命令发送失败：${result?.message || "未收到页面响应"}`);
      return;
    }
    await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "paused", message: "任务已暂停。" });
    setTaskStatus(TASK_STATUS.PAUSED);
    appendLog("[暂停] 当前客户处理完成后暂停");
    return;
  }

  if (taskStatus === TASK_STATUS.PAUSED) {
    const result = await sendWithRetry({ type: "RESUME_EXPORT", taskId: activeTaskId }, 2, activeTaskTabId)
      .catch((error) => ({ ok: false, message: error.message }));
    if (!result?.ok) {
      appendLog(`[错误] 继续命令发送失败：${result?.message || "未收到页面响应"}`);
      return;
    }
    await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "running", message: "任务进行中。" });
    setTaskStatus(TASK_STATUS.RUNNING);
    appendLog("[继续] 任务继续执行");
  }
}

async function cancelTask() {
  if (![TASK_STATUS.RUNNING, TASK_STATUS.PAUSED].includes(taskStatus)) return;
  setTaskStatus(TASK_STATUS.CANCELING);
  appendLog("[取消] 正在取消任务");
  await sendRuntimeMessage({ type: "TASK_STATUS_CHANGED", status: "canceling", message: "正在取消任务。" });
  await sendRuntimeMessage({ type: "CANCEL_ACTIVE_DOWNLOADS", taskId: activeTaskId });
  const result = await sendWithRetry({ type: "CANCEL_EXPORT", taskId: activeTaskId }, 2, activeTaskTabId)
    .catch((error) => ({ ok: false, message: error.message }));
  if (!result?.ok) {
    appendLog(`[错误] 页面取消命令发送失败：${result?.message || "未收到页面响应"}`);
  }
}

async function copyLogs() {
  const result = await sendRuntimeMessage({ type: "GET_TASK_STATE" });
  const taskState = result?.ok ? result.taskState : { logs: logLines };
  const text = formatCopiedLogs(taskState);
  if (!text) {
    appendLog("[提示] 当前没有可复制的日志");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    appendLog(`[完成] 已复制 ${(taskState.logs || []).length} 行日志`);
  } catch (error) {
    appendLog(`[错误] 日志复制失败：${error.message || "浏览器没有允许剪贴板权限"}`);
  }
}

async function clearLogs() {
  logLines = [];
  renderLogs();
  const result = await sendRuntimeMessage({ type: "CLEAR_TASK_LOGS" });
  if (!result || !result.ok) {
    setStatus(`当前日志已清空，后台日志清空失败：${result?.message || "未收到后台响应"}`);
    return;
  }
  setStatus("日志已清空。");
}

function formatCopiedLogs(taskState) {
  const logs = taskState?.logs || [];
  if (!logs.length) return "";

  const header = [
    `任务状态：${taskState.status || "未知"}`,
    `员工账号：${(taskState.employees || []).join("、") || "未记录"}`,
    `日期范围：${taskState.startDate || "未记录"} 至 ${taskState.endDate || "未记录"}`,
    `导出格式：${taskState.formatLabel || "未记录"}`,
    `飞书同步：${taskState.syncToFeishu ? "已开启" : "未开启"}`,
    `最后状态：${taskState.message || "未记录"}`,
    `日志行数：${logs.length}`
  ];

  return [...header, "", ...logs].join("\n");
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.module !== MODULE_ID) return;
  if (message.type === "TASK_STATE_UPDATED") applyTaskState(message.taskState);
});

refreshEl.addEventListener("click", refreshEmployees);
searchCustomerEmployeesEl.addEventListener("click", searchCustomerEmployees);
exportExcelEl.addEventListener("click", () => startExport("excel"));
exportJsonEl.addEventListener("click", () => startExport("json"));
saveStoreNameEl.addEventListener("click", () => saveStoreName());
storeNameEl.addEventListener("input", refreshPreflightGuidance);
syncToFeishuEl.addEventListener("change", updateFeishuSyncEnabled);
toggleFeishuSyncConfigEl.addEventListener("click", toggleFeishuSyncConfig);
saveFeishuCredentialsEl.addEventListener("click", saveFeishuCredentials);
saveFeishuTableEl.addEventListener("click", saveFeishuTable);
feishuAttachmentFieldEl.addEventListener("change", saveFeishuAttachmentField);
startDateEl.addEventListener("input", refreshPreflightGuidance);
endDateEl.addEventListener("input", refreshPreflightGuidance);
startDateEl.addEventListener("change", refreshPreflightGuidance);
endDateEl.addEventListener("change", refreshPreflightGuidance);
startDateEl.addEventListener("focus", () => setDateMode("custom"));
endDateEl.addEventListener("focus", () => setDateMode("custom"));
dateModeEls.forEach((input) => {
  input.addEventListener("change", () => {
    updateDateSelectionUi();
    refreshPreflightGuidance();
  });
});
datePresetButtons.forEach((button) => {
  button.addEventListener("click", () => selectDatePreset(button.dataset.datePreset));
});
selectAllEl.addEventListener("click", () => {
  employeeCheckboxes().forEach((input) => { input.checked = true; });
  updateSelectedCount();
});
clearSelectionEl.addEventListener("click", () => {
  employeeCheckboxes().forEach((input) => { input.checked = false; });
  updateSelectedCount();
});
pauseEl.addEventListener("click", togglePause);
cancelEl.addEventListener("click", cancelTask);
clearLogEl.addEventListener("click", clearLogs);
copyLogEl.addEventListener("click", copyLogs);
if (acceptUsageNoticeEl) {
  acceptUsageNoticeEl.addEventListener("click", acceptUsageNotice);
}
if (declineUsageNoticeEl) {
  declineUsageNoticeEl.addEventListener("click", declineUsageNotice);
}
renderEmployees([]);
updateDateSelectionUi();
setTaskStatus(TASK_STATUS.IDLE);
restoreUsageNoticeState();
Promise.allSettled([restoreStoreName(), restoreFeishuSyncSettings()]).finally(restoreTaskState);
