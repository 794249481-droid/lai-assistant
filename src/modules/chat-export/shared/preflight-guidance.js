(function exposeChatExportPreflightGuidance(root) {
  'use strict';

  const REMINDER_STATUS = 'reminder';
  const REMINDER_LABEL = '提醒';

  function earliestAllowedDate(today = new Date()) {
    const dates = root.A1688ChatExportDateSelection || (typeof require === 'function' && require('./date-selection.js'));
    return dates.formatLocalDate(dates.threeMonthsEarlier(today));
  }

  function createReminder(text) {
    return {
      status: REMINDER_STATUS,
      label: REMINDER_LABEL,
      percentage: 0,
      text
    };
  }

  function getPreflightReminder({
    storeName = '',
    dateMode = 'custom',
    datePreset = '',
    startDate = '',
    endDate = '',
    selectedEmployeeCount = 0,
    today = new Date()
  } = {}) {
    if (!String(storeName).trim()) {
      return createReminder('请填写并保存店铺名称后再导出。');
    }

    if (dateMode === 'preset' && !datePreset) {
      return createReminder('请选择一个快捷日期范围。');
    }

    if (!startDate || !endDate) {
      return createReminder('请填写开始日期和结束日期。');
    }

    if (endDate < startDate) {
      return createReminder('结束日期不能早于开始日期。');
    }

    if (startDate < earliestAllowedDate(today)) {
      return createReminder('当前选择的日期超出可查询范围，仅支持近三个月的聊天记录，请调整开始日期。');
    }

    if (Number(selectedEmployeeCount) <= 0) {
      return createReminder('请至少选择一个员工账号后再导出。');
    }

    return null;
  }

  root.A1688ChatExportPreflightGuidance = {
    REMINDER_STATUS,
    REMINDER_LABEL,
    earliestAllowedDate,
    getPreflightReminder
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.A1688ChatExportPreflightGuidance;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
