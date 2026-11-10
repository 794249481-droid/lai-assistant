(() => {
if (globalThis.__GD_CHAT_CONNECTION__) return;
globalThis.__GD_CHAT_CONNECTION__ = { isTargetPage };
const state = {
  payloads: []
};

const networkBridge = {
  nonce: crypto.randomUUID(),
  port: null,
  ready: false,
  requestId: 0,
  pending: new Map()
};

const MODULE_ID = "chatExport";
const DIRECT_API = Object.freeze({
  employees: "mtop.ali.ww.cbu.solution.querySubAccountList",
  conversations: "mtop.ali.ww.cbu.listUserHistoryConversationView",
  messages: "mtop.ali.ww.cbu.getListUserMessages"
});
const DIRECT_REQUEST_TIMEOUT_MS = 30000;
const DIRECT_RETRY_DELAYS_MS = [1500, 4000, 8000];
// 每批 20 位客户，批内最多 4 路请求。该上限给卖家工作台自身请求留出余量，避免限流。
const DIRECT_BATCH_SIZE = 20;
const DIRECT_CONCURRENCY = 4;
const DIRECT_MAX_PAGES_PER_CUSTOMER = 200;
const directEmployeeCache = new Map();

const exportControl = {
  paused: false,
  canceled: false,
  taskId: ""
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollAndWait(scroller, nextTop, options = {}) {
  const startedAt = Date.now();
  const maximumWait = options.maximumWait ?? 180;
  let lastMutationAt = 0;
  let changed = false;
  const observer = new MutationObserver(() => {
    changed = true;
    lastMutationAt = Date.now();
  });

  observer.observe(scroller, { childList: true, subtree: true, characterData: true });
  scroller.scrollTop = nextTop;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

  try {
    await sleep(35);
    while (Date.now() - startedAt < maximumWait) {
      const elapsed = Date.now() - startedAt;
      if (changed && elapsed >= 65 && Date.now() - lastMutationAt >= 45) break;
      if (!changed && elapsed >= 90) break;
      await sleep(20);
    }
  } finally {
    observer.disconnect();
  }
}

function sendProgress(message) {
  try {
    const result = chrome.runtime.sendMessage({ module: MODULE_ID, type: "EXPORT_PROGRESS", message });
    if (result?.catch) result.catch(() => {});
  } catch {
    return;
  }
}

function sendTaskStatus(status, message) {
  try {
    const result = chrome.runtime.sendMessage({ module: MODULE_ID, type: "EXPORT_TASK_STATUS", status, message });
    if (result?.catch) result.catch(() => {});
  } catch {
    return;
  }
}

function throwIfCanceled() {
  if (exportControl.canceled) throw new Error("__EXPORT_CANCELED__");
}

async function waitIfPaused() {
  let notified = false;
  while (exportControl.paused && !exportControl.canceled) {
    if (!notified) {
      sendProgress("[暂停] 当前任务已暂停，可点击继续");
      notified = true;
    }
    await sleep(500);
  }
  throwIfCanceled();
}

async function waitFor(getValue, options = {}) {
  const timeout = options.timeout || 2500;
  const interval = options.interval || 80;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const value = getValue();
    if (value) return value;
    await sleep(interval);
  }

  return null;
}

function fireMouseSequence(element) {
  if (!element) return;
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }
}

function fireKeyboard(element, key) {
  if (!element) return;
  element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
  element.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }));
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function pageText() {
  return document.body?.innerText || "";
}

function isTargetPage() {
  const text = pageText();
  return location.hostname === "air.1688.com" &&
    text.includes("聊天记录查询") &&
    text.includes("查询聊天记录");
}

function injectNetworkScript() {
  if (document.documentElement.dataset.exportNetworkInjected === "true") return;
  document.documentElement.dataset.exportNetworkInjected = "true";
  const channel = new MessageChannel();
  networkBridge.port = channel.port1;
  networkBridge.port.onmessage = (event) => {
    const message = event.data;
    if (!message || message.nonce !== networkBridge.nonce) return;
    if (message.type === "GD_CHAT_NETWORK_READY") {
      networkBridge.ready = true;
      return;
    }
    if (message.type === "GD_CHAT_DIRECT_RESPONSE" && message.id) {
      const pending = networkBridge.pending.get(message.id);
      if (!pending) return;
      networkBridge.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data || {});
      else {
        const error = new Error(message.message || "1688 聊天接口返回异常");
        error.retryable = Boolean(message.retryable);
        pending.reject(error);
      }
      return;
    }
    if (message.type === "CAPTURED_1688_CHAT_RESPONSE" && message.payload) {
      state.payloads.push(message.payload);
    }
  };
  networkBridge.port.start();
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/modules/chat-export/content/injected-network.js");
  script.onload = () => {
    script.remove();
    window.postMessage({ type: "GD_CHAT_NETWORK_INIT", nonce: networkBridge.nonce }, window.location.origin, [channel.port2]);
  };
  (document.head || document.documentElement).appendChild(script);
}

function isDirectBridgeAvailable() {
  return Boolean(networkBridge.ready && networkBridge.port);
}

