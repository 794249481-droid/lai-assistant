const MODULE_ID = "chatExport";
const TASK_STATE_KEY = "integrated.chatExport.taskState";
const CHAT_EXPORT_OFFSCREEN_URL = "src/modules/chat-export/ui/offscreen/offscreen.html";
const CHAT_EXPORT_BLOB_DB = "chatExportBlobDownloads";
const CHAT_EXPORT_BLOB_STORE = "files";
const DAILY_EXPORT_SCHEDULE_KEY = "integrated.chatExport.dailyExportSchedule";
const DAILY_EXPORT_ALARM_NAME = "lai-daily-json-export";
const DAILY_EXPORT_RECOVERY_ALARM_NAME = "lai-daily-json-export-recovery";
const DAILY_EXPORT_HEALTH_ALARM_NAME = "lai-daily-json-export-health";
const DAILY_EXPORT_RECOVERY_DELAY_MS = 20 * 60 * 1000;
const DAILY_EXPORT_STALE_RUN_MS = 40 * 60 * 1000;
const CHAT_RECORD_URL = "https://work.1688.com/home/seller.htm?_path_=sellerPro/2017Sellerbase_Customer/cco_qcxy_zzh_chat";
const DOWNLOAD_FILENAME_ROUTER = globalThis.A1688DownloadFilenameRouter;
const CHAT_EXPORT_DOWNLOAD_FILENAME = globalThis.A1688ChatExportDownloadFilename;
const CHAT_EXPORT_COMPATIBLE_JSON = globalThis.A1688ChatExportCompatibleJson;
const CHAT_EXPORT_FEISHU_SYNC = globalThis.A1688ChatExportFeishuSync;
const URL_BY_DOWNLOAD_ID = new Map();
const DOWNLOAD_IDS_BY_TASK_ID = new Map();
const FETCH_CONTROLLERS_BY_TASK_ID = new Map();
const CANCELED_TASK_IDS = new Set();
let creatingOffscreenDocument = null;
let dailyExportRunning = false;

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

async function readStoredBlobRecord(blobKey) {
  const db = await openBlobDb();
  try {
    const transaction = db.transaction(CHAT_EXPORT_BLOB_STORE, "readonly");
    const store = transaction.objectStore(CHAT_EXPORT_BLOB_STORE);
    return await requestToPromise(store.get(blobKey));
  } finally {
    db.close();
  }
}

function customerHistoryPartKey(taskId, index) {
  return `customer-history:${taskId}:${String(index).padStart(6, "0")}`;
}

async function storeCustomerHistoryPart({ taskId, index, customer, rows }) {
  throwIfBackgroundTaskCanceled(taskId);
  const records = buildCompatibleRecords({ rows: rows || [] });
  const compatibleResult = {
    pluginName: "LAI助手",
    pluginVersion: globalThis.LAI_PLUGIN_VERSION || "V1.4.3",
    exportMode: "customerHistory",
    customerName: customer || "客户",
    ...CHAT_EXPORT_COMPATIBLE_JSON.convertRecords(records)
  };
  const blob = new Blob([
    CHAT_EXPORT_COMPATIBLE_JSON.stringifyCompatibleJson(compatibleResult)
  ], { type: "application/json;charset=utf-8" });
  const key = customerHistoryPartKey(taskId, index);
  await withBlobStore("readwrite", (store) => requestToPromise(store.put({ blob, customer: customer || "客户" }, key)));
  throwIfBackgroundTaskCanceled(taskId);
}

