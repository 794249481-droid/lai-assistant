const MODULE_ID = "chatExport";
const TASK_STATE_KEY = "integrated.chatExport.taskState";
const CHAT_EXPORT_OFFSCREEN_URL = "src/modules/chat-export/ui/offscreen/offscreen.html";
const CHAT_EXPORT_BLOB_DB = "chatExportBlobDownloads";
const CHAT_EXPORT_BLOB_STORE = "files";
const DOWNLOAD_FILENAME_ROUTER = globalThis.A1688DownloadFilenameRouter;
const CHAT_EXPORT_DOWNLOAD_FILENAME = globalThis.A1688ChatExportDownloadFilename;
const CHAT_EXPORT_COMPATIBLE_JSON = globalThis.A1688ChatExportCompatibleJson;
const CHAT_EXPORT_FEISHU_SYNC = globalThis.A1688ChatExportFeishuSync;
const URL_BY_DOWNLOAD_ID = new Map();
const DOWNLOAD_IDS_BY_TASK_ID = new Map();
const FETCH_CONTROLLERS_BY_TASK_ID = new Map();
const CANCELED_TASK_IDS = new Set();
let creatingOffscreenDocument = null;

if (!DOWNLOAD_FILENAME_ROUTER) {
  throw new Error("A1688DownloadFilenameRouter is not installed.");
}

if (!CHAT_EXPORT_FEISHU_SYNC) {
  throw new Error("A1688ChatExportFeishuSync is not installed.");
}

if (!CHAT_EXPORT_COMPATIBLE_JSON) {
  throw new Error("A1688ChatExportCompatibleJson is not installed.");
}

function defaultTaskState() {
  return {
    status: "idle",
    logs: [],
    startedAt: null,
    updatedAt: null,
    formatLabel: "",
    employees: [],
    startDate: "",
    endDate: "",
    syncToFeishu: false,
    taskId: "",
    tabId: null,
    message: ""
  };
}

async function readTaskState() {
  const result = await chrome.storage.local.get(TASK_STATE_KEY);
  return {
    ...defaultTaskState(),
    ...(result[TASK_STATE_KEY] || {})
  };
}

async function writeTaskState(taskState) {
  const nextState = {
    ...defaultTaskState(),
    ...taskState,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [TASK_STATE_KEY]: nextState });
  return nextState;
}

function broadcastTaskState(taskState) {
  const result = chrome.runtime.sendMessage({ module: MODULE_ID, type: "TASK_STATE_UPDATED", taskState });
  if (result?.catch) result.catch(() => {});
}

async function updateTaskState(patch) {
  const taskState = await writeTaskState({
    ...(await readTaskState()),
    ...patch
  });
  broadcastTaskState(taskState);
  return taskState;
}

async function appendTaskLog(message) {
  const current = await readTaskState();
  const logs = [...(current.logs || []), message];
  const taskState = await writeTaskState({ ...current, logs });
  broadcastTaskState(taskState);
  return taskState;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function openBlobDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CHAT_EXPORT_BLOB_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHAT_EXPORT_BLOB_STORE)) {
        db.createObjectStore(CHAT_EXPORT_BLOB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open chat export blob database."));
  });
}

async function withBlobStore(mode, callback) {
  const db = await openBlobDb();
  try {
    const transaction = db.transaction(CHAT_EXPORT_BLOB_STORE, mode);
    const store = transaction.objectStore(CHAT_EXPORT_BLOB_STORE);
    const transactionDone = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Blob database transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Blob database transaction aborted."));
    });
    const result = await callback(store);
    await transactionDone;
    return result;
  } finally {
    db.close();
  }
}

async function storeBlobForOffscreen(blobKey, blob) {
  await withBlobStore("readwrite", (store) => requestToPromise(store.put({ blob }, blobKey)));
}

async function deleteStoredBlob(blobKey) {
  if (!blobKey) return;
  await withBlobStore("readwrite", (store) => requestToPromise(store.delete(blobKey))).catch(() => {});
}

