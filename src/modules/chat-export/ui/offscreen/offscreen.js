const MODULE_ID = "chatExport";
const CHAT_EXPORT_BLOB_DB = "chatExportBlobDownloads";
const CHAT_EXPORT_BLOB_STORE = "files";
const URL_BY_BLOB_KEY = new Map();

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

async function readStoredBlob(blobKey) {
  const db = await openBlobDb();
  try {
    const transaction = db.transaction(CHAT_EXPORT_BLOB_STORE, "readonly");
    const store = transaction.objectStore(CHAT_EXPORT_BLOB_STORE);
    const record = await requestToPromise(store.get(blobKey));
    const blob = record?.blob || record;
    if (!(blob instanceof Blob)) throw new Error("Stored download blob was not found.");
    return blob;
  } finally {
    db.close();
  }
}

async function createObjectUrlForStoredBlob(blobKey) {
  const existing = URL_BY_BLOB_KEY.get(blobKey);
  if (existing) return existing;
  const blob = await readStoredBlob(blobKey);
  const url = URL.createObjectURL(blob);
  URL_BY_BLOB_KEY.set(blobKey, url);
  return url;
}

function revokeObjectUrl(blobKey, url) {
  const resolvedUrl = url || URL_BY_BLOB_KEY.get(blobKey);
  if (!resolvedUrl) return;
  URL.revokeObjectURL(resolvedUrl);
  if (blobKey) URL_BY_BLOB_KEY.delete(blobKey);
  for (const [key, value] of URL_BY_BLOB_KEY) {
    if (value === resolvedUrl) URL_BY_BLOB_KEY.delete(key);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.module !== MODULE_ID) return false;

  if (message.type === "CREATE_OFFSCREEN_BLOB_URL") {
    createObjectUrlForStoredBlob(message.blobKey)
      .then((url) => sendResponse({ ok: true, url }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "REVOKE_OFFSCREEN_BLOB_URL") {
    try {
      revokeObjectUrl(message.blobKey, message.url);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, message: error.message });
    }
    return true;
  }

  return false;
});
