import { expect, it } from 'vitest';
import { allowedFilters, listPath, type Filters, type View } from '../../apps/web/src/part-time/model.js';

const filters: Filters = {
  serviceTypes: ['part_time'],
  serviceStatuses: ['ended'],
  current: 'false',
  pendingStatuses: ['rejected'],
  kinds: ['extend'],
  statuses: ['in_review'],
  requestSources: ['part_time'],
};
const cases: [View, string[]][] = [
  ['ongoing', []],
  ['not_started', []],
  ['ended', []],
  ['all', ['serviceStatuses', 'current']],
  ['expiring', ['pendingStatuses']],
  ['in_approval', ['kinds', 'statuses', 'requestSources']],
];

it.each(cases)('AC-FE-F255-history %s 只发送当前视图的合法筛选，仍裁剪撤权字段', (view, keys) => {
  const expected = ['serviceTypes', ...keys].sort();
  expect(Object.keys(allowedFilters(filters, () => true, view)).sort()).toEqual(expected);
  const query = new URL(listPath(view, 1, filters), 'https://example.com').searchParams;
  expect([...query.keys()].filter((key) => key in filters).sort()).toEqual(expected);
  const restricted = allowedFilters(filters, (key) => key !== 'requestSources', view);
  expect(restricted).not.toHaveProperty('requestSources');
});
