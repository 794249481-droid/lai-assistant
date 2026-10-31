(function installA1688ChatExportDownloadFilename(global, factory) {
  const api = factory();
  global.A1688ChatExportDownloadFilename = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createA1688ChatExportDownloadFilename() {
  const DEFAULT_STORE_NAME = "店铺";
  const STORE_NAME_FIELDS = new Set([
    "shopName",
    "storeName",
    "companyName",
    "sellerCompanyName",
    "sellerShopName",
    "merchantName",
    "enterpriseName",
    "shopNick"
  ]);

  function safeFileNamePart(value, fallback) {
    const normalized = String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 60);
    return normalized || fallback;
  }

  function findStoreName(value, seen) {
    if (!value || typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);

    for (const key of STORE_NAME_FIELDS) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }

    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const storeName = findStoreName(child, seen);
      if (storeName) return storeName;
    }
    return "";
  }

  function resolveStoreName(payloads) {
    const entries = Array.isArray(payloads) ? payloads : [payloads];
    for (const entry of entries) {
      const storeName = findStoreName(entry, new Set());
      if (storeName) return safeFileNamePart(storeName, DEFAULT_STORE_NAME);
    }
    return DEFAULT_STORE_NAME;
  }

  function buildFilename({ storeName, employeeName, startDate, endDate }, extension) {
    const selectedStoreName = String(storeName || '').trim();
    const branchName = selectedStoreName ? '店铺' : '未命名店铺';
    const storePart = safeFileNamePart(branchName, '未命名店铺');
    const employeePart = safeFileNamePart(employeeName, "员工");
    const startDatePart = safeFileNamePart(startDate, "开始日期");
    const endDatePart = safeFileNamePart(endDate, "结束日期");
    return `${storePart}_${employeePart}_${startDatePart}_${endDatePart}.${extension}`;
  }

  function buildExcelFilename(options) {
    return buildFilename(options, "xlsx");
  }

  function safeJsonFileNamePart(value, fallback) {
    const normalized = String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_. ]+|[_. ]+$/g, "")
      .slice(0, 60);
    return normalized || fallback;
  }

  function buildJsonFilename({ storeName, employeeName, startDate, endDate }) {
    const selectedStoreName = String(storeName || '').trim();
    const branchName = selectedStoreName ? '店铺' : '未命名店铺';
    const storePart = safeJsonFileNamePart(branchName, '未命名店铺');
    const employeePart = safeJsonFileNamePart(employeeName, "unknown");
    const startDatePart = safeJsonFileNamePart(startDate, isoDate(new Date()));
    const endDatePart = safeJsonFileNamePart(endDate, startDatePart);
    const datePart = startDatePart === endDatePart
      ? startDatePart
      : `${startDatePart}_至_${endDatePart}`;
    return `${storePart}_${employeePart}_${datePart}.json`;
  }

  function dateFromIso(value) {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T00:00:00.000Z`);
    return date.toISOString().slice(0, 10) === text ? date : null;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function createSevenDayPeriods(startDate, endDate) {
    const start = dateFromIso(startDate);
    const end = dateFromIso(endDate);
    if (!start || !end) throw new Error("日期格式无效。");
    if (start > end) throw new Error("开始日期不能晚于结束日期。");

    const periods = [];
    for (let periodStart = start; periodStart <= end;) {
      const periodEnd = new Date(periodStart);
      periodEnd.setUTCDate(periodEnd.getUTCDate() + 6);
      if (periodEnd > end) periodEnd.setTime(end.getTime());
      periods.push({ startDate: isoDate(periodStart), endDate: isoDate(periodEnd) });
      periodStart = new Date(periodEnd);
      periodStart.setUTCDate(periodStart.getUTCDate() + 1);
    }
    return periods;
  }

  return Object.freeze({
    buildExcelFilename,
    buildJsonFilename,
    createSevenDayPeriods,
    resolveStoreName,
    safeFileNamePart
  });
});