async function deleteStoredCustomerHistoryParts(taskId) {
  if (!taskId) return;
  const prefix = `customer-history:${taskId}:`;
  await withBlobStore("readwrite", async (store) => {
    const keys = await requestToPromise(store.getAllKeys());
    await Promise.all(keys
      .filter((key) => String(key).startsWith(prefix))
      .map((key) => requestToPromise(store.delete(key))));
  }).catch(() => {});
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

  await deleteStoredCustomerHistoryParts(taskId);

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
  <dc:creator>LAI助手 ${globalThis.LAI_PLUGIN_VERSION || "V1.4.3"}</dc:creator>
  <cp:lastModifiedBy>LAI助手 ${globalThis.LAI_PLUGIN_VERSION || "V1.4.3"}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>LAI助手 ${globalThis.LAI_PLUGIN_VERSION || "V1.4.3"}</Application>
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
      values: [`插件版本：${globalThis.LAI_PLUGIN_VERSION || "V1.4.3"}`, "", "", "", "", "", "", "", "", ""],
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

async function buildBatchArchive({ files = [], exportFormat, startDate, endDate, taskId }) {
  const archiveFiles = [];
  for (const file of files) {
    throwIfBackgroundTaskCanceled(taskId);
    const employee = file.employee || "员工";
    let data;
    let filename;

    if (exportFormat === "json") {
      const records = buildCompatibleRecords({ rows: file.rows || [] });
      const compatibleResult = {
        pluginName: "LAI助手",
        pluginVersion: globalThis.LAI_PLUGIN_VERSION || "V1.4.3",
        ...CHAT_EXPORT_COMPATIBLE_JSON.convertRecords(records)
      };
      const json = CHAT_EXPORT_COMPATIBLE_JSON.stringifyCompatibleJson(compatibleResult);
      const dateRange = CHAT_EXPORT_COMPATIBLE_JSON.getDateRange(records);
      filename = CHAT_EXPORT_DOWNLOAD_FILENAME.buildJsonFilename({
        storeName: file.storeName || "",
        employeeName: employee,
        startDate: dateRange.startDate || startDate,
        endDate: dateRange.endDate || endDate
      });
      data = textBytes(json);
    } else {
      const rows = await embedImagesForExcel(file.rows || [], { taskId });
      const workbook = await buildXlsx({
        rows,
        startDate,
        endDate,
        employeeCount: 1,
        employeeNames: [employee],
        taskId
      });
      filename = CHAT_EXPORT_DOWNLOAD_FILENAME.buildExcelFilename({
        storeName: file.storeName || "",
        employeeName: employee,
        startDate,
        endDate
      });
      data = await blobToBytes(workbook);
    }

    archiveFiles.push({ name: filename, data });
  }
  return new Blob([createZip(archiveFiles)], { type: "application/zip" });
}

async function buildCustomerHistoryArchive({ files = [], storeName, startDate, endDate, taskId }) {
  const archiveFiles = [];
  const usedNames = new Map();
  for (const file of files) {
    throwIfBackgroundTaskCanceled(taskId);
    const records = buildCompatibleRecords({ rows: file.rows || [] });
    const compatibleResult = {
      pluginName: "LAI助手",
      pluginVersion: globalThis.LAI_PLUGIN_VERSION || "V1.4.3",
      exportMode: "customerHistory",
      customerName: file.customer || "客户",
      ...CHAT_EXPORT_COMPATIBLE_JSON.convertRecords(records)
    };
    const json = CHAT_EXPORT_COMPATIBLE_JSON.stringifyCompatibleJson(compatibleResult);
    const baseName = CHAT_EXPORT_DOWNLOAD_FILENAME.buildCustomerHistoryJsonFilename({
      storeName,
      customerName: file.customer,
      startDate,
      endDate
    });
    const seen = usedNames.get(baseName) || 0;
    usedNames.set(baseName, seen + 1);
    const filename = seen
      ? baseName.replace(/\.json$/i, `_${seen + 1}.json`)
      : baseName;
    archiveFiles.push({ name: filename, data: textBytes(json) });
  }
  return new Blob([createZip(archiveFiles)], { type: "application/zip" });
}

/**
 * 客户完整记录可能远大于 chrome.runtime.sendMessage 的 64MiB 上限。
 * 内容页会分批暂存，每个客户在此处已转换为独立 JSON Blob；最后只按序读取并打包。
 */
async function buildStoredCustomerHistoryArchive({ taskId, fileCount, storeName, startDate, endDate }) {
  const archiveFiles = [];
  const usedNames = new Map();
  const count = Number(fileCount) || 0;
  for (let index = 0; index < count; index += 1) {
    throwIfBackgroundTaskCanceled(taskId);
    const record = await readStoredBlobRecord(customerHistoryPartKey(taskId, index));
    if (!(record?.blob instanceof Blob)) {
      throw new Error(`客户完整记录暂存不完整（第 ${index + 1}/${count} 位客户），请重新导出。`);
    }
    const baseName = CHAT_EXPORT_DOWNLOAD_FILENAME.buildCustomerHistoryJsonFilename({
      storeName,
      customerName: record.customer || "客户",
      startDate,
      endDate
    });
    const seen = usedNames.get(baseName) || 0;
    usedNames.set(baseName, seen + 1);
    const filename = seen
      ? baseName.replace(/\.json$/i, `_${seen + 1}.json`)
      : baseName;
    archiveFiles.push({ name: filename, data: await blobToBytes(record.blob) });
  }
  return new Blob([createZip(archiveFiles)], { type: "application/zip" });
}

function defaultDailyExportSchedule() {
  return {
    enabled: false,
    time: "08:00",
    employees: [],
    storeName: "",
    nextRunAt: null,
    nextRecoveryAt: null,
    lastRunAt: null,
    lastResult: "",
    lastRunSource: "",
    lastAutoTriggerAt: null,
    lastManualTriggerAt: null,
    lastRecoveryCheckAt: null,
    lastCompletedTargetDate: "",
    lastFailureAt: null,
    enabledAt: null,
    activeRun: null
  };
}

function validScheduleTime(time) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || ""));
}

