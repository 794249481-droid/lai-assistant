(() => {
if (globalThis.__GD_CHAT_CONNECTION__) return;
globalThis.__GD_CHAT_CONNECTION__ = { isTargetPage };
const state = {
  payloads: []
};

const networkBridge = {
  nonce: crypto.randomUUID(),
  port: null,
  ready: false
};

const MODULE_ID = "chatExport";

const exportControl = {
  paused: false,
  canceled: false,
  taskId: ""
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return `td[title="${date}"] .ant-picker-cell-inner`;
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
  // 历史全部可能跨越多年，不能只尝试几个相邻月份。
  // 仍设置上限，避免日期控件异常时无限等待。
  for (let attempt = 0; attempt < 480; attempt += 1) {
    const direct = document.querySelector(dateCellSelector(date));
    if (direct && isVisible(direct)) return direct;

    const cells = visibleDateCells()
      .map((cell) => cell.getAttribute("title"))
      .filter(Boolean)
      .sort();

    const dropdown = visiblePickerDropdown();
    if (!dropdown || cells.length === 0) {
      await sleep(80);
      continue;
    }

    const first = cells[0];
    const last = cells[cells.length - 1];
    const prev = dropdown.querySelector(".ant-picker-header-prev-btn");
    const next = dropdown.querySelector(".ant-picker-header-next-btn");

    if (compareDate(date, first) < 0 && prev) {
      fireMouseSequence(prev);
      await sleep(100);
      continue;
    }

    if (compareDate(date, last) > 0 && next) {
      fireMouseSequence(next);
      await sleep(100);
      continue;
    }

    break;
  }

  return null;
}

async function clickDateCell(date) {
  const cell = await ensureDateCellVisible(date);
  if (!cell) throw new Error(`没有找到日期：${date}`);
  const disabled = cell.closest(".ant-picker-cell-disabled");
  if (disabled) sendProgress(`[日期] 页面将尝试应用受限日期：${date}`);
  fireMouseSequence(cell);
  await sleep(250);
}

function setDateInputDirectly(input, date) {
  if (!input) return;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, date);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: date }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  fireKeyboard(input, "Enter");
}

function dateFieldState(field, inputs) {
  return {
    text: field.innerText.replace(/\s+/g, ""),
    inputValues: inputs.map((input) => input.value).join("|")
  };
}

function assertDateRangeApplied(field, inputs, startDate, endDate) {
  const { text, inputValues } = dateFieldState(field, inputs);
  if (!dateValueMatches(text, inputValues, startDate)) {
    throw new Error(`开始日期没有应用成功：${startDate}`);
  }
  if (!dateValueMatches(text, inputValues, endDate)) {
    throw new Error(`结束日期没有应用成功：${endDate}`);
  }
}

async function selectDateRangeSequentially(field, picker, inputs, startDate, endDate) {
  try {
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
    assertDateRangeApplied(field, inputs, startDate, endDate);
  } catch (calendarError) {
    sendProgress(`[日期] 日历选择失败，改用原始日期输入框：${calendarError.message || "未知原因"}`);
    document.body.click();
    setDateInputDirectly(inputs[0], startDate);
    setDateInputDirectly(inputs[1], endDate);
    await sleep(250);
    assertDateRangeApplied(field, inputs, startDate, endDate);
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

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(160);

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
    scroller.scrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 80),
      scroller.scrollHeight
    );
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(160);

    if (scroller.scrollTop === currentScrollTop && atBottom) break;
  }

  collectCustomerNamesFromDetail(scroller, names);
  return Array.from(names);
}

