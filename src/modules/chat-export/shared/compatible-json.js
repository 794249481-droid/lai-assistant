(function installA1688ChatExportCompatibleJson(global, factory) {
  const api = factory();
  global.A1688ChatExportCompatibleJson = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function createA1688ChatExportCompatibleJson() {
  function cleanText(value) {
    return value == null ? "" : String(value).trim();
  }

  function parseNdjson(source) {
    const records = [];
    String(source || "").split(/\r?\n/).forEach((line, index) => {
      const text = line.trim();
      if (!text) return;
      try {
        records.push(JSON.parse(text));
      } catch (error) {
        throw new Error(`第 ${index + 1} 行不是有效 JSON：${error.message}`);
      }
    });
    return records;
  }

  function beijingParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function toBeijingIso(value) {
    const text = cleanText(value);
    if (!text) return "";

    const localMatch = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/);
    if (localMatch) {
      return `${localMatch[1]}T${localMatch[2]}${localMatch[3] || ""}+08:00`;
    }

    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return text;
    const parts = beijingParts(parsed);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
  }

  function recordDate(value) {
    const normalized = toBeijingIso(value);
    const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T/);
    return match ? match[1] : "";
  }

  function extractEmployeeName(records) {
    const counts = new Map();
    let bestName = "";
    let bestCount = 0;

    for (const record of records || []) {
      const name = cleanText(record?.employee);
      if (!name) continue;
      const count = (counts.get(name) || 0) + 1;
      counts.set(name, count);
      if (count > bestCount) {
        bestName = name;
        bestCount = count;
      }
    }

    return bestName;
  }

  function getDateRange(records) {
    const dates = (records || []).map((record) => recordDate(record?.time)).filter(Boolean).sort();
    if (!dates.length) return { startDate: "", endDate: "" };
    return { startDate: dates[0], endDate: dates[dates.length - 1] };
  }

  function firstImageUrl(value) {
    if (Array.isArray(value)) {
      return cleanText(value.find((item) => cleanText(item)));
    }
    return cleanText(value);
  }

  function sequenceNumber(value) {
    if (value === "" || value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function timeNumber(value) {
    const parsed = Date.parse(toBeijingIso(value));
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  }

  function compareMessages(left, right) {
    if (left.sequence != null && right.sequence != null && left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    if (left.sequence != null && right.sequence == null) return -1;
    if (left.sequence == null && right.sequence != null) return 1;
    if (left.timeNumber !== right.timeNumber) return left.timeNumber - right.timeNumber;
    return left.index - right.index;
  }

  function convertRecords(records, options = {}) {
    const groups = new Map();

    (records || []).forEach((record, index) => {
      const conversationId = cleanText(record?.conversation_id);
      if (!groups.has(conversationId)) {
        groups.set(conversationId, {
          name: cleanText(record?.customer),
          messages: []
        });
      }

      const group = groups.get(conversationId);
      if (!group.name) group.name = cleanText(record?.customer);
      const imageUrl = firstImageUrl(record?.image_urls);
      const employeeSide = record?.sender_role === "employee";
      group.messages.push({
        index,
        sequence: sequenceNumber(record?.sequence),
        timeNumber: timeNumber(record?.time),
        value: {
          sendTime: toBeijingIso(record?.time),
          from: employeeSide ? "seller" : "buyer",
          senderName: cleanText(record?.sender_name) || cleanText(employeeSide ? record?.employee : record?.customer),
          type: imageUrl ? "image" : "text",
          text: record?.text == null ? "" : String(record.text),
          imageUrl
        }
      });
    });

    const customers = [...groups.values()].map((group) => ({
      name: group.name,
      messages: group.messages.sort(compareMessages).map((message) => message.value)
    }));

    return {
      exportedAt: options.exportedAt || new Date().toISOString(),
      customers
    };
  }

  function convertNdjson(source, options) {
    return convertRecords(parseNdjson(source), options);
  }

  function stringifyCompatibleJson(result) {
    return JSON.stringify(result, null, 2);
  }

  return Object.freeze({
    convertNdjson,
    convertRecords,
    extractEmployeeName,
    getDateRange,
    parseNdjson,
    stringifyCompatibleJson,
    toBeijingIso
  });
});