async function readDailyExportSchedule() {
  const result = await chrome.storage.local.get(DAILY_EXPORT_SCHEDULE_KEY);
  const schedule = { ...defaultDailyExportSchedule(), ...(result[DAILY_EXPORT_SCHEDULE_KEY] || {}) };
  return {
    ...schedule,
    enabled: schedule.enabled === true,
    time: validScheduleTime(schedule.time) ? schedule.time : "08:00",
    employees: Array.isArray(schedule.employees) ? schedule.employees.filter(Boolean) : []
  };
}

async function writeDailyExportSchedule(schedule) {
  const next = { ...defaultDailyExportSchedule(), ...schedule };
  await chrome.storage.local.set({ [DAILY_EXPORT_SCHEDULE_KEY]: next });
  return next;
}

function nextDailyScheduleTime(time, now = new Date()) {
  const [hours, minutes] = String(time).split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime() + 1000) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function armDailyExportAlarm(schedule = null) {
  const current = schedule || await readDailyExportSchedule();
  await chrome.alarms.clear(DAILY_EXPORT_ALARM_NAME);
  await chrome.alarms.clear(DAILY_EXPORT_RECOVERY_ALARM_NAME);
  await chrome.alarms.clear(DAILY_EXPORT_HEALTH_ALARM_NAME);
  if (!current.enabled) {
    return writeDailyExportSchedule({ ...current, nextRunAt: null, nextRecoveryAt: null });
  }
  const nextRunAt = nextDailyScheduleTime(current.time);
  const nextRecoveryAt = nextRunAt + DAILY_EXPORT_RECOVERY_DELAY_MS;
  chrome.alarms.create(DAILY_EXPORT_ALARM_NAME, { when: nextRunAt });
  chrome.alarms.create(DAILY_EXPORT_RECOVERY_ALARM_NAME, { when: nextRecoveryAt });
  // 每小时自检一次，避免 Chrome 重启或扩展重新加载后闹钟丢失。
  chrome.alarms.create(DAILY_EXPORT_HEALTH_ALARM_NAME, { periodInMinutes: 60 });
  return writeDailyExportSchedule({ ...current, nextRunAt, nextRecoveryAt });
}

