(function exposeChatExportFeishuSync(root) {
  'use strict';

  const SETTINGS_KEY = 'integrated.chatExport.feishuSyncSettings';
  const ATTACHMENT_FIELD_TYPE = 17;

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeField(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      fieldId: text(source.fieldId || source.field_id || source.id),
      fieldName: text(source.fieldName || source.field_name || source.name || source.label),
      type: Number(source.type),
      isPrimary: source.isPrimary === true || source.is_primary === true
    };
  }

  function normalizeFields(value) {
    const seen = new Set();
    const fields = [];
    for (const field of Array.isArray(value) ? value : []) {
      const normalized = normalizeField(field);
      if (!normalized.fieldId || !normalized.fieldName || seen.has(normalized.fieldId)) continue;
      seen.add(normalized.fieldId);
      fields.push(normalized);
    }
    return fields;
  }

  function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      enabled: source.enabled === true,
      feishuAppId: text(source.feishuAppId || source.appId),
      feishuAppSecret: text(source.feishuAppSecret || source.appSecret),
      feishuTableUrl: text(source.feishuTableUrl || source.tableUrl),
      attachmentFieldId: text(source.attachmentFieldId),
      attachmentFieldName: text(source.attachmentFieldName),
      primaryFieldName: text(source.primaryFieldName),
      fields: normalizeFields(source.fields),
      updatedAt: text(source.updatedAt)
    };
  }

  function parseBitableUrl(rawUrl) {
    const value = text(rawUrl);
    if (!value) throw new Error('请填写飞书多维表格链接。');

    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('飞书多维表格链接格式不正确。');
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const baseIndex = segments.indexOf('base');
    const appToken = baseIndex >= 0 ? text(segments[baseIndex + 1]) : '';
    const tableId = text(
      url.searchParams.get('table') ||
      url.searchParams.get('table_id') ||
      url.searchParams.get('tableId') ||
      segments.find((segment) => /^tbl[a-zA-Z0-9]+$/.test(segment))
    );

    if (!appToken || !tableId) {
      throw new Error('飞书多维表格链接里没有识别到 base token 或 table id。');
    }

    return { appToken, tableId };
  }

  function attachmentFields(value) {
    return normalizeFields(value).filter((field) => field.type === ATTACHMENT_FIELD_TYPE);
  }

  function chooseAttachmentField(value, preferredFieldId = '') {
    const fields = attachmentFields(value);
    const preferred = text(preferredFieldId);
    if (preferred) {
      const selected = fields.find((field) => field.fieldId === preferred);
      if (selected) return selected;
    }
    const namedAttachment = fields.find((field) => /附件|文件/i.test(field.fieldName));
    return namedAttachment || fields[0] || null;
  }

  function choosePrimaryField(value) {
    const fields = normalizeFields(value);
    return fields.find((field) => field.isPrimary) || fields.find((field) => field.type === 1) || null;
  }

  function validateEnabledSettings(value) {
    const settings = normalizeSettings(value);
    if (!settings.enabled) return settings;
    if (!settings.feishuAppId) throw new Error('请填写飞书 App ID。');
    if (!settings.feishuAppSecret) throw new Error('请填写飞书 App Secret。');
    if (!settings.feishuTableUrl) throw new Error('请填写飞书多维表格链接。');
    if (!settings.attachmentFieldId || !settings.attachmentFieldName) {
      throw new Error('请先读取并选择飞书附件字段。');
    }

    return {
      ...settings,
      ...parseBitableUrl(settings.feishuTableUrl)
    };
  }

  function buildRecordFields(settingsValue, filename, fileToken) {
    const settings = validateEnabledSettings(settingsValue);
    const fields = {
      [settings.attachmentFieldName]: [{ file_token: text(fileToken) }]
    };
    if (settings.primaryFieldName) fields[settings.primaryFieldName] = text(filename);
    return fields;
  }

  const api = {
    SETTINGS_KEY,
    ATTACHMENT_FIELD_TYPE,
    normalizeFields,
    normalizeSettings,
    parseBitableUrl,
    attachmentFields,
    chooseAttachmentField,
    choosePrimaryField,
    validateEnabledSettings,
    buildRecordFields
  };

  root.A1688ChatExportFeishuSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