async function clickCustomerInDetail(panel, customer) {
  const cached = customerListCache.get(panel);
  const scroller = cached?.scroller?.isConnected
    ? cached.scroller : findCustomerListScrollContainer(panel);

  // Jump to the position discovered while enumerating the virtual list.
  // Fall back to the original full scan if the page has changed.
  if (cached?.positions.has(customer)) {
    scroller.scrollTop = cached.positions.get(customer);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(160);
    throwIfCanceled();
    const node = smallestVisibleTextNode(scroller, customer);
    if (node) {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
      fireMouseSequence(node);
      await sleep(700);
      return;
    }
  }

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(120);

  for (let round = 0; round < 100; round += 1) {
    const node = smallestVisibleTextNode(scroller, customer);
    if (node) {
      node.scrollIntoView({ block: "nearest", inline: "nearest" });
      fireMouseSequence(node);
      await sleep(700);
      return;
    }

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) break;

    const currentScrollTop = scroller.scrollTop;
    scroller.scrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 80),
      scroller.scrollHeight
    );
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(160);

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

function customerAccountMatches(candidate, requested) {
  const candidateAliases = new Set(customerAccountAliases(candidate));
  const requestedAliases = customerAccountAliases(requested);
  return requestedAliases.some((alias) => candidateAliases.has(alias));
}