async function ensureDailyExportAlarms() {
  let current = await readDailyExportSchedule();
  current = await clearStaleDailyRun(current);
  if (!current.enabled) return armDailyExportAlarm(current);
  const [primary, recovery] = await Promise.all([
    chrome.alarms.get(DAILY_EXPORT_ALARM_NAME),
    chrome.alarms.get(DAILY_EXPORT_RECOVERY_ALARM_NAME)
  ]);
  const now = Date.now();
  const nextRunAt = primary?.scheduledTime;
  const recoveryAt = recovery?.scheduledTime;
  if (nextRunAt && nextRunAt > now + 1000) {
    if (!recoveryAt || recoveryAt <= now + 1000) {
      const nextRecoveryAt = nextRunAt + DAILY_EXPORT_RECOVERY_DELAY_MS;
      chrome.alarms.create(DAILY_EXPORT_RECOVERY_ALARM_NAME, { when: nextRecoveryAt });
      return writeDailyExportSchedule({ ...current, nextRunAt, nextRecoveryAt });
    }
    return writeDailyExportSchedule({ ...current, nextRunAt, nextRecoveryAt: recoveryAt });
  }

  // 主闹钟意外丢失时，不清除仍在等待的当天补偿闹钟。
  const next = nextDailyScheduleTime(current.time);
  chrome.alarms.create(DAILY_EXPORT_ALARM_NAME, { when: next });
  const nextRecoveryAt = recoveryAt && recoveryAt > now + 1000
    ? recoveryAt
    : next + DAILY_EXPORT_RECOVERY_DELAY_MS;
  if (!recoveryAt || recoveryAt <= now + 1000) {
    chrome.alarms.create(DAILY_EXPORT_RECOVERY_ALARM_NAME, { when: nextRecoveryAt });
  }
  chrome.alarms.create(DAILY_EXPORT_HEALTH_ALARM_NAME, { periodInMinutes: 60 });
  return writeDailyExportSchedule({ ...current, nextRunAt: next, nextRecoveryAt });
}

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function yesterdayDateRange() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const value = localIsoDate(yesterday);
  return { startDate: value, endDate: value };
}

function dateRangeForTargetDate(targetDate) {
  const value = String(targetDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("定时导出日期无效。");
  return { startDate: value, endDate: value };
}

/** 当前时刻应当已经完成的最近一次日报；在每天执行时间前，检查前一天的排程。 */
function dueDailyTarget(schedule, now = new Date()) {
  const [hours, minutes] = String(schedule.time || "08:00").split(":").map(Number);
  const todaySlot = new Date(now);
  todaySlot.setHours(hours, minutes, 0, 0);
  const target = new Date(now);
  if (now.getTime() < todaySlot.getTime()) target.setDate(target.getDate() - 2);
  else target.setDate(target.getDate() - 1);
  const slotAt = new Date(target);
  slotAt.setDate(slotAt.getDate() + 1);
  slotAt.setHours(hours, minutes, 0, 0);
  return { targetDate: localIsoDate(target), slotAt: slotAt.getTime() };
}

function dailyRunIsFresh(schedule, now = Date.now()) {
  const startedAt = Number(schedule?.activeRun?.startedAt);
  return Boolean(schedule?.activeRun?.taskId && Number.isFinite(startedAt) && now - startedAt >= 0 && now - startedAt < DAILY_EXPORT_STALE_RUN_MS);
}

async function clearStaleDailyRun(schedule, now = Date.now()) {
  if (!schedule?.activeRun || dailyRunIsFresh(schedule, now)) return schedule;
  const targetDate = schedule.activeRun.targetDate || "未知日期";
  return writeDailyExportSchedule({
    ...schedule,
    activeRun: null,
    lastFailureAt: now,
    lastResult: `检测到 ${targetDate} 的定时任务超过 40 分钟未完成，已释放任务锁并等待补偿。`,
    lastRunSource: "异常恢复"
  });
}

function isChatRecordTab(url = "") {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "work.1688.com" || parsed.hostname === "air.1688.com") &&
      (parsed.href.includes("cco_qcxy_zzh_chat") || parsed.href.includes("chatRecord"));
  } catch {
    return false;
  }
}