function directBridgeRequest(api, data, timeout = DIRECT_REQUEST_TIMEOUT_MS) {
  if (!isDirectBridgeAvailable()) {
    return Promise.reject(new Error("1688 页面直连接口尚未就绪"));
  }

  const id = `lai-direct-${Date.now()}-${networkBridge.requestId += 1}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      networkBridge.pending.delete(id);
      const error = new Error("1688 聊天接口超过 30 秒没有响应");
      error.retryable = true;
      reject(error);
    }, timeout);
    networkBridge.pending.set(id, { resolve, reject, timer });
    networkBridge.port.postMessage({
      type: "GD_CHAT_DIRECT_REQUEST",
      nonce: networkBridge.nonce,
      id,
      api,
      data
    });
  });
}

async function directRequestWithRetry(api, data) {
  let lastError = null;
  for (let attempt = 0; attempt <= DIRECT_RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfCanceled();
    await waitIfPaused();
    try {
      return await directBridgeRequest(api, data);
    } catch (error) {
      lastError = error;
      if (!error?.retryable || attempt === DIRECT_RETRY_DELAYS_MS.length) break;
      await sleep(DIRECT_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError || new Error("1688 聊天接口请求失败");
}

function fieldByLabel(label) {
  return Array.from(document.querySelectorAll(".ant-form-item"))
    .find((item) => item.innerText.includes(label));
}

function buttonByText(text) {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.innerText.trim().includes(text));
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function readEmployees() {
  const dropdown = await openEmployeeDropdown();
  await sleep(150);

  const names = await readAllEmployeeNamesFromDropdown(dropdown);

  document.body.click();
  fireKeyboard(document.activeElement, "Escape");
  return names;
}

async function openEmployeeDropdown() {
  const field = fieldByLabel("员工账号");
  const selector = field?.querySelector(".ant-select-selector, .ant-select");
  const input = field?.querySelector("input[role=\"combobox\"], .ant-select-selection-search-input, input");

  if (!selector) throw new Error("没有找到员工账号下拉框。");

  selector.scrollIntoView({ block: "center", inline: "nearest" });
  input?.focus();
  fireMouseSequence(selector);
  fireMouseSequence(input || selector);
  fireKeyboard(input || selector, "ArrowDown");

  const dropdown = await waitFor(() => Array.from(document.querySelectorAll(".ant-select-dropdown"))
    .find((node) => isVisible(node) && node.querySelector(".ant-select-item-option-content")));

  if (!dropdown) throw new Error("插件已经尝试自动打开员工账号下拉框，但没有读取到选项。");
  return dropdown;
}

function collectEmployeeNamesFromDropdown(dropdown, names) {
  const optionNodes = dropdown.querySelectorAll(
    ".ant-select-item-option:not(.ant-select-item-option-disabled) .ant-select-item-option-content"
  );

  for (const node of optionNodes) {
    const name = node.textContent.trim();
    if (name) names.add(name);
  }

  return names;
}

function findEmployeeDropdownScrollContainer(dropdown) {
  const candidates = [
    dropdown.querySelector(".rc-virtual-list-holder"),
    dropdown.querySelector(".ant-select-dropdown"),
    dropdown,
    ...Array.from(dropdown.querySelectorAll("div"))
  ].filter(Boolean);

  return candidates.find((node) => node.scrollHeight > node.clientHeight + 2) || dropdown;
}

async function readAllEmployeeNamesFromDropdown(dropdown) {
  const names = new Set();
  const scroller = findEmployeeDropdownScrollContainer(dropdown);
  let stableRounds = 0;
  let lastSize = 0;
  let lastScrollTop = -1;

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(180);

  for (let round = 0; round < 80; round += 1) {
    collectEmployeeNamesFromDropdown(dropdown, names);

    if (names.size === lastSize) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastSize = names.size;
    }

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom && stableRounds >= 2) break;

    const nextScrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 80),
      scroller.scrollHeight
    );

    if (nextScrollTop === lastScrollTop && atBottom) break;

    lastScrollTop = scroller.scrollTop;
    scroller.scrollTop = nextScrollTop;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(180);
  }

  collectEmployeeNamesFromDropdown(dropdown, names);
  return Array.from(names);
}

async function findEmployeeOptionInDropdown(dropdown, name) {
  const scroller = findEmployeeDropdownScrollContainer(dropdown);

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(180);

  for (let round = 0; round < 100; round += 1) {
    const option = Array.from(dropdown.querySelectorAll(".ant-select-item-option-content"))
      .find((node) => node.textContent.trim() === name);

    if (option) return option;

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) break;

    const currentScrollTop = scroller.scrollTop;
    scroller.scrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 80),
      scroller.scrollHeight
    );
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(180);

    if (scroller.scrollTop === currentScrollTop) break;
  }

  return null;
}

async function chooseEmployee(name) {
  const dropdown = await openEmployeeDropdown();

  const option = await findEmployeeOptionInDropdown(dropdown, name);

  if (!option) throw new Error(`没有找到员工账号：${name}`);
  option.scrollIntoView({ block: "nearest", inline: "nearest" });
  fireMouseSequence(option);
  await sleep(300);
}

function dateCellSelector(date) {
  return `td[title="${date}"]:not(.ant-picker-cell-disabled) .ant-picker-cell-inner`;
}

function visiblePickerDropdown() {
  return Array.from(document.querySelectorAll(".ant-picker-dropdown"))
    .find((node) => isVisible(node));
}

function visibleDateCells() {
  const dropdown = visiblePickerDropdown();
  return Array.from(dropdown?.querySelectorAll("td[title]") || []);
}

function compareDate(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function dateValueMatches(text, inputValues, date) {
  const variants = [
    date,
    date.replaceAll("-", "/")
  ];
  return variants.some((variant) => text.includes(variant) || inputValues.includes(variant));
}

async function ensureDateCellVisible(date) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const direct = document.querySelector(dateCellSelector(date));
    if (direct && isVisible(direct)) return direct;

    const cells = visibleDateCells()
      .map((cell) => cell.getAttribute("title"))
      .filter(Boolean)
      .sort();

    const dropdown = visiblePickerDropdown();
    if (!dropdown || cells.length === 0) {
      await sleep(120);
      continue;
    }

    const first = cells[0];
    const last = cells[cells.length - 1];
    const prev = dropdown.querySelector(".ant-picker-header-prev-btn");
    const next = dropdown.querySelector(".ant-picker-header-next-btn");

    if (compareDate(date, first) < 0 && prev) {
      fireMouseSequence(prev);
      await sleep(250);
      continue;
    }

    if (compareDate(date, last) > 0 && next) {
      fireMouseSequence(next);
      await sleep(250);
      continue;
    }

    break;
  }

  return null;
}

async function clickDateCell(date) {
  const cell = await ensureDateCellVisible(date);
  if (!cell) throw new Error(`没有找到日期：${date}`);
  fireMouseSequence(cell);
  await sleep(250);
}

async function selectDateRangeSequentially(field, picker, inputs, startDate, endDate) {
  picker.scrollIntoView({ block: "center", inline: "nearest" });
  fireMouseSequence(inputs[0] || picker);

  const dropdown = await waitFor(visiblePickerDropdown, { timeout: 2500 });
  if (!dropdown) throw new Error("没有打开操作时间日历。");

  await clickDateCell(startDate);
  fireMouseSequence(inputs[1] || picker);
  await sleep(120);
  await clickDateCell(endDate);

  fireKeyboard(inputs[1] || picker, "Enter");
  document.body.click();
  await sleep(200);

  const appliedText = field.innerText.replace(/\s+/g, "");
  const normalizedStart = startDate.replaceAll("-", "/");
  const normalizedEnd = endDate.replaceAll("-", "/");
  const inputValues = inputs.map((input) => input.value).join("|");

  if (!dateValueMatches(appliedText, inputValues, startDate)) {
    throw new Error(`开始日期没有应用成功：${startDate}`);
  }

  if (!dateValueMatches(appliedText, inputValues, endDate)) {
    throw new Error(`结束日期没有应用成功：${endDate}`);
  }
}

async function fillDateRange(startDate, endDate) {
  const field = fieldByLabel("操作时间");
  const picker = field?.querySelector(".ant-picker-range, .ant-picker");
  const inputs = Array.from(field?.querySelectorAll("input") || []);
  if (!picker || inputs.length < 2) throw new Error("没有找到操作时间日期控件。");

  await selectDateRangeSequentially(field, picker, inputs, startDate, endDate);
}

function normalizedImageUrl(url) {
  const clean = String(url || "")
    .replaceAll("\\/", "/")
    .replace(/&amp;/g, "&")
    .replace(/[),.;]+$/, "");

  if (clean.startsWith("//")) return `https:${clean}`;
  return clean;
}

function imageUrlsFromAnyValue(value) {
  const urls = new Set();
  const pattern = /(?:https?:)?\/\/[^\s"'<>\\]+?(?:\.jpg|\.jpeg|\.png|\.gif|\.webp)(?:[^\s"'<>\\]*)?/gi;

  function visit(current) {
    if (current === null || current === undefined) return;

    if (typeof current === "string") {
      const normalized = current.replaceAll("\\/", "/");
      for (const match of normalized.matchAll(pattern)) {
        urls.add(normalizedImageUrl(match[0]));
      }

      const trimmed = current.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          return;
        }
      }
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }

    if (typeof current === "object") Object.values(current).forEach(visit);
  }

  visit(value);
  return Array.from(urls);
}

function firstString(row, keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row[key] !== null && row[key] !== "") return String(row[key]);
  }
  return "";
}

function looksLikeChatRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  return Boolean(
    firstString(row, ["content", "message", "msgContent", "text"]) ||
    firstString(row, ["sendTime", "chatTime", "gmtCreate", "createTime"]) ||
    imageUrlsFromAnyValue(row).length
  );
}

function findRows(payload) {
  if (Array.isArray(payload) && payload.some(looksLikeChatRow)) return payload;

  const direct = payload?.data?.list ||
    payload?.data?.records ||
    payload?.data?.result ||
    payload?.list ||
    payload?.records ||
    payload?.result;

  if (Array.isArray(direct)) return direct;

  const found = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.some(looksLikeChatRow)) {
        found.push(...value.filter((item) => typeof item === "object"));
        return;
      }
      value.forEach(visit);
      return;
    }
    Object.values(value).forEach(visit);
  }
  visit(payload);
  return found;
}

function extractRowsFromPayload(payload, employee) {
  return findRows(payload).map((row) => ({
    employee: firstString(row, ["employeeName", "employeeAccount", "sellerNick", "staffName", "serviceName"]) || employee,
    customer: firstString(row, ["buyerLoginId", "buyerNick", "customerName", "customerAccount", "buyerName"]),
    time: firstString(row, ["sendTime", "chatTime", "gmtCreate", "createTime", "time"]),
    sender: firstString(row, ["senderName", "fromNick", "sender", "speaker", "role"]),
    message: firstString(row, ["content", "message", "msgContent", "text"]),
    images: imageUrlsFromAnyValue(row),
    raw: row
  }));
}

function completeRowsFromPayloads(payloads, employee) {
  const rows = payloads.flatMap((item) => extractRowsFromPayload(item.body, employee))
    .filter((row) => row.time && row.customer && (row.message || row.images?.length));
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.employee}|${row.customer}|${row.time}|${row.sender}|${row.message}|${(row.images || []).join(",")}`;
    unique.set(key, row);
  }
  return Array.from(unique.values());
}