function filterRowsByCustomerAccount(rows, requested) {
  if (!String(requested || "").trim()) return rows;
  return rows.filter((row) => customerAccountMatches(row.customer, requested));
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

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(160);

  for (let round = 0; round < 80; round += 1) {
    for (const row of collectRowsFromDetailPanel(panel, employee, customer)) {
      const key = `${row.time}|${row.customer}|${row.sender}|${row.message}|${(row.images || []).join(",")}`;
      rowsByKey.set(key, row);
    }

    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atBottom) break;

    const currentScrollTop = scroller.scrollTop;
    scroller.scrollTop = Math.min(
      scroller.scrollTop + Math.max(scroller.clientHeight - 8, 120),
      scroller.scrollHeight
    );
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(180);

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

async function downloadEmployeeRows({ exportFormat, employee, employeeNames, employeeIndex, employeeTotal, period, periodIndex, periodTotal, rows, rawPayloads, storeName, syncToFeishu }) {
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
  const result = await chrome.runtime.sendMessage({
    module: MODULE_ID,
    type: downloadMessageType(exportFormat),
    taskId: exportControl.taskId,
    rows,
    rawPayloads,
    startDate: period.startDate,
    endDate: period.endDate,
    employeeCount: 1,
    employeeNames: Array.isArray(employeeNames) && employeeNames.length ? employeeNames : [employee],
    storeName: storeName || A1688ChatExportDownloadFilename.resolveStoreName(rawPayloads),
    syncToFeishu: Boolean(syncToFeishu)
  });

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

async function searchCustomerEmployees(request) {
  const requestedCustomer = String(request.customerAccount || "").trim();
  const employees = Array.isArray(request.employees) ? request.employees.filter(Boolean) : [];
  if (!requestedCustomer) throw new Error("请先输入客户旺旺号。");
  if (!employees.length) throw new Error("没有可检索的员工账号。");

  const { startDate: effectiveStartDate, endDate: effectiveEndDate } =
    A1688ChatExportDateSelection.getPresetRange("last3Months");
  const periods = A1688ChatExportDownloadFilename.createSevenDayPeriods(effectiveStartDate, effectiveEndDate);
  const matchedEmployees = new Set();
  const matches = [];
  exportControl.paused = false;
  exportControl.canceled = false;
  exportControl.taskId = request.taskId || `customer-search-${Date.now()}`;

  try {
    for (let employeeIndex = 0; employeeIndex < employees.length; employeeIndex += 1) {
      const employee = employees[employeeIndex];
      let matched = false;
      let messageCount = 0;
      sendProgress(`[检索] 员工 ${employeeIndex + 1}/${employees.length} ${employee}：开始检查近三个月记录`);

      for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
        throwIfCanceled();
        await waitIfPaused();
        const period = periods[periodIndex];
        sendProgress(`[周期 ${periodIndex + 1}/${periods.length}] ${period.startDate}至${period.endDate} [员工 ${employeeIndex + 1}/${employees.length}] ${employee}：正在检索`);
        state.payloads = [];
        await chooseEmployee(employee);
        await fillDateRange(period.startDate, period.endDate);
        const queryButton = buttonByText("查询聊天记录");
        if (!queryButton) throw new Error("没有找到“查询聊天记录”按钮。");
        fireMouseSequence(queryButton);
        const detailPanel = await waitForChatDetailPanel();
        if (!detailPanel) {
          sendProgress(`[周期 ${periodIndex + 1}/${periods.length}] ${period.startDate}至${period.endDate} [员工 ${employeeIndex + 1}/${employees.length}] ${employee}：本周期无聊天记录，跳过`);
          continue;
        }

        const customers = await readAllCustomersFromDetail(detailPanel);
        const payloadRows = state.payloads.flatMap((item) => extractRowsFromPayload(item.body, employee));
        const matchedRows = filterRowsByCustomerAccount(payloadRows, requestedCustomer);
        if (matchedRows.length > 0) {
          messageCount += matchedRows.length;
          matched = true;
        } else {
          const matchingCustomers = customers.filter((customer) => customerAccountMatches(customer, requestedCustomer));
          if (matchingCustomers.length > 0) {
            matched = true;
            for (const customer of matchingCustomers) {
              try {
                await clickCustomerInDetail(detailPanel, customer);
                const customerRows = await extractRowsFromCurrentCustomerDetail(detailPanel, employee, customer);
                messageCount += customerRows.length;
              } catch (error) {
                if (error.message === "__EXPORT_CANCELED__") throw error;
              }
            }
          }
        }
        sendProgress(`[周期 ${periodIndex + 1}/${periods.length}] ${period.startDate}至${period.endDate} [员工 ${employeeIndex + 1}/${employees.length}] ${employee}：检索完成，累计 ${messageCount} 条匹配消息`);
      }

      if (matched) {
        matchedEmployees.add(employee);
        matches.push({ employee, messageCount });
        sendProgress(`[检索] ${employee}：找到客户旺旺号 ${requestedCustomer}，${messageCount} 条消息`);
      } else {
        sendProgress(`[检索] ${employee}：未找到客户旺旺号 ${requestedCustomer}`);
      }
    }

    return { ok: true, employees: Array.from(matchedEmployees), matches, startDate: effectiveStartDate, endDate: effectiveEndDate };
  } finally {
    exportControl.taskId = "";
  }
}

async function exportEmployees(request) {
  const exportStartedAt = performance.now();
  const exportFormat = ["json", "jsonl"].includes(request.exportFormat) ? "json" : "excel";
  const periods = A1688ChatExportDownloadFilename.createSevenDayPeriods(request.startDate, request.endDate);
  let downloadedCount = 0;
  let totalRows = 0;
  const customerJsonPerEmployee = Boolean(String(request.customerAccount || '').trim()) && exportFormat === 'json';
  exportControl.paused = false;
  exportControl.canceled = false;
  exportControl.taskId = request.taskId || `chat-export-content-${Date.now()}`;

  for (let i = 0; i < request.employees.length; i += 1) {
    const employeeIndex = i + 1;
    const employeeTotal = request.employees.length;
    const employee = request.employees[i];
    const employeeCombinedRows = [];
    const employeeCombinedRawPayloads = [];
    for (let periodOffset = 0; periodOffset < periods.length; periodOffset += 1) {
      throwIfCanceled();
      await waitIfPaused();

      const periodIndex = periodOffset + 1;
      const periodTotal = periods.length;
      const period = periods[periodOffset];
      const progressContext = { period, periodIndex, periodTotal, employee, employeeIndex, employeeTotal };
      const progressPrefix = periodEmployeeProgressPrefix(progressContext);
      try {
        const employeeRows = [];
        sendProgress(`${progressPrefix}正在设置日期`);

        state.payloads = [];
        await chooseEmployee(employee);
        await fillDateRange(period.startDate, period.endDate);

        const queryButton = buttonByText("查询聊天记录");
        if (!queryButton) throw new Error("没有找到“查询聊天记录”按钮。");
        sendProgress(`${progressPrefix}正在查询聊天记录`);
        fireMouseSequence(queryButton);

        const detailPanel = await waitForChatDetailPanel();
        if (!detailPanel) {
          await skipEmployee(progressContext, "没有聊天记录或没有打开聊天记录详情");
          continue;
        }
        const rawPayloads = [...state.payloads];

        const allCustomers = await readAllCustomersFromDetail(detailPanel);
        const requestedCustomer = String(request.customerAccount || "").trim();
        const customers = requestedCustomer
          ? allCustomers.filter((customer) => customerAccountMatches(customer, requestedCustomer))
          : allCustomers;
        sendProgress(requestedCustomer
          ? `${progressPrefix}客户列表 ${allCustomers.length} 个，匹配旺旺号 ${customers.length} 个`
          : `${progressPrefix}发现 ${customers.length} 个客户`);
        if (requestedCustomer && customers.length === 0) {
          sendProgress(`${progressPrefix}未找到客户旺旺号：${requestedCustomer}`);
          continue;
        }
        if (customers.length === 0) {
          for (const item of state.payloads) {
            employeeRows.push(...filterRowsByCustomerAccount(extractRowsFromPayload(item.body, employee), requestedCustomer));
          }
          if (customerJsonPerEmployee) {
            employeeCombinedRows.push(...employeeRows);
            employeeCombinedRawPayloads.push(...rawPayloads);
            sendProgress(`${progressPrefix}已加入 ${employee} 的合并 JSON，${employeeRows.length} 条记录`);
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
            await clickCustomerInDetail(detailPanel, customer);
            const customerRows = await extractRowsFromCurrentCustomerDetail(detailPanel, employee, customer);
            employeeRows.push(...customerRows);
            sendProgress(`${progressPrefix}客户 ${customerIndex + 1}/${customers.length} ${customer}：读取完成，${customerRows.length} 条记录`);
          } catch (error) {
            if (error.message === "__EXPORT_CANCELED__") throw error;
            skippedCustomers += 1;
            await skipCustomer(customer, error.message || "当前客户读取失败", progressPrefix);
            continue;
          }
        }
        const skippedText = skippedCustomers ? `，跳过 ${skippedCustomers} 个客户` : "";
        sendProgress(`${progressPrefix}本周期处理完成，${employeeRows.length} 条记录${skippedText}`);

        if (customerJsonPerEmployee) {
          employeeCombinedRows.push(...employeeRows);
          employeeCombinedRawPayloads.push(...rawPayloads);
          sendProgress(`${progressPrefix}已加入 ${employee} 的合并 JSON，${employeeRows.length} 条记录`);
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

    if (customerJsonPerEmployee && employeeCombinedRows.length > 0) {
      const downloadResult = await downloadEmployeeRows({
        exportFormat: 'json',
        employee,
        employeeNames: [employee],
        employeeIndex,
        employeeTotal,
        period: { startDate: request.startDate, endDate: request.endDate },
        periodIndex: 1,
        periodTotal: 1,
        rows: employeeCombinedRows,
        rawPayloads: employeeCombinedRawPayloads,
        storeName: request.storeName,
        syncToFeishu: Boolean(request.syncToFeishu)
      });
      if (downloadResult.downloaded) downloadedCount += 1;
      sendProgress(`[完成] ${employee} 已分别导出 ${employeeCombinedRows.length} 条消息`);
    }
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

  if (message.type === "SEARCH_CUSTOMER_EMPLOYEES") {
    searchCustomerEmployees(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, message: error.message || "客户旺旺号检索失败。" }));
    return true;
  }

  if (message.type === "START_EXPORT") {
    exportEmployees(message)
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