function randomDownloadKey() {
  return `chat-export-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const documentUrl = chrome.runtime.getURL(CHAT_EXPORT_OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.createDocument) {
    throw new Error("当前浏览器不支持 offscreen 文档，无法稳定创建大文件下载链接。");
  }

  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: CHAT_EXPORT_OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "Create Blob URLs for large 1688 chat export downloads."
    }).catch((error) => {
      if (!/Only a single offscreen document/i.test(error.message || "")) throw error;
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }
  await creatingOffscreenDocument;
}

async function createOffscreenBlobUrl(blobKey) {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    module: MODULE_ID,
    type: "CREATE_OFFSCREEN_BLOB_URL",
    blobKey
  });
  if (!result?.ok || !result.url) {
    throw new Error(result?.message || "创建下载链接失败。");
  }
  return result.url;
}

async function revokeOffscreenBlobUrl(blobKey, url) {
  if (!blobKey && !url) return;
  await chrome.runtime.sendMessage({
    module: MODULE_ID,
    type: "REVOKE_OFFSCREEN_BLOB_URL",
    blobKey,
    url
  }).catch(() => {});
}

function chromeDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function addTaskDownload(taskId, downloadId) {
  if (!taskId || !downloadId) return;
  const ids = DOWNLOAD_IDS_BY_TASK_ID.get(taskId) || new Set();
  ids.add(downloadId);
  DOWNLOAD_IDS_BY_TASK_ID.set(taskId, ids);
}

function removeTaskDownload(taskId, downloadId) {
  if (!taskId || !downloadId) return;
  const ids = DOWNLOAD_IDS_BY_TASK_ID.get(taskId);
  if (!ids) return;
  ids.delete(downloadId);
  if (ids.size === 0) DOWNLOAD_IDS_BY_TASK_ID.delete(taskId);
}

function isTaskCanceled(taskId) {
  return Boolean(taskId && CANCELED_TASK_IDS.has(taskId));
}

function throwIfBackgroundTaskCanceled(taskId) {
  if (isTaskCanceled(taskId)) throw new Error("__EXPORT_CANCELED__");
}

function addFetchController(taskId, controller) {
  if (!taskId || !controller) return;
  const controllers = FETCH_CONTROLLERS_BY_TASK_ID.get(taskId) || new Set();
  controllers.add(controller);
  FETCH_CONTROLLERS_BY_TASK_ID.set(taskId, controllers);
}

function removeFetchController(taskId, controller) {
  if (!taskId || !controller) return;
  const controllers = FETCH_CONTROLLERS_BY_TASK_ID.get(taskId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size === 0) FETCH_CONTROLLERS_BY_TASK_ID.delete(taskId);
}

async function cleanupManagedDownload(downloadId) {
  const item = URL_BY_DOWNLOAD_ID.get(downloadId);
  DOWNLOAD_FILENAME_ROUTER.forgetDownload(downloadId);
  if (!item) return;
  URL_BY_DOWNLOAD_ID.delete(downloadId);
  removeTaskDownload(item.taskId, downloadId);
  await revokeOffscreenBlobUrl(item.blobKey, item.url);
  await deleteStoredBlob(item.blobKey);
}

async function cancelActiveDownloads(taskId) {
  if (taskId) CANCELED_TASK_IDS.add(taskId);
  const downloadIds = taskId
    ? Array.from(DOWNLOAD_IDS_BY_TASK_ID.get(taskId) || [])
    : Array.from(URL_BY_DOWNLOAD_ID.keys());
  const controllers = taskId
    ? Array.from(FETCH_CONTROLLERS_BY_TASK_ID.get(taskId) || [])
    : Array.from(FETCH_CONTROLLERS_BY_TASK_ID.values()).flatMap((set) => Array.from(set));

  for (const controller of controllers) {
    try {
      controller.abort();
    } catch {
      // Already settled.
    }
  }

  for (const downloadId of downloadIds) {
    await new Promise((resolve) => {
      chrome.downloads.cancel(downloadId, () => resolve());
    });
    await cleanupManagedDownload(downloadId);
  }

  return { canceledDownloads: downloadIds.length, abortedFetches: controllers.length };
}

function escapeXml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function blobToBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function imageExtensionFromMime(mime, url) {
  const lowerMime = String(mime || "").toLowerCase();
  if (lowerMime.includes("png")) return "png";
  if (lowerMime.includes("gif")) return "gif";
  if (lowerMime.includes("webp")) return "webp";
  if (lowerMime.includes("jpeg") || lowerMime.includes("jpg")) return "jpg";

  const match = String(url || "").split("?")[0].match(/\.([a-z0-9]+)$/i);
  const ext = match?.[1]?.toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  return "jpg";
}

function imageMimeFromExtension(ext) {
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

async function imageUrlToEmbeddedImage(url, options = {}) {
  const taskId = options.taskId || "";
  throwIfBackgroundTaskCanceled(taskId);
  const controller = new AbortController();
  addFetchController(taskId, controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
  const response = await fetch(url, { credentials: "omit", signal: controller.signal });
  throwIfBackgroundTaskCanceled(taskId);
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  const blob = await response.blob();
  const ext = imageExtensionFromMime(blob.type, url);
  return {
    url,
    ext,
    mime: blob.type || imageMimeFromExtension(ext),
    bytes: await blobToBytes(blob)
  };
  } catch (error) {
    throwIfBackgroundTaskCanceled(taskId);
    if (error.name === "AbortError") throw new Error("图片下载超时（30秒），保留图片链接");
    throw error;
  } finally {
    clearTimeout(timer);
    removeFetchController(taskId, controller);
  }
}

async function embedImagesForExcel(rows, options = {}) {
  const taskId = options.taskId || "";
  const urls = [...new Set(rows.flatMap(row => row.images || []))];
  const results = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      throwIfBackgroundTaskCanceled(taskId);
      const url = urls[cursor++];
      try {
        results.set(url, await imageUrlToEmbeddedImage(url, { taskId }));
      } catch (error) {
        if (error.name === "AbortError" || error.message === "__EXPORT_CANCELED__") throw new Error("__EXPORT_CANCELED__");
        results.set(url, {
          url,
          error: error.message
        });
      }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(4, urls.length) }, worker));
  const failed = settled.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  throwIfBackgroundTaskCanceled(taskId);
  for (const row of rows) row.embeddedImages = (row.images || []).map(url => results.get(url));
  return rows;
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 255];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function textBytes(text) {
  return new TextEncoder().encode(text);
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function writeUint16(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function zipDateParts(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zipHeader(signature, size) {
  const header = new Uint8Array(size);
  writeUint32(header, 0, signature);
  return header;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = zipDateParts();

  for (const file of files) {
    const nameBytes = textBytes(file.name);
    const data = file.data instanceof Uint8Array ? file.data : textBytes(file.data);
    const crc = crc32(data);

    const local = zipHeader(0x04034b50, 30);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, 0x0800);
    writeUint16(local, 8, 0);
    writeUint16(local, 10, time);
    writeUint16(local, 12, day);
    writeUint32(local, 14, crc);
    writeUint32(local, 18, data.length);
    writeUint32(local, 22, data.length);
    writeUint16(local, 26, nameBytes.length);
    writeUint16(local, 28, 0);
    localParts.push(local, nameBytes, data);

    const central = zipHeader(0x02014b50, 46);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 8, 0x0800);
    writeUint16(central, 10, 0);
    writeUint16(central, 12, time);
    writeUint16(central, 14, day);
    writeUint32(central, 16, crc);
    writeUint32(central, 20, data.length);
    writeUint32(central, 24, data.length);
    writeUint16(central, 28, nameBytes.length);
    writeUint16(central, 30, 0);
    writeUint16(central, 32, 0);
    writeUint16(central, 34, 0);
    writeUint16(central, 36, 0);
    writeUint32(central, 38, 0);
    writeUint32(central, 42, offset);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = zipHeader(0x06054b50, 22);
  writeUint16(end, 8, files.length);
  writeUint16(end, 10, files.length);
  writeUint32(end, 12, centralSize);
  writeUint32(end, 16, offset);
  writeUint16(end, 20, 0);

  return concatBytes([...localParts, ...centralParts, end]);
}

function excelColumn(index) {
  let value = "";
  let current = index;
  while (current > 0) {
    const mod = (current - 1) % 26;
    value = String.fromCharCode(65 + mod) + value;
    current = Math.floor((current - mod) / 26);
  }
  return value;
}

function cellXml(rowIndex, columnIndex, value) {
  const ref = `${excelColumn(columnIndex)}${rowIndex}`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function rowXml(rowIndex, values, hasImage) {
  const cells = values.map((value, index) => cellXml(rowIndex, index + 1, value)).join("");
  const height = hasImage ? ' ht="86" customHeight="1"' : "";
  return `<row r="${rowIndex}"${height}>${cells}</row>`;
}

function contentTypesXml(imageExtensions, sheetCount, drawingCount) {
  const imageDefaults = Array.from(imageExtensions)
    .map((ext) => `<Default Extension="${ext}" ContentType="${imageMimeFromExtension(ext)}"/>`)
    .join("");
  const worksheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("");
  const drawings = Array.from({ length: drawingCount }, (_, index) =>
    `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${imageDefaults}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${worksheets}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${drawings}
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function safeSheetName(name, index, usedNames = new Set()) {
  const fallback = `员工${index}`;
  let clean = String(name || fallback)
    .replace(/[\[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31) || fallback;

  const base = clean;
  let suffix = 2;
  while (usedNames.has(clean)) {
    const tail = `_${suffix}`;
    clean = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  usedNames.add(clean);
  return clean;
}

function workbookXml(sheets) {
  const sheetXml = sheets.map((sheet, index) =>
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetXml}</sheets>
</workbook>`;
}

function workbookRelsXml(sheetCount) {
  const relationships = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;
}

function coreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>聊天记录</dc:title>
  <dc:creator>检索版插件 ${globalThis.LAI_PLUGIN_VERSION || "V1.5.0"}</dc:creator>
  <cp:lastModifiedBy>检索版插件 ${globalThis.LAI_PLUGIN_VERSION || "V1.5.0"}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>检索版插件 ${globalThis.LAI_PLUGIN_VERSION || "V1.5.0"}</Application>
</Properties>`;
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function customerAccountAliases(customer) {
  const value = compactText(customer);
  if (!value) return [];

  const aliases = new Set([value]);
  const without1688Suffix = value.replace(/[\uff08(]1688[\uff09)]$/i, "");
  if (without1688Suffix) aliases.add(without1688Suffix);

  const beforeBracket = value.split(/[\uff08(]/)[0];
  if (beforeBracket) aliases.add(beforeBracket);

  return Array.from(aliases).filter((alias) => alias.length >= 2);
}

function textStartsWithCustomerAccount(text, customer) {
  const value = compactText(text);
  if (!value) return false;
  return customerAccountAliases(customer).some((alias) => (
    value === alias ||
    value.startsWith(`${alias}:`) ||
    value.startsWith(`${alias}\uff1a`) ||
    value.startsWith(alias)
  ));
}

function rowStartsWithCustomerAccount(row) {
  const customer = row.customer;
  if (!customer) return false;
  const sender = row.sender || "";
  const message = row.message || row.text || "";
  return (
    textStartsWithCustomerAccount(sender, customer) ||
    textStartsWithCustomerAccount(message, customer) ||
    textStartsWithCustomerAccount(`${sender}${message}`, customer)
  );
}

function explicitMessageDirection(row) {
  const direction = compactText(
    row.messageDirection ||
    row.direction ||
    row.senderRole ||
    row.sender_role ||
    row.role
  );

  if (!direction) return "";
  if (["employee", "staff", "seller", "service", "self", "mine", "right"].some((value) => direction.includes(value))) {
    return "employee";
  }
  if (["customer", "buyer", "client", "left", "receive"].some((value) => direction.includes(value))) {
    return "customer";
  }
  if (direction.includes("员工") || direction.includes("客服") || direction.includes("卖家") || direction.includes("商家")) {
    return "employee";
  }
  if (direction.includes("客户") || direction.includes("买家")) return "customer";
  return "";
}

function looksLikeShopEmployeePrefix(text, employeeName) {
  if (!text || !employeeName) return false;
  const index = text.indexOf(employeeName);
  if (index <= 0 || index > 16) return false;
  const prefix = text.slice(0, index);
  return /[\u4e00-\u9fa5]{2,}/.test(prefix);
}

function isEmployeeMessage(row, employee) {
  const sender = compactText(row.sender);
  const message = compactText(row.message || row.text);
  const combined = compactText(`${row.sender || ""}${row.message || row.text || ""}`);
  const employeeName = compactText(employee || row.employee);
  if (!sender && !message) return false;

  if (rowStartsWithCustomerAccount(row)) return false;

  const explicitDirection = explicitMessageDirection(row);
  if (explicitDirection === "employee") return true;

  if (row.customer) return true;

  if (explicitDirection === "customer") return false;
  if (employeeName && (sender === employeeName || sender.includes(employeeName) || employeeName.includes(sender))) return true;
  if (employeeName && looksLikeShopEmployeePrefix(combined, employeeName)) return true;
  if (sender.includes("客服") || sender.includes("卖家") || sender.includes("商家")) return true;
  if (sender.includes("客户") || sender.includes("买家")) return false;
  return false;
}

function rowImageLinks(row) {
  const links = new Set();
  for (const image of row.embeddedImages || []) {
    if (image.url) links.add(image.url);
  }
  for (const url of row.images || []) {
    if (url) links.add(url);
  }
  return Array.from(links);
}

function imageAttachmentText(row) {
  const links = rowImageLinks(row);
  if (!links.length) return "";
  return `图片 ${links.length} 张`;
}

function imageLinksText(row) {
  return rowImageLinks(row).join("\n");
}

function displaySenderText(row, fallback) {
  return String(row.sender || "").trim() || fallback || "";
}

function displayMessageText(row) {
  return row.message || row.text || "";
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

function employeeSenderAndMessage(row, employee, employeeSide, fallbackSender = "") {
  const sender = displaySenderText(row, fallbackSender);
  const message = displayMessageText(row);
  if (!employeeSide) return { sender, message };
  if (!sender || /[:：]/.test(sender)) return { sender, message };

  const compactStaff = splitCompactStaffPrefix(message);
  if (!compactStaff) return { sender, message };

  return {
    sender: `${sender}:${compactStaff.staff}`,
    message: compactStaff.message
  };
}

function customerGroupsFromRows(rows) {
  const groups = [];
  const byCustomer = new Map();

  for (const row of rows) {
    const customer = row.customer || "未知客户";
    if (!byCustomer.has(customer)) {
      const group = { customer, rows: [] };
      byCustomer.set(customer, group);
      groups.push(group);
    }
    byCustomer.get(customer).rows.push(row);
  }

  return groups;
}

function conversationDisplayRows({ employee, rows, startDate, endDate }) {
  const displayRows = [
    {
      values: [`员工：${employee}`, "", "", "", `日期：${startDate} 至 ${endDate}`, "", "", `记录数：${rows.length}`, "", ""],
      hasImage: false
    },
    {
      values: [`插件版本：${globalThis.LAI_PLUGIN_VERSION || "V1.5.0"}`, "", "", "", "", "", "", "", "", ""],
      hasImage: false
    },
    {
      values: ["客户时间", "客户", "客户消息", "客户图片附件", "客户图片链接", "员工时间", "员工", "员工消息", "员工图片附件", "员工图片链接"],
      hasImage: false
    }
  ];

  for (const group of customerGroupsFromRows(rows)) {
    displayRows.push({
      values: [`客户：${group.customer}`, "", "", "", "", "", "", "", "", ""],
      hasImage: false
    });

    for (const row of group.rows) {
      const employeeSide = isEmployeeMessage(row, employee);
      const { sender, message } = employeeSenderAndMessage(row, employee, employeeSide, employeeSide ? employee : group.customer);
      const images = row.embeddedImages || [];
      const values = employeeSide
        ? ["", "", "", "", "", row.time, sender, message, imageAttachmentText(row), imageLinksText(row)]
        : [row.time, sender, message, imageAttachmentText(row), imageLinksText(row), "", "", "", "", ""];

      displayRows.push({
        values,
        hasImage: images.some((image) => image.bytes),
        sourceRow: row,
        imageColumnIndex: employeeSide ? 8 : 3
      });
    }
  }

  return displayRows.map((row, index) => ({ ...row, rowNumber: index + 1 }));
}

function worksheetXml({ employee, rows, startDate, endDate, hasDrawing, displayRows }) {
  const rowParts = (displayRows || conversationDisplayRows({ employee, rows, startDate, endDate }))
    .map((row) => rowXml(row.rowNumber, row.values, row.hasImage));
  const drawing = hasDrawing ? '<drawing r:id="rId1"/>' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <cols>
    <col min="1" max="1" width="22" customWidth="1"/>
    <col min="2" max="2" width="24" customWidth="1"/>
    <col min="3" max="3" width="48" customWidth="1"/>
    <col min="4" max="4" width="18" customWidth="1"/>
    <col min="5" max="5" width="54" customWidth="1"/>
    <col min="6" max="6" width="22" customWidth="1"/>
    <col min="7" max="7" width="24" customWidth="1"/>
    <col min="8" max="8" width="48" customWidth="1"/>
    <col min="9" max="9" width="18" customWidth="1"/>
    <col min="10" max="10" width="54" customWidth="1"/>
  </cols>
  <sheetData>${rowParts.join("")}</sheetData>
  ${drawing}
</worksheet>`;
}

function worksheetRelsXml(drawingIndex) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIndex}.xml"/>
</Relationships>`;
}

function drawingXml(images) {
  const anchors = images.map((image, index) => {
    const row = image.rowNumber - 1;
    const col = Number.isInteger(image.columnIndex) ? image.columnIndex : 2;
    const relId = `rId${index + 1}`;
    const name = `聊天图片 ${index + 1}`;
    return `<xdr:oneCellAnchor>
  <xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:ext cx="952500" cy="952500"/>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="${escapeXml(name)}"/><xdr:cNvPicPr/></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${anchors}
</xdr:wsDr>`;
}

function drawingRelsXml(images) {
  const rels = images.map((image, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${image.fileName}"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function employeeGroupsFromRows(rows, employeeNames = []) {
  const groups = [];
  const byEmployee = new Map();

  for (const name of employeeNames) {
    if (!byEmployee.has(name)) {
      const group = { employee: name, rows: [] };
      byEmployee.set(name, group);
      groups.push(group);
    }
  }

  for (const row of rows) {
    const employee = row.employee || "未知员工";
    if (!byEmployee.has(employee)) {
      const group = { employee, rows: [] };
      byEmployee.set(employee, group);
      groups.push(group);
    }
    byEmployee.get(employee).rows.push(row);
  }

  return groups.length ? groups : [{ employee: "聊天记录", rows: [] }];
}

function exportFilenameOptions(message) {
  const employeeNames = Array.isArray(message.employeeNames) ? message.employeeNames.filter(Boolean) : [];
  return {
    storeName: message.storeName || CHAT_EXPORT_DOWNLOAD_FILENAME.resolveStoreName(message.rawPayloads || message.rows),
    employeeName: employeeNames[0] || "员工",
    startDate: message.startDate,
    endDate: message.endDate
  };
}

function buildConversationId(row) {
  return [row.employee, row.customer].filter(Boolean).join("__") || "chat";
}

function buildCompatibleRecords({ rows }) {
  return (rows || []).map((row, index) => {
    const employeeSide = isEmployeeMessage(row, row.employee);
    const normalized = employeeSenderAndMessage(row, row.employee, employeeSide, employeeSide ? row.employee : row.customer);
    return {
      source: "platform",
      message_id: `msg_${String(index + 1).padStart(6, "0")}`,
      conversation_id: buildConversationId(row),
      sequence: index + 1,
      employee: row.employee || "",
      customer: row.customer || "",
      time: row.time || "",
      sender_role: employeeSide ? "employee" : "customer",
      sender_name: normalized.sender,
      text: normalized.message,
      image_urls: rowImageLinks(row)
    };
  });
}

function textToDataUrl(text, mime) {
  return `data:${mime};base64,${bytesToBase64(textBytes(text))}`;
}

async function buildXlsx({ rows, startDate, endDate, employeeCount, employeeNames = [], taskId = "" }) {
  throwIfBackgroundTaskCanceled(taskId);
  const files = [];
  const groups = employeeGroupsFromRows(rows, employeeNames);
  const usedSheetNames = new Set();
  const sheets = groups.map((group, index) => ({
    ...group,
    name: safeSheetName(group.employee, index + 1, usedSheetNames),
    index: index + 1,
    displayRows: conversationDisplayRows({
      employee: group.employee,
      rows: group.rows,
      startDate,
      endDate
    }),
    mediaImages: []
  }));
  const imageExtensions = new Set();
  const allMediaImages = [];

  for (const sheet of sheets) {
    throwIfBackgroundTaskCanceled(taskId);
    for (const displayRow of sheet.displayRows) {
      throwIfBackgroundTaskCanceled(taskId);
      for (const image of displayRow.sourceRow?.embeddedImages || []) {
        if (!image.bytes) continue;
        const ext = image.ext || imageExtensionFromMime(image.mime, image.url);
        const fileName = `image${allMediaImages.length + 1}.${ext}`;
        const mediaImage = {
          ...image,
          ext,
          fileName,
          rowNumber: displayRow.rowNumber,
          columnIndex: displayRow.imageColumnIndex
        };
        sheet.mediaImages.push(mediaImage);
        allMediaImages.push(mediaImage);
        imageExtensions.add(ext);
      }
    }
  }

  const drawingSheets = sheets.filter((sheet) => sheet.mediaImages.length > 0);
  const drawingIndexBySheet = new Map(drawingSheets.map((sheet, index) => [sheet.index, index + 1]));

  files.push({ name: "[Content_Types].xml", data: contentTypesXml(imageExtensions, sheets.length, drawingSheets.length) });
  files.push({ name: "_rels/.rels", data: rootRelsXml() });
  files.push({ name: "docProps/core.xml", data: coreXml() });
  files.push({ name: "docProps/app.xml", data: appXml() });
  files.push({ name: "xl/workbook.xml", data: workbookXml(sheets) });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: workbookRelsXml(sheets.length) });

  for (const sheet of sheets) {
    throwIfBackgroundTaskCanceled(taskId);
    const drawingIndex = drawingIndexBySheet.get(sheet.index);
    files.push({
      name: `xl/worksheets/sheet${sheet.index}.xml`,
      data: worksheetXml({
        employee: sheet.employee,
        rows: sheet.rows,
        startDate,
        endDate,
        displayRows: sheet.displayRows,
        hasDrawing: Boolean(drawingIndex)
      })
    });

    if (drawingIndex) {
      files.push({
        name: `xl/worksheets/_rels/sheet${sheet.index}.xml.rels`,
        data: worksheetRelsXml(drawingIndex)
      });
      files.push({
        name: `xl/drawings/drawing${drawingIndex}.xml`,
        data: drawingXml(sheet.mediaImages)
      });
      files.push({
        name: `xl/drawings/_rels/drawing${drawingIndex}.xml.rels`,
        data: drawingRelsXml(sheet.mediaImages)
      });
    }
  }

  for (const image of allMediaImages) {
    throwIfBackgroundTaskCanceled(taskId);
    files.push({ name: `xl/media/${image.fileName}`, data: image.bytes });
  }

  throwIfBackgroundTaskCanceled(taskId);
  return new Blob([createZip(files)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
}

async function downloadManagedBlob(blob, filename, taskId) {
  throwIfBackgroundTaskCanceled(taskId);
  const blobKey = randomDownloadKey();
  await storeBlobForOffscreen(blobKey, blob);

  let url = "";
  try {
    throwIfBackgroundTaskCanceled(taskId);
    url = await createOffscreenBlobUrl(blobKey);
    DOWNLOAD_FILENAME_ROUTER.registerUrl(url, filename);
    throwIfBackgroundTaskCanceled(taskId);

    const downloadId = await chromeDownload({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });

    URL_BY_DOWNLOAD_ID.set(downloadId, { url, filename, blobKey, taskId });
    DOWNLOAD_FILENAME_ROUTER.trackDownload(downloadId, { url, cleanup: cleanupManagedDownload });
    addTaskDownload(taskId, downloadId);
    if (isTaskCanceled(taskId)) {
      await cancelActiveDownloads(taskId);
      throw new Error("__EXPORT_CANCELED__");
    }
    return downloadId;
  } catch (error) {
    DOWNLOAD_FILENAME_ROUTER.forgetUrl(url);
    await revokeOffscreenBlobUrl(blobKey, url);
    await deleteStoredBlob(blobKey);
    throw error;
  }
}

const FEISHU_API_ORIGIN = "https://open.feishu.cn/open-apis";
const FEISHU_DIRECT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function readableError(error, fallback) {
  return error?.message || String(error || fallback);
}

async function readFeishuSyncSettings() {
  const [result, globalSettings] = await Promise.all([
    chrome.storage.local.get(CHAT_EXPORT_FEISHU_SYNC.SETTINGS_KEY),
    globalThis.HmsGlobalSettings?.read
      ? globalThis.HmsGlobalSettings.read(chrome.storage.local).catch(() => null)
      : Promise.resolve(null)
  ]);
  const legacy = CHAT_EXPORT_FEISHU_SYNC.normalizeSettings(result[CHAT_EXPORT_FEISHU_SYNC.SETTINGS_KEY]);
  const globalAppId = String(globalSettings?.feishu?.appId || "").trim();
  const globalAppSecret = String(globalSettings?.feishu?.appSecret || "").trim();
  return {
    ...legacy,
    feishuAppId: globalAppId || legacy.feishuAppId,
    feishuAppSecret: globalAppSecret || legacy.feishuAppSecret
  };
}

async function writeFeishuSyncSettings(settings) {
  const normalized = CHAT_EXPORT_FEISHU_SYNC.normalizeSettings(settings);
  normalized.updatedAt = Date.now();
  await chrome.storage.local.set({ [CHAT_EXPORT_FEISHU_SYNC.SETTINGS_KEY]: normalized });
  return normalized;
}

async function feishuFetchJson(url, options = {}, taskId = "") {
  throwIfBackgroundTaskCanceled(taskId);
  const controller = new AbortController();
  addFetchController(taskId, controller);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    throwIfBackgroundTaskCanceled(taskId);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      throw new Error(payload.msg || payload.message || `飞书请求失败（${response.status}）`);
    }
    return payload.data || payload;
  } catch (error) {
    if (isTaskCanceled(taskId) || error?.name === "AbortError") throw new Error("__EXPORT_CANCELED__");
    throw error;
  } finally {
    removeFetchController(taskId, controller);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function feishuFetchJsonWithRetry(url, options, taskId = "", attempts = 3) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await feishuFetchJson(url, options, taskId);
    } catch (error) {
      if (error?.message === "__EXPORT_CANCELED__") throw error;
      lastError = error;
      if (index + 1 < attempts) await wait(500 * (index + 1));
    }
  }
  throw lastError || new Error("飞书请求失败。");
}

async function getFeishuTenantAccessToken(settings, taskId = "") {
  const data = await feishuFetchJson(`${FEISHU_API_ORIGIN}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: settings.feishuAppId, app_secret: settings.feishuAppSecret })
  }, taskId);
  if (!data.tenant_access_token) throw new Error("未能获取飞书 tenant_access_token。");
  return data.tenant_access_token;
}

function feishuAuthorization(token) {
  return { Authorization: `Bearer ${token}` };
}

async function fetchFeishuTableFields(settings, taskId = "") {
  const parsed = CHAT_EXPORT_FEISHU_SYNC.parseBitableUrl(settings.feishuTableUrl);
  const token = await getFeishuTenantAccessToken(settings, taskId);
  const data = await feishuFetchJson(
    `${FEISHU_API_ORIGIN}/bitable/v1/apps/${encodeURIComponent(parsed.appToken)}/tables/${encodeURIComponent(parsed.tableId)}/fields?page_size=100`,
    { headers: feishuAuthorization(token) },
    taskId
  );
  return CHAT_EXPORT_FEISHU_SYNC.normalizeFields(data.items || []);
}

async function uploadFeishuAttachment(blob, filename, settings, appToken, taskId = "") {
  const token = await getFeishuTenantAccessToken(settings, taskId);
  const uploadMeta = {
    file_name: filename,
    parent_type: "bitable_file",
    parent_node: appToken,
    size: blob.size,
    extra: JSON.stringify({ drive_route_token: appToken })
  };

  if (blob.size > FEISHU_DIRECT_UPLOAD_MAX_BYTES) {
    const prepared = await feishuFetchJsonWithRetry(`${FEISHU_API_ORIGIN}/drive/v1/medias/upload_prepare`, {
      method: "POST",
      headers: { ...feishuAuthorization(token), "Content-Type": "application/json" },
      body: JSON.stringify(uploadMeta)
    }, taskId);
    const uploadId = prepared.upload_id;
    const blockSize = Number(prepared.block_size) || (4 * 1024 * 1024);
    const blockNum = Number(prepared.block_num) || Math.ceil(blob.size / blockSize);
    if (!uploadId || !blockNum) throw new Error("飞书未返回分片上传信息。");

    for (let seq = 0; seq < blockNum; seq += 1) {
      throwIfBackgroundTaskCanceled(taskId);
      const part = blob.slice(seq * blockSize, Math.min(blob.size, (seq + 1) * blockSize));
      const form = new FormData();
      form.append("upload_id", uploadId);
      form.append("seq", String(seq));
      form.append("size", String(part.size));
      form.append("file", part, filename);
      await feishuFetchJsonWithRetry(`${FEISHU_API_ORIGIN}/drive/v1/medias/upload_part`, {
        method: "POST",
        headers: feishuAuthorization(token),
        body: form
      }, taskId);
    }

    const completed = await feishuFetchJsonWithRetry(`${FEISHU_API_ORIGIN}/drive/v1/medias/upload_finish`, {
      method: "POST",
      headers: { ...feishuAuthorization(token), "Content-Type": "application/json" },
      body: JSON.stringify({ upload_id: uploadId, block_num: blockNum })
    }, taskId);
    if (!completed.file_token) throw new Error("飞书未返回附件 file_token。");
    return { fileToken: completed.file_token, tenantAccessToken: token };
  }

  const form = new FormData();
  form.append("file_name", uploadMeta.file_name);
  form.append("parent_type", "bitable_file");
  form.append("parent_node", uploadMeta.parent_node);
  form.append("size", String(uploadMeta.size));
  form.append("extra", uploadMeta.extra);
  form.append("file", blob, filename);
  const data = await feishuFetchJson(`${FEISHU_API_ORIGIN}/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: feishuAuthorization(token),
    body: form
  }, taskId);
  if (!data.file_token) throw new Error("飞书未返回附件 file_token。");
  return { fileToken: data.file_token, tenantAccessToken: token };
}

async function createFeishuAttachmentRecord(filename, fileToken, settings, parsed, tenantAccessToken, taskId = "") {
  const fields = CHAT_EXPORT_FEISHU_SYNC.buildRecordFields(settings, filename, fileToken);
  const data = await feishuFetchJson(
    `${FEISHU_API_ORIGIN}/bitable/v1/apps/${encodeURIComponent(parsed.appToken)}/tables/${encodeURIComponent(parsed.tableId)}/records`,
    {
      method: "POST",
      headers: { ...feishuAuthorization(tenantAccessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ fields })
    },
    taskId
  );
  return data.record?.record_id || data.record_id || "";
}

async function syncExportBlobToFeishu(blob, filename, taskId) {
  try {
    const settings = CHAT_EXPORT_FEISHU_SYNC.validateEnabledSettings(await readFeishuSyncSettings());
    const uploaded = await uploadFeishuAttachment(blob, filename, settings, settings.appToken, taskId);
    const recordId = await createFeishuAttachmentRecord(
      filename,
      uploaded.fileToken,
      settings,
      settings,
      uploaded.tenantAccessToken,
      taskId
    );
    return { enabled: true, ok: true, recordId };
  } catch (error) {
    if (error?.message === "__EXPORT_CANCELED__") throw error;
    return { enabled: true, ok: false, message: readableError(error, "飞书同步失败") };
  }
}

async function downloadBlobWithOptionalFeishuSync(blob, filename, taskId, syncToFeishu) {
  const localDownloadPromise = downloadManagedBlob(blob, filename, taskId);
  const syncPromise = syncToFeishu
    ? syncExportBlobToFeishu(blob, filename, taskId)
    : Promise.resolve({ enabled: false, ok: true });
  const [localResult, syncResult] = await Promise.allSettled([localDownloadPromise, syncPromise]);

  if (localResult.status !== "fulfilled") throw localResult.reason;
  const feishu = syncResult.status === "fulfilled"
    ? syncResult.value
    : { enabled: true, ok: false, message: readableError(syncResult.reason, "飞书同步失败") };
  return { downloadId: localResult.value, feishu };
}

function exportResultMessage(formatLabel, feishu) {
  const localMessage = formatLabel === "Excel"
    ? "导出完成，聊天记录和图片已保存到一个Excel文件。"
    : "导出完成，聊天记录已保存为 JSON 文件。";
  if (!feishu?.enabled) return localMessage;
  return feishu.ok
    ? `${localMessage} 已同步到飞书多维表格。`
    : `${localMessage} 飞书同步失败：${feishu.message || "未知错误"}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.module !== MODULE_ID) return false;

  if (message.type === "GET_FEISHU_SYNC_SETTINGS") {
    readFeishuSyncSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, message: readableError(error, "读取飞书配置失败") }));
    return true;
  }

  if (message.type === "SET_FEISHU_SYNC_ENABLED") {
    readFeishuSyncSettings()
      .then((settings) => writeFeishuSyncSettings({ ...settings, enabled: message.enabled === true }))
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, message: readableError(error, "保存飞书同步开关失败") }));
    return true;
  }

  if (message.type === "SAVE_FEISHU_SYNC_CREDENTIALS") {
    readFeishuSyncSettings()
      .then(async (settings) => {
        const appId = String(message.feishuAppId || settings.feishuAppId || "").trim();
        const appSecret = String(message.feishuAppSecret || settings.feishuAppSecret || "").trim();
        if (!appId || !appSecret) {
          throw new Error("请同时填写飞书 App ID 和 App Secret。");
        }
        const saved = await writeFeishuSyncSettings({ ...settings, feishuAppId: appId, feishuAppSecret: appSecret });
        if (globalThis.HmsGlobalSettings?.update) {
          await globalThis.HmsGlobalSettings.update({ feishu: { appId, appSecret } }, chrome.storage.local);
        }
        return saved;
      })
      .then((settings) => sendResponse({ ok: true, settings, message: "飞书 App 凭证已保存。" }))
      .catch((error) => sendResponse({ ok: false, message: readableError(error, "保存飞书凭证失败") }));
    return true;
  }

  if (message.type === "SAVE_FEISHU_SYNC_TABLE") {
    (async () => {
      const settings = await readFeishuSyncSettings();
      const feishuTableUrl = String(message.feishuTableUrl || "").trim();
      if (!settings.feishuAppId || !settings.feishuAppSecret) {
        throw new Error("请先保存飞书 App ID 和 App Secret。");
      }
      CHAT_EXPORT_FEISHU_SYNC.parseBitableUrl(feishuTableUrl);
      const candidate = { ...settings, feishuTableUrl };
      const fields = await fetchFeishuTableFields(candidate);
      const attachment = CHAT_EXPORT_FEISHU_SYNC.chooseAttachmentField(fields, message.attachmentFieldId || settings.attachmentFieldId);
      if (!attachment) throw new Error("当前飞书数据表没有附件类型字段，请先在多维表格中新增一个附件字段。");
      const primary = CHAT_EXPORT_FEISHU_SYNC.choosePrimaryField(fields);
      const saved = await writeFeishuSyncSettings({
        ...candidate,
        fields,
        attachmentFieldId: attachment.fieldId,
        attachmentFieldName: attachment.fieldName,
        primaryFieldName: primary?.fieldName || ""
      });
      sendResponse({ ok: true, settings: saved, message: "已读取飞书字段，请确认附件字段。" });
    })().catch((error) => sendResponse({ ok: false, message: readableError(error, "读取飞书字段失败") }));
    return true;
  }

  if (message.type === "SAVE_FEISHU_SYNC_FIELD") {
    (async () => {
      const settings = await readFeishuSyncSettings();
      const attachment = CHAT_EXPORT_FEISHU_SYNC.chooseAttachmentField(settings.fields, message.attachmentFieldId);
      if (!attachment || attachment.fieldId !== message.attachmentFieldId) {
        throw new Error("请选择一个飞书附件类型字段。");
      }
      const primary = CHAT_EXPORT_FEISHU_SYNC.choosePrimaryField(settings.fields);
      const saved = await writeFeishuSyncSettings({
        ...settings,
        attachmentFieldId: attachment.fieldId,
        attachmentFieldName: attachment.fieldName,
        primaryFieldName: primary?.fieldName || ""
      });
      sendResponse({ ok: true, settings: saved });
    })().catch((error) => sendResponse({ ok: false, message: readableError(error, "保存附件字段失败") }));
    return true;
  }

  if (message.type === "VALIDATE_FEISHU_SYNC") {
    readFeishuSyncSettings()
      .then((settings) => ({ ...CHAT_EXPORT_FEISHU_SYNC.validateEnabledSettings(settings) }))
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, message: readableError(error, "飞书同步配置不完整") }));
    return true;
  }

  if (message.type === "GET_TASK_STATE") {
    readTaskState()
      .then((taskState) => sendResponse({ ok: true, taskState }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "CLEAR_TASK_LOGS") {
    updateTaskState({ logs: [] })
      .then((taskState) => sendResponse({ ok: true, taskState }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "TASK_STARTED") {
    Promise.resolve().then(() => {
      const now = Date.now();
      const logs = message.initialLog ? [message.initialLog] : [];
      if (message.taskId) CANCELED_TASK_IDS.delete(message.taskId);
      writeTaskState({
        status: "running",
        logs,
        startedAt: now,
        updatedAt: now,
        formatLabel: message.formatLabel || "",
        employees: message.employees || [],
        startDate: message.startDate || "",
        endDate: message.endDate || "",
        syncToFeishu: message.syncToFeishu === true,
        taskId: message.taskId || "",
        tabId: message.tabId || null,
        message: "任务进行中"
      }).then((taskState) => {
        broadcastTaskState(taskState);
        sendResponse({ ok: true, taskState });
      }).catch((error) => sendResponse({ ok: false, message: error.message }));
    }).catch((error) => sendResponse({ ok: false, message: error?.message || "初始化导出任务失败。" }));
    return true;
  }

  if (message.type === "TASK_STATUS_CHANGED") {
    updateTaskState({
      status: message.status || "idle",
      message: message.message || ""
    })
      .then((taskState) => sendResponse({ ok: true, taskState }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "EXPORT_PROGRESS") {
    appendTaskLog(message.message || "")
      .then((taskState) => sendResponse({ ok: true, taskState }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "EXPORT_TASK_STATUS") {
    const status = message.status || "idle";
    const patch = { status, message: message.message || "" };
    updateTaskState(patch)
      .then((taskState) => sendResponse({ ok: true, taskState }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "CANCEL_ACTIVE_DOWNLOADS") {
    cancelActiveDownloads(message.taskId || "")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (!["DOWNLOAD_EXCEL", "DOWNLOAD_JSON", "DOWNLOAD_JSONL"].includes(message.type)) return false;

  (async () => {
    if (["DOWNLOAD_JSON", "DOWNLOAD_JSONL"].includes(message.type)) {
      const taskId = message.taskId || "";
      throwIfBackgroundTaskCanceled(taskId);
      const records = buildCompatibleRecords({ rows: message.rows || [] });
      const compatibleResult = {
        pluginName: "检索版插件",
        pluginVersion: globalThis.LAI_PLUGIN_VERSION || "V1.5.0",
        ...CHAT_EXPORT_COMPATIBLE_JSON.convertRecords(records)
      };
      const json = CHAT_EXPORT_COMPATIBLE_JSON.stringifyCompatibleJson(compatibleResult);
      const employeeName = CHAT_EXPORT_COMPATIBLE_JSON.extractEmployeeName(records)
        || exportFilenameOptions(message).employeeName;
      const dateRange = CHAT_EXPORT_COMPATIBLE_JSON.getDateRange(records);
      const filename = CHAT_EXPORT_DOWNLOAD_FILENAME.buildJsonFilename({
        storeName: exportFilenameOptions(message).storeName,
        employeeName,
        startDate: dateRange.startDate || message.startDate,
        endDate: dateRange.endDate || message.endDate
      });
      const downloadResult = await downloadBlobWithOptionalFeishuSync(
        new Blob([json], { type: "application/json;charset=utf-8" }),
        filename,
        taskId,
        message.syncToFeishu === true
      );
      sendResponse({
        ok: true,
        downloadId: downloadResult.downloadId,
        feishu: downloadResult.feishu,
        message: exportResultMessage("JSON", downloadResult.feishu)
      });
      return;
    }

    const taskId = message.taskId || "";
    throwIfBackgroundTaskCanceled(taskId);
    const rows = await embedImagesForExcel(message.rows || [], { taskId });
    const workbook = await buildXlsx({
      rows,
      startDate: message.startDate,
      endDate: message.endDate,
      employeeCount: message.employeeCount,
      employeeNames: message.employeeNames || [],
      taskId
    });
    const filename = A1688ChatExportDownloadFilename.buildExcelFilename(exportFilenameOptions(message));
    const result = await downloadBlobWithOptionalFeishuSync(workbook, filename, taskId, message.syncToFeishu === true);
    sendResponse({
      ok: true,
      downloadId: result.downloadId,
      feishu: result.feishu,
      message: exportResultMessage("Excel", result.feishu)
    });
  })().catch((error) => {
    if (error.message === "__EXPORT_CANCELED__") {
      sendResponse({ ok: false, canceled: true, message: "任务已取消。" });
      return;
    }
    sendResponse({ ok: false, message: error.message });
  });

  return true;
});