async function waitForCompletePayloadRows(employee, options = {}) {
  const timeout = options.timeout ?? 900;
  const settleDuration = options.settleDuration ?? 120;
  const startedAt = Date.now();
  let latestRows = [];
  let lastCount = 0;
  let stableSince = 0;

  while (Date.now() - startedAt < timeout) {
    const rows = completeRowsFromPayloads(state.payloads, employee);
    if (rows.length > 0) {
      if (rows.length === lastCount) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= settleDuration) return rows;
      } else {
        latestRows = rows;
        lastCount = rows.length;
        stableSince = Date.now();
      }
    }
    await sleep(60);
  }

  return latestRows;
}

function payloadRowsForCustomer(payloads, employee, customer) {
  const aliases = new Set(customerAccountAliases(customer));
  return completeRowsFromPayloads(payloads, employee).filter((row) => {
    const rowAliases = customerAccountAliases(row.customer);
    return rowAliases.some((alias) => aliases.has(alias));
  });
}

async function waitForCustomerPayloadRows(employee, customer, firstPayloadIndex, options = {}) {
  // Keep the former 700ms customer-switch budget as the safety ceiling.
  // Interface responses that arrive quickly return much earlier after stabilising.
  const timeout = options.timeout ?? 700;
  const settleDuration = options.settleDuration ?? 90;
  const startedAt = Date.now();
  let latestRows = [];
  let lastCount = 0;
  let stableSince = 0;

  while (Date.now() - startedAt < timeout) {
    const rows = payloadRowsForCustomer(state.payloads.slice(firstPayloadIndex), employee, customer);
    if (rows.length > 0) {
      if (rows.length === lastCount) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= settleDuration) return rows;
      } else {
        latestRows = rows;
        lastCount = rows.length;
        stableSince = Date.now();
      }
    }
    await sleep(40);
  }

  return latestRows;
}

function directClean(value) {
  return value == null ? "" : String(value).trim();
}

