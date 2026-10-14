import { expect, it } from 'vitest';
import { annotations } from '../../apps/web/src/annotations/index.js';

it.each([
  'foundation',
  'approval',
  'transfer',
  'transfer-form',
  'personnel',
  'personnel-records',
  'personnel-filters',
  'settings',
  'settings.snapshot',
  'talent-review-projects',
  'talent-review-templates',
  'talent-review-matrices',
  'talent-review-demo',
])('AC-FE-R1c-20 合 main 后仍登记 %s 注释', (key) => {
  expect(annotations[key]).toEqual(
    expect.objectContaining({
      original: expect.any(String),
      decision: expect.any(String),
      decisions: expect.any(Array),
    }),
  );
});