function waitForScheduleTabLoad(tabId, timeout = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function scheduleSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDailyExportTab() {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => isChatRecordTab(tab.url));
  if (existing?.id) return { tab: existing, openedByPlugin: false };
  const created = await chrome.tabs.create({ url: CHAT_RECORD_URL, active: false });
  await waitForScheduleTabLoad(created.id);
  await scheduleSleep(1800);
  return { tab: await chrome.tabs.get(created.id), openedByPlugin: true };
}

async function connectDailyExportPage(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: [
          "src/modules/chat-export/shared/download-filename.js",
          "src/modules/chat-export/content/content.js"
        ]
      });
      const frames = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => Boolean(globalThis.__GD_CHAT_CONNECTION__?.isTargetPage?.())
      });
      const target = frames.find((frame) => frame.result === true);
      if (target) return target.frameId;
      lastError = new Error("聊天记录查询页面尚未加载，可能需要重新登录 1688。");
    } catch (error) {
      lastError = error;
    }
    await scheduleSleep(800);
  }
  throw new Error(lastError?.message || "无法连接聊天记录查询页面。");
}

function dailyRunLabel(source) {
  if (source === "alarm") return "自动闹钟";
  if (source === "recovery") return "补偿检查";
  if (source === "startupRecovery") return "启动补偿";
  return "手动测试";
}

async function recordDailyTrigger(schedule, source) {
  const now = Date.now();
  const next = {
    ...schedule,
    lastRunSource: dailyRunLabel(source),
    lastResult: `${dailyRunLabel(source)}已触发，正在导出。`
  };
  if (source === "alarm") next.lastAutoTriggerAt = now;
  if (source === "manual") next.lastManualTriggerAt = now;
  if (source === "recovery") next.lastRecoveryCheckAt = now;

  if (source === "alarm") {
    // 一到触发时间就立刻注册下一天的主闹钟；无论本次成功、失败或浏览器重启，都无需手动再保存。
    const nextRunAt = nextDailyScheduleTime(schedule.time);
    chrome.alarms.create(DAILY_EXPORT_ALARM_NAME, { when: nextRunAt });
    next.nextRunAt = nextRunAt;
  }
  return writeDailyExportSchedule(next);
}

/**
 * MV3 的 Service Worker 随时可能被回收，所以运行状态必须落盘。
 * 任务开始后由 activeRun 持有 40 分钟租约；重启后仍可避免同一天并发导出。
 */
async function claimDailyExportRun({ source, targetDate, taskId }) {
  const current = await readDailyExportSchedule();
  if (dailyRunIsFresh(current)) return null;
  return writeDailyExportSchedule({
    ...current,
    activeRun: {
      taskId,
      targetDate,
      source,
      startedAt: Date.now()
    },
    lastRunSource: dailyRunLabel(source),
    lastResult: `${dailyRunLabel(source)}已开始导出 ${targetDate}。`
  });
}

async function finishDailyExportSchedule(result, { source, targetDate, success }) {
  const schedule = await readDailyExportSchedule();
  const now = Date.now();
  const next = {
    ...schedule,
    lastRunAt: Date.now(),
    lastResult: result,
    lastRunSource: dailyRunLabel(source),
    activeRun: null
  };
  if (success) {
    next.lastCompletedTargetDate = targetDate;
    next.lastFailureAt = null;
    let nextRunAt = Number(schedule.nextRunAt);
    if (!Number.isFinite(nextRunAt) || nextRunAt <= now + 1000) {
      nextRunAt = nextDailyScheduleTime(schedule.time);
      chrome.alarms.create(DAILY_EXPORT_ALARM_NAME, { when: nextRunAt });
    }
    await chrome.alarms.clear(DAILY_EXPORT_RECOVERY_ALARM_NAME);
    const nextRecoveryAt = nextRunAt + DAILY_EXPORT_RECOVERY_DELAY_MS;
    chrome.alarms.create(DAILY_EXPORT_RECOVERY_ALARM_NAME, { when: nextRecoveryAt });
    next.nextRunAt = nextRunAt;
    next.nextRecoveryAt = nextRecoveryAt;
  } else {
    next.lastFailureAt = now;
  }
  return writeDailyExportSchedule(next);
}