function directComparableName(value) {
  return directClean(value)
    .replace(/^(cnalichn|cntaobao|cnalimam|enaliint)/i, "")
    .split(/[:：]/)
    .pop()
    .replace(/[（(]1688[）)]$/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function directChinaTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return "";
  return new Date(value + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function directParseJson(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return {};
  }
}

function directNickname(value) {
  return directClean(value).replace(/^(cnalichn|cntaobao|cnalimam|enaliint)/i, "");
}

function directAccount(value) {
  return directNickname(value).split(/[:：]/)[0] || "";
}

function directDisplayName(value) {
  const nickname = directNickname(value);
  const parts = nickname.split(/[:：]/);
  return parts[parts.length - 1] || nickname;
}

function directMessageBody(dto) {
  const content = directParseJson(dto?.content);
  if (Number(dto?.contentType) === 1) {
    return { message: directClean(content.text ?? dto.content), images: [] };
  }
  if (Number(dto?.contentType) === 101) {
    const data = directParseJson(content.data);
    if (Number(content.type) === 7 && data.url) return { message: "", images: [normalizedImageUrl(data.url)] };
    const title = directClean(content.title);
    const summary = directClean(content.summary);
    return { message: [title, summary && summary !== title ? summary : ""].filter(Boolean).join(" ") || directClean(content.degradeText) || "[卡片消息]", images: [] };
  }
  return {
    message: directClean(content.text || content.summary || content.title || content.degradeText) || `[消息类型 ${dto?.contentType ?? "未知"}]`,
    images: []
  };
}

function directPeriodBounds(period) {
  const start = new Date(`${period.startDate}T00:00:00+08:00`).getTime();
  const end = new Date(`${period.endDate}T23:59:59.999+08:00`).getTime();
  return { start, end };
}

async function directFindEmployee(employee) {
  if (directEmployeeCache.has(employee)) return directEmployeeCache.get(employee);
  const data = await directRequestWithRetry(DIRECT_API.employees, {});
  const target = directComparableName(employee);
  const entries = Array.isArray(data?.result) ? data.result : [];
  const match = entries.find((item) => directComparableName(item?.subLoginId) === target)
    || entries.find((item) => {
      const candidate = directComparableName(item?.subLoginId);
      return Boolean(candidate && target && (candidate.includes(target) || target.includes(candidate)));
    });
  if (!match?.subUserId) throw new Error(`直连接口没有找到员工账号：${employee}`);
  const result = { id: String(match.subUserId), name: directClean(match.subLoginId) || employee };
  directEmployeeCache.set(employee, result);
  return result;
}

function directConversations(data) {
  const seen = new Set();
  const conversations = [];
  for (const item of (Array.isArray(data?.result) ? data.result : [])) {
    const extra = item?.extraInfo || {};
    const conversationId = item?.cid?.appCid;
    if (!conversationId || extra.sellerUserId == null) continue;
    const key = `${conversationId}|${extra.sellerUserId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conversations.push({
      conversationId: String(conversationId),
      sellerUserId: extra.sellerUserId,
      sellerLoginId: directClean(extra.sellerLoginId),
      customerId: extra.toUserId == null ? "" : String(extra.toUserId),
      customer: directClean(extra.toSNick) || directClean(item.displayName) || "未知客户"
    });
  }
  return conversations;
}

function directRowsFromMessageResponse(data, conversation, employee, period = null) {
  const bounds = period ? directPeriodBounds(period) : null;
  const rows = [];
  for (const raw of (Array.isArray(data?.userMessages) ? data.userMessages : [])) {
    const dto = raw?.imSendMessageDTO;
    const sentAt = Number(dto?.sendTime);
    if (!dto || !Number.isFinite(sentAt) || (bounds && (sentAt < bounds.start || sentAt > bounds.end))) continue;
    const ext = directParseJson(dto.ext);
    const senderNickname = directClean(ext.sender_nick);
    const isCustomer = (directClean(ext.senderUserId) && directClean(ext.senderUserId) === conversation.customerId)
      || (directAccount(senderNickname) && directAccount(conversation.sellerLoginId) && directAccount(senderNickname) !== directAccount(conversation.sellerLoginId));
    const body = directMessageBody(dto);
    rows.push({
      employee: !bounds && !isCustomer ? (directDisplayName(senderNickname) || employee) : employee,
      customer: conversation.customer,
      time: directChinaTime(sentAt),
      sender: directDisplayName(senderNickname) || (isCustomer ? conversation.customer : employee),
      message: body.message,
      messageDirection: isCustomer ? "customer" : "employee",
      images: body.images,
      raw
    });
  }
  return rows;
}

async function directListEmployeeConversations(employee, period) {
  const directEmployee = await directFindEmployee(employee);
  const data = await directRequestWithRetry(DIRECT_API.conversations, {
    pageNo: 1,
    pageSize: 1000,
    callerType: "cbu_im_mtop",
    beginDate: period.startDate.replaceAll("-", ""),
    endDate: period.endDate.replaceAll("-", ""),
    userId: directEmployee.id
  });
  return directConversations(data);
}

async function directFetchCustomerRows(conversation, employee, period) {
  const rowsByKey = new Map();
  const bounds = directPeriodBounds(period);
  let cursor = bounds.start;
  for (let page = 0; page < DIRECT_MAX_PAGES_PER_CUSTOMER; page += 1) {
    const data = await directRequestWithRetry(DIRECT_API.messages, {
      count: 100,
      appCid: conversation.conversationId,
      realUserId: conversation.sellerUserId,
      cursor,
      forward: true,
      queryDispatchDebugLog: false
    });
    for (const row of directRowsFromMessageResponse(data, conversation, employee, period)) {
      const key = `${row.raw?.imSendMessageDTO?.messageId || ""}|${row.time}|${row.sender}|${row.message}`;
      rowsByKey.set(key, row);
    }
    const pageMessages = Array.isArray(data?.userMessages) ? data.userMessages : [];
    const nextCursor = data?.hasMore && pageMessages.length && data?.nextCursor ? data.nextCursor : null;
    const latestMessageAt = pageMessages.reduce((latest, item) => Math.max(latest, Number(item?.imSendMessageDTO?.sendTime) || 0), 0);
    if (!nextCursor || String(nextCursor) === String(cursor) || latestMessageAt > bounds.end) break;
    cursor = nextCursor;
  }
  return Array.from(rowsByKey.values());
}

async function directFetchCustomerHistoryRows(conversation) {
  const rowsByKey = new Map();
  let cursor = Date.now();
  for (let page = 0; page < DIRECT_MAX_PAGES_PER_CUSTOMER; page += 1) {
    const data = await directRequestWithRetry(DIRECT_API.messages, {
      count: 100,
      appCid: conversation.conversationId,
      realUserId: conversation.sellerUserId,
      cursor,
      forward: false,
      queryDispatchDebugLog: false
    });
    for (const row of directRowsFromMessageResponse(data, conversation, "客户完整记录")) {
      const key = `${row.raw?.imSendMessageDTO?.messageId || ""}|${row.time}|${row.sender}|${row.message}`;
      rowsByKey.set(key, row);
    }
    const pageMessages = Array.isArray(data?.userMessages) ? data.userMessages : [];
    const nextCursor = data?.hasMore && pageMessages.length && data?.nextCursor ? data.nextCursor : null;
    if (!nextCursor || String(nextCursor) === String(cursor)) break;
    cursor = nextCursor;
  }
  return Array.from(rowsByKey.values()).sort((left, right) => String(left.time).localeCompare(String(right.time)));
}

async function mapDirectBatch(conversations, onProgress) {
  const results = new Array(conversations.length);
  const queue = conversations.map((conversation, index) => ({ conversation, index }));
  let finished = 0;
  async function worker() {
    while (queue.length) {
      throwIfCanceled();
      await waitIfPaused();
      const next = queue.shift();
      try {
        results[next.index] = { rows: await onProgress.fetch(next.conversation), conversation: next.conversation };
      } catch (error) {
        if (error?.message === "__EXPORT_CANCELED__") throw error;
        results[next.index] = { rows: [], conversation: next.conversation, error };
      }
      finished += 1;
      onProgress.report(finished, results);
    }
  }
  await Promise.all(Array.from({ length: Math.min(DIRECT_CONCURRENCY, conversations.length) }, worker));
  return results;
}

async function tryDirectPeriodExport({ employee, period, progressPrefix }) {
  if (!isDirectBridgeAvailable()) return null;
  const conversations = await directListEmployeeConversations(employee, period);
  const rows = [];
  const failures = [];

  for (let offset = 0; offset < conversations.length; offset += DIRECT_BATCH_SIZE) {
    const batch = conversations.slice(offset, offset + DIRECT_BATCH_SIZE);
    const batchNumber = Math.floor(offset / DIRECT_BATCH_SIZE) + 1;
    const batchTotal = Math.ceil(conversations.length / DIRECT_BATCH_SIZE);
    sendProgress(`${progressPrefix}直连读取第 ${batchNumber}/${batchTotal} 批：客户 ${offset + 1}~${offset + batch.length}/${conversations.length}（4 路并发）`);
    const results = await mapDirectBatch(batch, {
      fetch: (conversation) => directFetchCustomerRows(conversation, employee, period),
      report: (finished, currentResults) => {
        const messageCount = currentResults.slice(0, finished).reduce((total, result) => total + (result?.rows?.length || 0), 0);
        sendProgress(`${progressPrefix}直连第 ${batchNumber}/${batchTotal} 批：已完成 ${finished}/${batch.length} 位客户，${messageCount} 条消息`);
      }
    });
    for (const result of results) {
      rows.push(...(result?.rows || []));
      if (result?.error) failures.push({ customer: result.conversation.customer, message: result.error.message || "读取失败" });
    }
  }
  return { rows, customerCount: conversations.length, failures };
}

async function tryDirectCustomerHistoryExport({ employees, periods }) {
  if (!isDirectBridgeAvailable()) throw new Error("1688 页面直连接口尚未就绪，请刷新聊天记录页面后重试。");
  const conversationsById = new Map();
  const totalListSteps = employees.length * periods.length;
  let listStep = 0;

  for (const employee of employees) {
    for (const period of periods) {
      throwIfCanceled();
      await waitIfPaused();
      listStep += 1;
      sendProgress(`[完整记录] 正在筛选客户 ${listStep}/${totalListSteps}：${employee} ${period.startDate}至${period.endDate}`);
      const conversations = await directListEmployeeConversations(employee, period);
      for (const conversation of conversations) {
        if (!conversationsById.has(conversation.conversationId)) conversationsById.set(conversation.conversationId, conversation);
      }
    }
  }

  const conversations = Array.from(conversationsById.values());
  const files = [];
  const failures = [];
  for (let offset = 0; offset < conversations.length; offset += DIRECT_BATCH_SIZE) {
    const batch = conversations.slice(offset, offset + DIRECT_BATCH_SIZE);
    const batchNumber = Math.floor(offset / DIRECT_BATCH_SIZE) + 1;
    const batchTotal = Math.ceil(conversations.length / DIRECT_BATCH_SIZE);
    sendProgress(`[完整记录] 第 ${batchNumber}/${batchTotal} 批：客户 ${offset + 1}~${offset + batch.length}/${conversations.length}（4 路并发读取完整记录）`);
    const results = await mapDirectBatch(batch, {
      fetch: (conversation) => directFetchCustomerHistoryRows(conversation),
      report: (finished, currentResults) => {
        const messageCount = currentResults.reduce((total, result) => total + (result?.rows?.length || 0), 0);
        sendProgress(`[完整记录] 第 ${batchNumber}/${batchTotal} 批：完成 ${finished}/${batch.length} 位客户，已读取 ${messageCount} 条消息`);
      }
    });
    for (const result of results) {
      if (result?.rows?.length) files.push({ customer: result.conversation.customer, rows: result.rows });
      if (result?.error) failures.push({ customer: result.conversation.customer, message: result.error.message || "读取失败" });
    }
  }

  return { files, customerCount: conversations.length, failures };
}

function chatTimePattern() {
  return /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/;
}

function waitForChatDetailPanel() {
  return waitFor(() => {
    const candidates = Array.from(document.querySelectorAll("div, section, aside"))
      .filter((node) => {
        const text = node.innerText || "";
        return isVisible(node) && text.includes("聊天记录详情") && text.includes("客户账号列表");
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (aRect.width * aRect.height) - (bRect.width * bRect.height);
      });

    return candidates[0] || null;
  }, { timeout: 8000, interval: 120 });
}

function isCustomerName(text) {
  const value = String(text || "").trim();
  return value.length > 0 &&
    value.length <= 80 &&
    /\(1688\)$/.test(value) &&
    !value.includes("客户账号列表");
}

function visibleText(element) {
  return (element.innerText || element.textContent || "").trim();
}

function smallestVisibleTextNode(container, text) {
  return Array.from(container.querySelectorAll("div, li, span"))
    .filter((node) => isVisible(node) && visibleText(node) === text)
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (aRect.width * aRect.height) - (bRect.width * bRect.height);
    })[0] || null;
}

function collectCustomerNamesFromDetail(container, names) {
  for (const node of container.querySelectorAll("div, li, span")) {
    const text = visibleText(node);
    if (isCustomerName(text)) names.add(text);
  }
  return names;
}

function findCustomerListScrollContainer(panel) {
  const candidates = [
    ...Array.from(panel.querySelectorAll("div, ul, section, aside")),
    panel
  ].filter(Boolean);

  const scrollable = candidates
    .filter((node) => node.scrollHeight > node.clientHeight + 2)
    .filter((node) => {
      const names = new Set();
      collectCustomerNamesFromDetail(node, names);
      return names.size > 0 || (node.innerText || "").includes("客户账号列表");
    })
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (aRect.width * aRect.height) - (bRect.width * bRect.height);
    });

  return scrollable[0] || panel;
}

const customerListCache = new WeakMap();

async function readAllCustomersFromDetail(panel) {
  const names = new Set();
  const scroller = findCustomerListScrollContainer(panel);
  const positions = new Map();
  customerListCache.set(panel, { scroller, positions });
  let stableRounds = 0;
  let lastSize = 0;

  await scrollAndWait(scroller, 0);

  for (let round = 0; round < 100; round += 1) {
    throwIfCanceled();
    const visibleNames = collectCustomerNamesFromDetail(scroller, new Set());
    for (const name of visibleNames) {
      if (!positions.has(name)) positions.set(name, scroller.scrollTop);
    }
    collectCustomerNamesFromDetail(scroller, names);

    if (names.size === lastSize) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastSize = names.size;
    }

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom && stableRounds >= 2) break;

    const currentScrollTop = scroller.scrollTop;
    const nextScrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 80),
      scroller.scrollHeight
    );
    await scrollAndWait(scroller, nextScrollTop);

    if (scroller.scrollTop === currentScrollTop && atBottom) break;
  }

  collectCustomerNamesFromDetail(scroller, names);
  return Array.from(names);
}

async function clickCustomerInDetail(panel, customer, employee) {
  const cached = customerListCache.get(panel);
  const scroller = cached?.scroller?.isConnected
    ? cached.scroller : findCustomerListScrollContainer(panel);

  // Jump to the position discovered while enumerating the virtual list.
  // Fall back to the original full scan if the page has changed.
  if (cached?.positions.has(customer)) {
    await scrollAndWait(scroller, cached.positions.get(customer));
    throwIfCanceled();
    const node = smallestVisibleTextNode(scroller, customer);
    if (node) {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
      const firstPayloadIndex = state.payloads.length;
      fireMouseSequence(node);
      return waitForCustomerPayloadRows(employee, customer, firstPayloadIndex);
    }
  }

  await scrollAndWait(scroller, 0);

  for (let round = 0; round < 100; round += 1) {
    const node = smallestVisibleTextNode(scroller, customer);
    if (node) {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
      const firstPayloadIndex = state.payloads.length;
      fireMouseSequence(node);
      return waitForCustomerPayloadRows(employee, customer, firstPayloadIndex);
    }

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) break;

    const currentScrollTop = scroller.scrollTop;
    const nextScrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 80),
      scroller.scrollHeight
    );
    await scrollAndWait(scroller, nextScrollTop);

    if (scroller.scrollTop === currentScrollTop && atBottom) break;
  }

  throw new Error(`没有找到客户账号：${customer}`);
}

function imageUrlsFromElement(element) {
  const urls = new Set();
  for (const image of element.querySelectorAll("img")) {
    const url = image.currentSrc || image.src;
    if (url && !url.startsWith("data:")) urls.add(normalizedImageUrl(url));
  }
  return Array.from(urls);
}

function elementClassText(element) {
  return String(`${element?.className || ""} ${element?.getAttribute?.("class") || ""}`);
}

function hasGeneratedClass(element, name) {
  return elementClassText(element)
    .split(/\s+/)
    .some((item) => item.includes(`${name}_`));
}

function findFirstGeneratedClass(element, name, selector = "div, li, span, p, article") {
  return Array.from(element.querySelectorAll(selector))
    .find((node) => hasGeneratedClass(node, name)) || null;
}

function closestGeneratedClass(element, names, stopAt) {
  let current = element;
  while (current && current !== stopAt) {
    if (names.some((name) => hasGeneratedClass(current, name))) return current;
    const classText = elementClassText(current).toLowerCase();
    if (names.some((name) => classText.includes(name.toLowerCase()))) return current;
    current = current.parentElement;
  }
  return null;
}

function senderTextFromUserNode(userNode, timeText) {
  return visibleText(userNode)
    .replace(timeText || "", "")
    .replace(/\s+/g, " ")
    .trim();
}

function structuredMessageText(detailNode) {
  if (!detailNode) return "";
  const nodes = [detailNode, ...Array.from(detailNode.querySelectorAll("div, p, span"))];
  const texts = [];

  for (const node of nodes) {
    const text = visibleText(node);
    if (!text || text === "预览") continue;
    if (node.querySelectorAll?.("img").length) continue;
    if (Array.from(node.children || []).some((child) => visibleText(child))) continue;
    if (closestGeneratedClass(node, ["ant-image", "image-mask", "mask", "icon", "image"], detailNode)) continue;
    if (!texts.includes(text)) texts.push(text);
  }

  return texts.join("\n").trim();
}

function collectStructuredChatRows(panel, employee, customer) {
  const wrappers = Array.from(panel.querySelectorAll("li, div"))
    .filter((node) => hasGeneratedClass(node, "chatWrap"));
  const rows = [];

  for (const wrapper of wrappers) {
    const direction = hasGeneratedClass(wrapper, "seller")
      ? "employee"
      : (hasGeneratedClass(wrapper, "buyer") ? "customer" : messageDirectionFromElement(wrapper));
    const userNode = findFirstGeneratedClass(wrapper, "userId");
    const detailNode = findFirstGeneratedClass(wrapper, "chatDetail");
    const timeNode = userNode ? findFirstGeneratedClass(userNode, "time", "span, div") : null;
    const time = visibleText(timeNode) || visibleText(wrapper).match(chatTimePattern())?.[0] || "";
    const sender = userNode ? senderTextFromUserNode(userNode, time) : "";
    const message = structuredMessageText(detailNode);
    const images = imageUrlsFromElement(detailNode || wrapper);

    if (!time || (!sender && !message && images.length === 0)) continue;
    rows.push({
      employee,
      customer,
      time,
      sender,
      message,
      messageDirection: direction,
      images
    });
  }

  return rows;
}

function chatMessageBlocks(panel) {
  const pattern = chatTimePattern();
  return Array.from(panel.querySelectorAll("div, li, p, article"))
    .filter((node) => {
      const text = visibleText(node);
      if (!text || !pattern.test(text)) return false;
      if (text.includes("客户账号列表")) return false;
      return !Array.from(node.children).some((child) => pattern.test(visibleText(child)));
    })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function messageDirectionFromElement(element) {
  if (!element) return "";
  const classText = `${element.className || ""} ${element.getAttribute?.("class") || ""}`.toLowerCase();
  if (/(right|self|mine|own|send|sent|seller|employee|staff)/.test(classText)) return "employee";
  if (/(left|buyer|customer|receive|received)/.test(classText)) return "customer";

  const style = window.getComputedStyle(element);
  if (style.textAlign === "right") return "employee";
  if (style.textAlign === "left") return "customer";

  const rect = element.getBoundingClientRect();
  const parentRect = element.parentElement?.getBoundingClientRect();
  if (parentRect && rect.width > 0) {
    const elementCenter = rect.left + rect.width / 2;
    const parentCenter = parentRect.left + parentRect.width / 2;
    if (elementCenter > parentCenter + 20) return "employee";
    if (elementCenter < parentCenter - 20) return "customer";
  }

  return "";
}

function compactIdentity(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function customerAccountAliases(customer) {
  const value = compactIdentity(customer);
  if (!value) return [];

  const aliases = new Set([value]);
  const without1688Suffix = value.replace(/[\uff08(]1688[\uff09)]$/i, "");
  if (without1688Suffix) aliases.add(without1688Suffix);

  const beforeBracket = value.split(/[\uff08(]/)[0];
  if (beforeBracket) aliases.add(beforeBracket);

  return Array.from(aliases).filter((alias) => alias.length >= 2);
}

function textStartsWithCustomerAccount(text, customer) {
  const value = compactIdentity(text);
  if (!value) return false;
  return customerAccountAliases(customer).some((alias) => (
    value === alias ||
    value.startsWith(`${alias}:`) ||
    value.startsWith(`${alias}\uff1a`) ||
    value.startsWith(alias)
  ));
}

function splitCompactStaffPrefix(text) {
  const value = String(text || "").trim();
  const numberedMessage = value.match(/^([一二三四五六七八九十冬腊正]{1,3}月)(\d+\s*[:：][\s\S]*)$/);
  if (numberedMessage) {
    return {
      staff: numberedMessage[1].trim(),
      message: numberedMessage[2].trim()
    };
  }

  const monthStaff = value.match(/^([一二三四五六七八九十冬腊正]{1,3}月)([^:：\s][\s\S]*)$/);
  if (monthStaff) {
    return {
      staff: monthStaff[1].trim(),
      message: monthStaff[2].trim()
    };
  }

  return null;
}

function splitEmployeeSenderAndMessage(text, employee, messageDirection) {
  const value = String(text || "").trim();
  const selectedEmployee = String(employee || "").trim();
  if (!value) return null;

  const fullEmployeeMatch = selectedEmployee.match(/^(.+?)[:：]([^:：\s]+)$/);
  if (fullEmployeeMatch && value.startsWith(selectedEmployee)) {
    const rest = value.slice(selectedEmployee.length).trimStart();
    return {
      sender: selectedEmployee,
      message: rest.replace(/^[:：]\s*/, "").trim()
    };
  }

  const employeeBases = [
    selectedEmployee,
    fullEmployeeMatch?.[1]
  ].filter(Boolean);

  for (const base of Array.from(new Set(employeeBases)).sort((a, b) => b.length - a.length)) {
    if (!value.startsWith(`${base}:`) && !value.startsWith(`${base}：`)) continue;

    const afterBase = value.slice(base.length + 1).trimStart();
    const compactStaff = splitCompactStaffPrefix(afterBase);
    if (compactStaff) {
      return {
        sender: `${base}:${compactStaff.staff}`,
        message: compactStaff.message
      };
    }

    const staffMatch = afterBase.match(/^([^:：\s]{1,30})(?:[:：]\s*|\s+)([\s\S]*)$/);
    if (staffMatch) {
      return {
        sender: `${base}:${staffMatch[1].trim()}`,
        message: staffMatch[2].trim()
      };
    }
  }

  if (messageDirection === "employee") {
    const genericMatch = value.match(/^([\u4e00-\u9fa5A-Za-z0-9_.-]{2,40})[:：]([^:：\s]{1,30})(?:[:：]\s*|\s+)([\s\S]*)$/);
    if (genericMatch) {
      return {
        sender: `${genericMatch[1].trim()}:${genericMatch[2].trim()}`,
        message: genericMatch[3].trim()
      };
    }
  }

  return null;
}

function parseChatText(text, employee, customer, images = [], messageDirection = "") {
  const rows = [];
  let current = null;

  for (const line of String(text || "").split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
    if (["聊天关系", "聊天记录详情", "客户账号列表"].includes(line)) continue;

    const timeMatch = line.match(chatTimePattern());
    if (timeMatch) {
      if (current) rows.push(current);
      const senderBeforeTime = line.slice(0, timeMatch.index).trim();
      const rest = line.slice(timeMatch.index + timeMatch[0].length).trim();
      const senderMatch = rest.match(/^([^:：]{1,80})[:：]\s*(.*)$/);
      const employeeSender = senderBeforeTime ? null : splitEmployeeSenderAndMessage(rest, employee, messageDirection);
      const sender = senderBeforeTime || (senderMatch ? senderMatch[1].trim() : rest);
      const parsedDirection = senderBeforeTime && textStartsWithCustomerAccount(senderBeforeTime, customer)
        ? "customer"
        : messageDirection;
      current = {
        employee,
        customer,
        time: timeMatch[0],
        sender: employeeSender?.sender || sender,
        message: senderBeforeTime ? rest : (employeeSender?.message ?? (senderMatch ? senderMatch[2].trim() : "")),
        messageDirection: parsedDirection,
        images: []
      };
      continue;
    }

    if (current) {
      current.message = current.message ? `${current.message}\n${line}` : line;
    }
  }

  if (current) rows.push(current);
  if (images.length && rows.length > 0) rows[0].images = images;
  return rows;
}

function collectRowsFromDetailPanel(panel, employee, customer) {
  const structuredRows = collectStructuredChatRows(panel, employee, customer);
  if (structuredRows.length > 0) return structuredRows;

  const blocks = chatMessageBlocks(panel);
  const rows = [];

  for (const block of blocks) {
    rows.push(...parseChatText(
      visibleText(block),
      employee,
      customer,
      imageUrlsFromElement(block),
      messageDirectionFromElement(block)
    ));
  }

  if (rows.length === 0) {
    return parseChatText(visibleText(panel), employee, customer, imageUrlsFromElement(panel));
  }

  return rows;
}

function findMessageScrollContainer(panel) {
  const pattern = chatTimePattern();
  const candidates = [
    ...Array.from(panel.querySelectorAll("div, section, main")),
    panel
  ].filter((node) => node.scrollHeight > node.clientHeight + 2 && pattern.test(visibleText(node)));

  return candidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return (aRect.width * aRect.height) - (bRect.width * bRect.height);
  })[0] || panel;
}

async function extractRowsFromCurrentCustomerDetail(panel, employee, customer) {
  const rowsByKey = new Map();
  const scroller = findMessageScrollContainer(panel);

  await scrollAndWait(scroller, 0);

  for (let round = 0; round < 80; round += 1) {
    for (const row of collectRowsFromDetailPanel(panel, employee, customer)) {
      const key = `${row.time}|${row.customer}|${row.sender}|${row.message}|${(row.images || []).join(",")}`;
      rowsByKey.set(key, row);
    }

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) break;

    const currentScrollTop = scroller.scrollTop;
    const nextScrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 120),
      scroller.scrollHeight
    );
    await scrollAndWait(scroller, nextScrollTop, { maximumWait: 220 });

    if (scroller.scrollTop === currentScrollTop && atBottom) break;
  }

  return Array.from(rowsByKey.values());
}

async function skipCustomer(customer, reason, progressPrefix = "") {
  sendProgress(`[跳过] ${progressPrefix}${customer}：${reason}`);
  await sleep(80);
}

async function skipEmployee(progressContext, reason) {
  sendProgress(`[跳过] ${periodEmployeeProgressPrefix(progressContext)}${reason}`);
  await sleep(120);
}

function downloadMessageType(exportFormat) {
  return exportFormat === "json" ? "DOWNLOAD_JSON" : "DOWNLOAD_EXCEL";
}

function exportFormatLabel(exportFormat) {
  return exportFormat === "json" ? "JSON" : "Excel";
}

function periodEmployeeProgressPrefix({ period, periodIndex, periodTotal, employee, employeeIndex, employeeTotal }) {
  return `[周期 ${periodIndex}/${periodTotal}] ${period.startDate}至${period.endDate} [员工 ${employeeIndex}/${employeeTotal}] ${employee}：`;
}

async function downloadEmployeeRows({ exportFormat, employee, employeeIndex, employeeTotal, period, periodIndex, periodTotal, rows, rawPayloads, storeName, syncToFeishu }) {
  const formatLabel = exportFormatLabel(exportFormat);
  const progressPrefix = periodEmployeeProgressPrefix({
    period,
    periodIndex,
    periodTotal,
    employee,
    employeeIndex,
    employeeTotal
  });

  if (rows.length === 0) {
    sendProgress(`${progressPrefix}没有聊天记录，跳过下载`);
    return { downloaded: false };
  }

  sendProgress(`${progressPrefix}扫描完成，正在下载 ${formatLabel}`);
  const request = chrome.runtime.sendMessage({
    module: MODULE_ID,
    type: downloadMessageType(exportFormat),
    taskId: exportControl.taskId,
    rows,
    rawPayloads,
    startDate: period.startDate,
    endDate: period.endDate,
    employeeCount: 1,
    employeeNames: [employee],
    storeName: storeName || A1688ChatExportDownloadFilename.resolveStoreName(rawPayloads),
    syncToFeishu: Boolean(syncToFeishu)
  });
  const result = await Promise.race([
    request,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${formatLabel} 生成文件超时，请重试。`)), 10 * 60 * 1000))
  ]);

  if (result?.canceled) {
    throw new Error("__EXPORT_CANCELED__");
  }

  if (!result?.ok) {
    throw new Error(result?.message || `${formatLabel} 下载失败`);
  }

  const syncText = result.feishu?.enabled
    ? (result.feishu.ok ? "，已同步飞书" : `，飞书同步失败：${result.feishu.message || "未知错误"}`)
    : "";
  sendProgress(`${progressPrefix}已下载 ${formatLabel}，${rows.length} 条记录${syncText}`);
  return { downloaded: true };
}

