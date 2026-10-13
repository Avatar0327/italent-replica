import { expect, it } from 'vitest';
import { annotations } from '../../apps/web/src/annotations/index.js';

it.each([
  'evaluation',
  'evaluation-paused',
  'foundation',
  'personnel',
  'personnel-records',
  'personnel-filters',
  'settings',
  'settings.snapshot',
  'survey360',
  'talent-review-projects',
  'talent-review-templates',
  'talent-review-matrices',
  'talent-review-demo',
])('AC-FE-R3c-10 合并 main 后保留 %s 注释登记', (id) => {
  expect(annotations[id]).toBeDefined();
  expect(annotations[id]?.decisions).toContain('DEC-456');
  expect(annotations[id]?.original).toBeTruthy();
  expect(annotations[id]?.decision).toBeTruthy();
});
