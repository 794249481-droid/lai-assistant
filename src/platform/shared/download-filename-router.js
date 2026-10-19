(function installA1688DownloadFilenameRouter(global) {
  if (global.A1688DownloadFilenameRouter) return;

  const filenameByUrl = new Map();
  const downloadById = new Map();
  const filenameResolvers = new Set();

  function registerUrl(url, filename) {
    if (!url || !filename) return;
    filenameByUrl.set(url, filename);
  }

  function forgetUrl(url) {
    if (!url) return;
    filenameByUrl.delete(url);
  }

  function trackDownload(downloadId, options = {}) {
    if (downloadId === undefined || downloadId === null || !options.url) return;
    downloadById.set(downloadId, {
      url: options.url,
      cleanup: typeof options.cleanup === 'function' ? options.cleanup : null
    });
  }

  function forgetDownload(downloadId) {
    const item = downloadById.get(downloadId);
    if (!item) return;
    downloadById.delete(downloadId);
    forgetUrl(item.url);
  }

  async function cleanupDownload(downloadId) {
    const item = downloadById.get(downloadId);
    if (!item) return;
    forgetDownload(downloadId);
    if (item.cleanup) {
      await item.cleanup(downloadId, item).catch(() => {});
    }
  }

  function addResolver(resolver) {
    if (typeof resolver !== 'function') return () => {};
    filenameResolvers.add(resolver);
    return () => filenameResolvers.delete(resolver);
  }

  async function resolveFilename(downloadItem) {
    const directFilename = filenameByUrl.get(downloadItem.url);
    if (directFilename) return directFilename;

    for (const resolver of filenameResolvers) {
      const result = await resolver(downloadItem);
      if (typeof result === 'string' && result) return result;
      if (result && typeof result.filename === 'string' && result.filename) return result.filename;
    }
    return '';
  }

  if (chrome.downloads?.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
      if (!filenameResolvers.size) {
        const filename = filenameByUrl.get(downloadItem.url);
        if (filename) suggest({ filename, conflictAction: 'uniquify' });
        return;
      }

      resolveFilename(downloadItem)
        .then((filename) => {
          if (filename) suggest({ filename, conflictAction: 'uniquify' });
          else suggest();
        })
        .catch(() => suggest());
      return true;
    });
  }

  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      const isFinished = delta?.state?.current === 'complete' || Boolean(delta?.error?.current || delta?.error);
      if (isFinished) {
        cleanupDownload(delta.id);
      }
    });
  }

  global.A1688DownloadFilenameRouter = Object.freeze({
    registerUrl,
    forgetUrl,
    addResolver,
    trackDownload,
    forgetDownload
  });
})(globalThis);