async function exportEmployees(request) {
  const exportStartedAt = performance.now();
  const exportFormat = ["json", "jsonl"].includes(request.exportFormat) ? "json" : "excel";
  const periods = A1688ChatExportDownloadFilename.createSevenDayPeriods(request.startDate, request.endDate);
  let downloadedCount = 0;
  let totalRows = 0;
  const batchArchive = request.employees.length > 1;
  const batchFiles = [];
  exportControl.paused = false;
  exportControl.canceled = false;
  exportControl.taskId = request.taskId || `chat-export-content-${Date.now()}`;

  for (let i = 0; i < request.employees.length; i += 1) {
    const employeeIndex = i + 1;
    const employeeTotal = request.employees.length;
    const employee = request.employees[i];
    const employeeArchiveRows = [];
    const employeeArchivePayloads = [];
    for (let periodOffset = 0; periodOffset < periods.length; periodOffset += 1) {
      throwIfCanceled();
      await waitIfPaused();

      const periodIndex = periodOffset + 1;
      const periodTotal = periods.length;
      const period = periods[periodOffset];
      const progressContext = { period, periodIndex, periodTotal, employee, employeeIndex, employeeTotal };
      const progressPrefix = periodEmployeeProgressPrefix(progressContext);
      const periodStartedAt = performance.now();
      let apiCustomerCount = 0;
      let pageCustomerCount = 0;
      try {
        const employeeRows = [];
        sendProgress(`${progressPrefix}正在设置日期`);

        state.payloads = [];
        await chooseEmployee(employee);
        await fillDateRange(period.startDate, period.endDate);

        // 优先用卖家工作台已登录页面的只读聊天接口。它避免了逐个点击客户和滚动消息，
        // 但接口异常或页面尚未加载签名组件时，下面仍会自动走原有页面读取流程。
        if (isDirectBridgeAvailable()) {
          try {
            sendProgress(`${progressPrefix}正在使用直连接口读取（每批 20 位客户、4 路并发）`);
            const directResult = await tryDirectPeriodExport({ employee, period, progressPrefix });
            if (directResult) {
              const skippedText = directResult.failures.length ? `，跳过 ${directResult.failures.length} 位客户` : "";
              const readSeconds = Math.round((performance.now() - periodStartedAt) / 1000);
              sendProgress(`${progressPrefix}直连读取完成，${directResult.rows.length} 条记录，${directResult.customerCount} 位客户，用时 ${readSeconds} 秒${skippedText}`);
              if (batchArchive) {
                employeeArchiveRows.push(...directResult.rows);
                sendProgress(`${progressPrefix}已汇总 ${directResult.rows.length} 条记录`);
              } else {
                const downloadResult = await downloadEmployeeRows({
                  exportFormat,
                  employee,
                  employeeIndex,
                  employeeTotal,
                  period,
                  periodIndex,
                  periodTotal,
                  rows: directResult.rows,
                  rawPayloads: [],
                  storeName: request.storeName,
                  syncToFeishu: Boolean(request.syncToFeishu)
                });
                if (downloadResult.downloaded) downloadedCount += 1;
              }
              totalRows += directResult.rows.length;
              continue;
            }
          } catch (directError) {
            if (directError?.message === "__EXPORT_CANCELED__") throw directError;
            sendProgress(`${progressPrefix}直连接口暂不可用（${directError?.message || "未知原因"}），已自动切换页面读取`);
          }
        }

        const queryButton = buttonByText("查询聊天记录");
        if (!queryButton) throw new Error("没有找到“查询聊天记录”按钮。");
        sendProgress(`${progressPrefix}正在查询聊天记录`);
        fireMouseSequence(queryButton);

        const detailPanel = await waitForChatDetailPanel();
        if (!detailPanel) {
          await skipEmployee(progressContext, "没有聊天记录或没有打开聊天记录详情");
          continue;
        }
        const capturedRows = await waitForCompletePayloadRows(employee);
        const rawPayloads = [...state.payloads];

        // 查询接口已返回完整消息时，直接使用网络响应，跳过逐个客户点击和滚动。
        if (capturedRows.length > 0) {
          sendProgress(`${progressPrefix}快速接口读取 ${capturedRows.length} 条记录，跳过客户列表和逐条滚动`);
          if (batchArchive) {
            employeeArchiveRows.push(...capturedRows);
            employeeArchivePayloads.push(...rawPayloads);
          } else {
            const downloadResult = await downloadEmployeeRows({
              exportFormat,
              employee,
              employeeIndex,
              employeeTotal,
              period,
              periodIndex,
              periodTotal,
              rows: capturedRows,
              rawPayloads,
              storeName: request.storeName,
              syncToFeishu: Boolean(request.syncToFeishu)
            });
            if (downloadResult.downloaded) downloadedCount += 1;
          }
          totalRows += capturedRows.length;
          continue;
        }

        sendProgress(`${progressPrefix}接口未返回完整消息，回退到客户详情读取`);

        const customers = await readAllCustomersFromDetail(detailPanel);
        sendProgress(`${progressPrefix}发现 ${customers.length} 个客户`);
        if (customers.length === 0) {
          for (const item of state.payloads) {
            employeeRows.push(...extractRowsFromPayload(item.body, employee));
          }
          if (batchArchive) {
            employeeArchiveRows.push(...employeeRows);
            employeeArchivePayloads.push(...rawPayloads);
            sendProgress(`${progressPrefix}已汇总 ${employeeRows.length} 条记录`);
          } else {
            const downloadResult = await downloadEmployeeRows({
              exportFormat,
              employee,
              employeeIndex,
              employeeTotal,
              period,
              periodIndex,
              periodTotal,
              rows: employeeRows,
              rawPayloads,
              storeName: request.storeName,
              syncToFeishu: Boolean(request.syncToFeishu)
            });
            if (downloadResult.downloaded) downloadedCount += 1;
          }
          totalRows += employeeRows.length;
          continue;
        }

        let skippedCustomers = 0;
        for (let customerIndex = 0; customerIndex < customers.length; customerIndex += 1) {
          throwIfCanceled();
          await waitIfPaused();

          const customer = customers[customerIndex];
          sendProgress(`${progressPrefix}客户 ${customerIndex + 1}/${customers.length} ${customer}：正在读取聊天详情`);
          try {
            const capturedCustomerRows = await clickCustomerInDetail(detailPanel, customer, employee);
            let customerRows;
            if (capturedCustomerRows?.length) {
              customerRows = capturedCustomerRows;
              apiCustomerCount += 1;
              sendProgress(`${progressPrefix}客户 ${customerIndex + 1}/${customers.length} ${customer}：接口快速读取 ${customerRows.length} 条，跳过详情滚动`);
            } else {
              customerRows = await extractRowsFromCurrentCustomerDetail(detailPanel, employee, customer);
              pageCustomerCount += 1;
              sendProgress(`${progressPrefix}客户 ${customerIndex + 1}/${customers.length} ${customer}：页面读取 ${customerRows.length} 条`);
            }
            employeeRows.push(...customerRows);
          } catch (error) {
            if (error.message === "__EXPORT_CANCELED__") throw error;
            skippedCustomers += 1;
            await skipCustomer(customer, error.message || "当前客户读取失败", progressPrefix);
            continue;
          }
        }
        const skippedText = skippedCustomers ? `，跳过 ${skippedCustomers} 个客户` : "";
        const readSeconds = Math.round((performance.now() - periodStartedAt) / 1000);
        sendProgress(`${progressPrefix}本周期处理完成，${employeeRows.length} 条记录；客户接口快读 ${apiCustomerCount} 个，页面兜底 ${pageCustomerCount} 个，用时 ${readSeconds} 秒${skippedText}`);

        if (batchArchive) {
          employeeArchiveRows.push(...employeeRows);
          employeeArchivePayloads.push(...rawPayloads);
          sendProgress(`${progressPrefix}已汇总 ${employeeRows.length} 条记录`);
        } else {
          const downloadResult = await downloadEmployeeRows({
            exportFormat,
            employee,
            employeeIndex,
            employeeTotal,
            period,
            periodIndex,
            periodTotal,
            rows: employeeRows,
            rawPayloads,
            storeName: request.storeName,
            syncToFeishu: Boolean(request.syncToFeishu)
          });
          if (downloadResult.downloaded) downloadedCount += 1;
        }
        totalRows += employeeRows.length;
      } catch (error) {
        if (error.message === "__EXPORT_CANCELED__") throw error;
        const failureMessage = `${progressPrefix}导出失败：${error.message || "未知错误"}`;
        sendProgress(`[失败] ${failureMessage}`);
        throw new Error(failureMessage);
      }
    }
    if (batchArchive && employeeArchiveRows.length > 0) {
      batchFiles.push({
        employee,
        rows: employeeArchiveRows,
        rawPayloads: employeeArchivePayloads
      });
      sendProgress(`[员工 ${employeeIndex}/${employeeTotal}] ${employee}：已汇总 ${employeeArchiveRows.length} 条记录，等待统一打包`);
    }
  }

  if (batchArchive && batchFiles.length > 0) {
    sendProgress(`[打包] 正在将 ${batchFiles.length} 位销售的记录压缩为一个文件`);
    const result = await chrome.runtime.sendMessage({
      module: MODULE_ID,
      type: "DOWNLOAD_BATCH_ARCHIVE",
      taskId: exportControl.taskId,
      exportFormat,
      files: batchFiles,
      employeeNames: batchFiles.map((file) => file.employee),
      startDate: request.startDate,
      endDate: request.endDate,
      storeName: request.storeName,
      syncToFeishu: Boolean(request.syncToFeishu)
    });
    if (result?.canceled) throw new Error("__EXPORT_CANCELED__");
    if (!result?.ok) throw new Error(result?.message || "批量压缩下载失败。");
    downloadedCount = 1;
    sendProgress(`[完成] 已生成批量压缩包，包含 ${batchFiles.length} 个销售文件`);
  }

  if (downloadedCount === 0) {
    sendTaskStatus("done", `查询完成，共处理 ${periods.length} 个周期，但当前条件下没有聊天记录。`);
    return { ok: true, message: `查询完成，共处理 ${periods.length} 个周期，但当前条件下没有聊天记录。`, periodCount: periods.length };
  }

  const doneMessage = `全部员工和 ${periods.length} 个周期处理完成，已下载 ${downloadedCount} 个文件，共 ${totalRows} 条记录，耗时 ${Math.round((performance.now() - exportStartedAt) / 1000)} 秒`;
  sendProgress(`[完成] ${doneMessage}`);
  sendTaskStatus("done", doneMessage);
  return { ok: true, downloadedCount, totalRows, periodCount: periods.length };
}

