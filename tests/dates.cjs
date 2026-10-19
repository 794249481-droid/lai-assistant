'use strict';
const assert = require('node:assert/strict');
const dates = require('../src/modules/chat-export/shared/date-selection.js');
const preflight = require('../src/modules/chat-export/shared/preflight-guidance.js');
const cases = [
  [new Date(2026, 4, 31, 0, 30), '2026-02-28', '2026-03-01', '2026-05-31'],
  [new Date(2024, 4, 31, 23, 30), '2024-02-29', '2024-03-01', '2024-05-31'],
  [new Date(2026, 0, 31, 0, 30), '2025-10-31', '2025-11-01', '2026-01-31'],
  [new Date(2026, 9, 19, 0, 30), '2026-07-19', '2026-07-20', '2026-10-19']
];
for (const [now, boundary, start, end] of cases) {
  assert.equal(dates.formatLocalDate(dates.threeMonthsEarlier(now)), boundary);
  assert.equal(preflight.earliestAllowedDate(now), boundary);
  assert.deepEqual(dates.getPresetRange('last3Months', now), {startDate: start, endDate: end});
}
console.log('近三个月日期边界测试通过');