async function runDailyJsonExport({ source = "manual", targetDate = "" } = {}) {
  if (dailyExportRunning) return;
  dailyExportRunning = true;
  let openedTabId = null;
  try {
    let schedule = await readDailyExportSchedule();
    if (!schedule.enabled) return;
    schedule = await clearStaleDailyRun(schedule);
    if (dailyRunIsFresh(schedule)) return;
    schedule = await recordDailyTrigger(schedule, source);
    const { startDate, endDate } = targetDate ? dateRangeForTargetDate(targetDate) : yesterdayDateRange();
    if (schedule.lastCompletedTargetDate === startDate) {
      await finishDailyExportSchedule(`${dailyRunLabel(source)}跳过：${startDate} 已导出完成。`, {
        source,
        targetDate: startDate,
        success: true
      });
      return;
    }
    if (schedule.employees.length !== 5) {
      await finishDailyExportSchedule("失败：定时任务必须保存五位销售。", { source, targetDate: startDate, success: false });
      return;
    }
    const currentTask = await readTaskState();
    if (["running", "paused", "canceling"].includes(currentTask.status)) {
      await finishDailyExportSchedule("跳过：已有导出任务正在运行。", { source, targetDate: startDate, success: false });
      return;
    }

    const taskId = `daily-json-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const initialLog = `[${dailyRunLabel(source)}] 开始导出昨天 ${startDate} 的 JSON：${schedule.employees.join("、")}`;
    try {
      const claimed = await claimDailyExportRun({ source, targetDate: startDate, taskId });
      if (!claimed) return;
      const dailyTab = await getDailyExportTab();
      const tab = dailyTab.tab;
      openedTabId = dailyTab.openedByPlugin ? tab.id : null;
      await writeTaskState({
        status: "running",
        logs: [initialLog],
        startedAt: Date.now(),
        formatLabel: "定时 JSON",
        employees: schedule.employees,
        startDate,
        endDate,
        syncToFeishu: false,
        taskId,
        tabId: tab.id,
        message: "每日定时导出进行中"
      }).then(broadcastTaskState);
      const frameId = await connectDailyExportPage(tab.id);
      const result = await chrome.tabs.sendMessage(tab.id, {
        module: MODULE_ID,
        type: "START_EXPORT",
        taskId,
        exportFormat: "json",
        employees: schedule.employees,
        storeName: schedule.storeName,
        syncToFeishu: false,
        startDate,
        endDate
      }, { frameId });
      if (!result?.ok) throw new Error(result?.message || "定时导出未完成。");
      const resultText = `完成：${startDate}，${result.totalRows || 0} 条记录。`;
      await finishDailyExportSchedule(resultText, { source, targetDate: startDate, success: true });
    } catch (error) {
      const message = `失败：${readableError(error, "无法执行定时导出")}`;
      await updateTaskState({ status: "error", message });
      await finishDailyExportSchedule(message, { source, targetDate: startDate, success: false });
    }
  } finally {
    // 仅关闭本次后台临时创建的页面，绝不关闭用户原本打开的聊天记录页。
    if (openedTabId) chrome.tabs.remove(openedTabId).catch(() => {});
    dailyExportRunning = false;
  }
}

async function runDailyRecoveryCheck() {
  let schedule = await readDailyExportSchedule();
  if (!schedule.enabled) return;
  schedule = await clearStaleDailyRun(schedule);
  if (dailyRunIsFresh(schedule)) return;
  const { targetDate: startDate } = dueDailyTarget(schedule);
  if (schedule.lastCompletedTargetDate === startDate) {
    await finishDailyExportSchedule(`补偿检查：${startDate} 已确认导出完成。`, {
      source: "recovery",
      targetDate: startDate,
      success: true
    });
    return;
  }
  await runDailyJsonExport({ source: "recovery", targetDate: startDate });
}

/** Chrome 重启后只补偿“启用之后已经错过”的最近一次日报，不回补未知历史日期。 */
async function runStartupDailyRecovery() {
  let schedule = await readDailyExportSchedule();
  if (!schedule.enabled) return;
  schedule = await clearStaleDailyRun(schedule);
  if (dailyRunIsFresh(schedule)) return;
  const { targetDate, slotAt } = dueDailyTarget(schedule);
  const enabledAt = Number(schedule.enabledAt);
  if (!Number.isFinite(enabledAt) || enabledAt <= 0 || slotAt < enabledAt) return;
  if (schedule.lastCompletedTargetDate === targetDate) return;
  await runDailyJsonExport({ source: "startupRecovery", targetDate });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_EXPORT_ALARM_NAME) {
    runDailyJsonExport({ source: "alarm" }).catch(() => {});
    return;
  }
  if (alarm.name === DAILY_EXPORT_RECOVERY_ALARM_NAME) {
    runDailyRecoveryCheck().catch(() => {});
    return;
  }
  if (alarm.name === DAILY_EXPORT_HEALTH_ALARM_NAME) {
    ensureDailyExportAlarms().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureDailyExportAlarms()
    .then(() => runStartupDailyRecovery())
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureDailyExportAlarms().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.module !== MODULE_ID) return false;

  if (message.type === "GET_DAILY_EXPORT_SCHEDULE") {
    readDailyExportSchedule()
      .then((schedule) => sendResponse({ ok: true, schedule }))
      .catch((error) => sendResponse({ ok: false, message: readableError(error, "读取定时导出设置失败") }));
    return true;
  }

  if (message.type === "SAVE_DAILY_EXPORT_SCHEDULE") {
    (async () => {
      const enabled = message.enabled === true;
      const time = String(message.time || "");
      const employees = Array.isArray(message.employees) ? message.employees.map((item) => String(item || "").trim()).filter(Boolean) : [];
      const storeName = String(message.storeName || "").trim();
      if (enabled && !validScheduleTime(time)) throw new Error("请选择有效的每日执行时间。");
      if (enabled && employees.length !== 5) throw new Error("每日自动导出必须固定选择五位销售。");
      if (enabled && !storeName) throw new Error("请先填写店铺名称。");
      const current = await readDailyExportSchedule();
      const keepEnabledAt = enabled && current.enabled && current.time === time &&
        Number.isFinite(Number(current.enabledAt)) && Number(current.enabledAt) > 0;
      const saved = await writeDailyExportSchedule({
        ...current,
        enabled,
        time: validScheduleTime(time) ? time : current.time,
        employees,
        storeName,
        // 新启用或调整时间后只从新的排程开始补偿，避免误跑设置之前的日期。
        enabledAt: keepEnabledAt ? current.enabledAt : (enabled ? Date.now() : null),
        activeRun: enabled ? current.activeRun : null
      });
      const schedule = await armDailyExportAlarm(saved);
      sendResponse({ ok: true, schedule });
    })().catch((error) => sendResponse({ ok: false, message: readableError(error, "保存定时导出设置失败") }));
    return true;
  }

  if (message.type === "RUN_DAILY_EXPORT_NOW") {
    readDailyExportSchedule().then((schedule) => {
      if (!schedule.enabled) throw new Error("请先启用并保存每日自动导出设置。");
      if (schedule.employees.length !== 5) throw new Error("每日自动导出必须保存五位销售。");
      runDailyJsonExport({ source: "manual" }).catch(() => {});
      sendResponse({ ok: true, message: "已启动每日自动导出测试。" });
    }).catch((error) => sendResponse({ ok: false, message: readableError(error, "无法启动定时导出测试") }));
    return true;
  }

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

  if (message.type === "STORE_CUSTOMER_HISTORY_BATCH") {
    (async () => {
      const taskId = String(message.taskId || "");
      const startIndex = Number(message.startIndex);
      const files = Array.isArray(message.files) ? message.files : [];
      if (!taskId || !Number.isInteger(startIndex) || startIndex < 0) {
        throw new Error("客户完整记录暂存参数无效。请重新导出。");
      }
      for (let offset = 0; offset < files.length; offset += 1) {
        const file = files[offset] || {};
        await storeCustomerHistoryPart({
          taskId,
          index: startIndex + offset,
          customer: file.customer,
          rows: file.rows
        });
      }
      sendResponse({ ok: true, storedCount: files.length });
    })().catch((error) => sendResponse({ ok: false, message: readableError(error, "客户完整记录暂存失败") }));
    return true;
  }

  if (message.type === "CLEAR_CUSTOMER_HISTORY_STAGING") {
    deleteStoredCustomerHistoryParts(String(message.taskId || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: readableError(error, "清理客户完整记录暂存失败") }));
    return true;
  }

  if (!["DOWNLOAD_EXCEL", "DOWNLOAD_JSON", "DOWNLOAD_JSONL", "DOWNLOAD_BATCH_ARCHIVE", "DOWNLOAD_CUSTOMER_HISTORY_ARCHIVE"].includes(message.type)) return false;

  (async () => {
    if (message.type === "DOWNLOAD_BATCH_ARCHIVE") {
      const taskId = message.taskId || "";
      throwIfBackgroundTaskCanceled(taskId);
      const archive = await buildBatchArchive({
        files: (message.files || []).map((file) => ({
          ...file,
          storeName: message.storeName || CHAT_EXPORT_DOWNLOAD_FILENAME.resolveStoreName(file.rawPayloads || file.rows)
        })),
        exportFormat: message.exportFormat === "json" ? "json" : "excel",
        startDate: message.startDate,
        endDate: message.endDate,
        taskId
      });
      const filename = CHAT_EXPORT_DOWNLOAD_FILENAME.buildArchiveFilename({
        storeName: message.storeName,
        employeeNames: message.employeeNames || [],
        startDate: message.startDate,
        endDate: message.endDate
      });
      const downloadResult = await downloadBlobWithOptionalFeishuSync(
        archive,
        filename,
        taskId,
        message.syncToFeishu === true
      );
      sendResponse({
        ok: true,
        downloadId: downloadResult.downloadId,
        feishu: downloadResult.feishu,
        message: `批量导出完成，已将 ${(message.files || []).length} 个销售文件压缩为一个 ZIP 文件。`
      });
      return;
    }

    if (message.type === "DOWNLOAD_CUSTOMER_HISTORY_ARCHIVE") {
      const taskId = message.taskId || "";
      throwIfBackgroundTaskCanceled(taskId);
      const storedFileCount = Number(message.storedFileCount);
      const usesStoredParts = Number.isInteger(storedFileCount) && storedFileCount >= 0;
      try {
        const archive = usesStoredParts
          ? await buildStoredCustomerHistoryArchive({
            taskId,
            fileCount: storedFileCount,
            storeName: message.storeName,
            startDate: message.startDate,
            endDate: message.endDate
          })
          : await buildCustomerHistoryArchive({
            files: message.files || [],
            storeName: message.storeName,
            startDate: message.startDate,
            endDate: message.endDate,
            taskId
          });
        const filename = CHAT_EXPORT_DOWNLOAD_FILENAME.buildCustomerHistoryArchiveFilename({
          storeName: message.storeName,
          startDate: message.startDate,
          endDate: message.endDate
        });
        const downloadResult = await downloadBlobWithOptionalFeishuSync(archive, filename, taskId, false);
        sendResponse({
          ok: true,
          downloadId: downloadResult.downloadId,
          message: `客户完整记录导出完成，压缩包包含 ${usesStoredParts ? storedFileCount : (message.files || []).length} 位客户。`
        });
      } finally {
        if (usesStoredParts) await deleteStoredCustomerHistoryParts(taskId);
      }
      return;
    }

    if (["DOWNLOAD_JSON", "DOWNLOAD_JSONL"].includes(message.type)) {
      const taskId = message.taskId || "";
      throwIfBackgroundTaskCanceled(taskId);
      const records = buildCompatibleRecords({ rows: message.rows || [] });
      const compatibleResult = {
        pluginName: "LAI助手",
        pluginVersion: globalThis.LAI_PLUGIN_VERSION || "V1.4.3",
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