// Chrome 单次 runtime 消息上限约为 64MiB。完整客户记录会先按小批次交给后台暂存，
// 避免 1,000+ 位客户在最后打包时一次性超限。
const CUSTOMER_HISTORY_TRANSFER_TARGET_BYTES = 6 * 1024 * 1024;

function customerHistoryFileBytes(file) {
  try {
    return new TextEncoder().encode(JSON.stringify(file)).byteLength;
  } catch {
    return CUSTOMER_HISTORY_TRANSFER_TARGET_BYTES;
  }
}

async function storeCustomerHistoryFiles(files) {
  let batch = [];
  let batchBytes = 0;
  let startIndex = 0;
  let storedCount = 0;

  async function flush() {
    if (!batch.length) return;
    throwIfCanceled();
    const result = await chrome.runtime.sendMessage({
      module: MODULE_ID,
      type: "STORE_CUSTOMER_HISTORY_BATCH",
      taskId: exportControl.taskId,
      startIndex,
      files: batch
    });
    if (result?.canceled) throw new Error("__EXPORT_CANCELED__");
    if (!result?.ok) throw new Error(result?.message || "客户完整记录暂存失败。");
    storedCount += batch.length;
    startIndex += batch.length;
    sendProgress(`[完整记录] 正在暂存 ${storedCount}/${files.length} 位客户的记录，准备压缩`);
    batch = [];
    batchBytes = 0;
  }

  for (const file of files) {
    const fileBytes = customerHistoryFileBytes(file);
    if (batch.length && batchBytes + fileBytes > CUSTOMER_HISTORY_TRANSFER_TARGET_BYTES) {
      await flush();
    }
    batch.push(file);
    batchBytes += fileBytes;
    // 极少数单个客户记录可能本身超过预估批次大小；单独发送，避免和其他客户累加。
    if (batch.length === 1 && batchBytes >= CUSTOMER_HISTORY_TRANSFER_TARGET_BYTES) await flush();
  }
  await flush();
  return storedCount;
}

