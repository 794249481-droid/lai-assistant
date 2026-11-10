(function exposeChatExportDateSelection(root) {
  'use strict';

  const ROLLING_PRESETS = Object.freeze({
    yesterday: { startOffset: -1, endOffset: -1 },
    last15Days: { startOffset: -14, endOffset: 0 },
    last30Days: { startOffset: -29, endOffset: 0 }
  });

  function localCalendarDate(value = new Date()) {
    const source = new Date(value);
    if (Number.isNaN(source.getTime())) return null;
    return new Date(source.getFullYear(), source.getMonth(), source.getDate());
  }

  function shiftDays(date, amount) {
    const shifted = new Date(date);
    shifted.setDate(shifted.getDate() + amount);
    return shifted;
  }

  function formatLocalDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dateRange(start, end) {
    return {
      startDate: formatLocalDate(start),
      endDate: formatLocalDate(end)
    };
  }

  function getPresetRange(preset, now = new Date()) {
    const today = localCalendarDate(now);
    if (!today) return null;

    const rollingPreset = ROLLING_PRESETS[preset];
    if (rollingPreset) {
      return dateRange(
        shiftDays(today, rollingPreset.startOffset),
        shiftDays(today, rollingPreset.endOffset)
      );
    }

    if (preset === 'lastWeek') {
      // 1688 业务周按周六至周五计算，取最近一个已完整结束的业务周。
      const currentPeriodStart = shiftDays(today, -((today.getDay() + 1) % 7));
      return dateRange(
        shiftDays(currentPeriodStart, -7),
        shiftDays(currentPeriodStart, -1)
      );
    }

    if (preset === 'lastMonth') {
      return dateRange(
        new Date(today.getFullYear(), today.getMonth() - 1, 1),
        new Date(today.getFullYear(), today.getMonth(), 0)
      );
    }

    if (preset === 'thisMonth') {
      return dateRange(
        new Date(today.getFullYear(), today.getMonth(), 1),
        today
      );
    }

    return null;
  }

  function resolveDateRange({
    mode = 'custom',
    startDate = '',
    endDate = '',
    preset = '',
    now = new Date()
  } = {}) {
    if (mode === 'preset') return preset ? getPresetRange(preset, now) : null;
    return {
      startDate: String(startDate || ''),
      endDate: String(endDate || '')
    };
  }

  root.A1688ChatExportDateSelection = {
    formatLocalDate,
    getPresetRange,
    resolveDateRange
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.A1688ChatExportDateSelection;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