async function exportCustomerHistories(request) {
  const periods = A1688ChatExportDownloadFilename.createSevenDayPeriods(request.startDate, request.endDate);
  exportControl.paused = false;
  exportControl.canceled = false;
  exportControl.taskId = request.taskId || `chat-history-content-${Date.now()}`;

  if (!isDirectBridgeAvailable()) {
    throw new Error("客户完整记录需要 1688 页面直连接口，请刷新聊天记录查询页面后重试。");
  }

  sendProgress(`[完整记录] 开始筛选 ${request.employees.length} 位销售在 ${periods.length} 个日期段内接待过的客户`);
  const result = await tryDirectCustomerHistoryExport({ employees: request.employees, periods });
  const skippedText = result.failures.length ? `，${result.failures.length} 位客户读取失败` : "";
  if (result.files.length === 0) {
    const message = result.customerCount
      ? `已筛到 ${result.customerCount} 位客户，但没有可导出的聊天消息${skippedText}。`
      : "所选销售在该日期范围没有可识别的客户会话。";
    sendTaskStatus("done", message);
    return { ok: true, downloadedCount: 0, customerCount: result.customerCount, message };
  }

  throwIfCanceled();
  let storedFileCount = 0;
  let download;
  try {
    sendProgress(`[完整记录] 正在分批暂存 ${result.files.length} 位客户的完整聊天记录`);
    storedFileCount = await storeCustomerHistoryFiles(result.files);
    throwIfCanceled();
    sendProgress(`[完整记录] 正在打包 ${storedFileCount} 位客户的完整聊天记录`);
    download = await chrome.runtime.sendMessage({
      module: MODULE_ID,
      type: "DOWNLOAD_CUSTOMER_HISTORY_ARCHIVE",
      taskId: exportControl.taskId,
      storedFileCount,
      storeName: request.storeName,
      startDate: request.startDate,
      endDate: request.endDate
    });
    if (download?.canceled) throw new Error("__EXPORT_CANCELED__");
    if (!download?.ok) throw new Error(download?.message || "客户完整记录压缩包下载失败。");
  } catch (error) {
    await chrome.runtime.sendMessage({
      module: MODULE_ID,
      type: "CLEAR_CUSTOMER_HISTORY_STAGING",
      taskId: exportControl.taskId
    }).catch(() => {});
    throw error;
  }

  const message = `已导出 ${result.files.length}/${result.customerCount} 位客户的完整记录${skippedText}，已生成 ZIP 文件。`;
  sendProgress(`[完成] ${message}`);
  sendTaskStatus("done", message);
  return { ok: true, downloadedCount: 1, customerCount: result.customerCount, exportedCustomerCount: result.files.length, message };
}

if (location.hostname === "air.1688.com") injectNetworkScript();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.module !== MODULE_ID) return false;
  if (!isTargetPage()) return false;

  if (message.type === "GET_EMPLOYEES") {
    readEmployees()
      .then((employees) => sendResponse({ ok: true, employees }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "START_EXPORT") {
    const exportRunner = message.exportMode === "customerHistory" ? exportCustomerHistories : exportEmployees;
    exportRunner(message)
      .then((result) => {
        sendResponse(result);
        exportControl.taskId = "";
      })
      .catch((error) => {
        if (error.message === "__EXPORT_CANCELED__") {
          sendProgress("[取消] 任务已取消");
          sendTaskStatus("canceled", "任务已取消。");
          sendResponse({ ok: false, canceled: true, message: "任务已取消。" });
          exportControl.taskId = "";
          return;
        }
        sendTaskStatus("error", error.message || "导出失败。");
        sendResponse({ ok: false, message: error.message });
        exportControl.taskId = "";
      });
    return true;
  }

  if (message.type === "PAUSE_EXPORT") {
    if (message.taskId && exportControl.taskId && message.taskId !== exportControl.taskId) {
      sendResponse({ ok: false, message: "当前页面没有匹配的导出任务。" });
      return true;
    }
    exportControl.paused = true;
    sendResponse({ ok: true, status: "paused" });
    return true;
  }

  if (message.type === "RESUME_EXPORT") {
    if (message.taskId && exportControl.taskId && message.taskId !== exportControl.taskId) {
      sendResponse({ ok: false, message: "当前页面没有匹配的导出任务。" });
      return true;
    }
    exportControl.paused = false;
    sendResponse({ ok: true, status: "running" });
    return true;
  }

  if (message.type === "CANCEL_EXPORT") {
    if (message.taskId && exportControl.taskId && message.taskId !== exportControl.taskId) {
      sendResponse({ ok: false, message: "当前页面没有匹配的导出任务。" });
      return true;
    }
    exportControl.canceled = true;
    exportControl.paused = false;
    sendResponse({ ok: true, status: "canceling" });
    return true;
  }

  return false;
});
})();
