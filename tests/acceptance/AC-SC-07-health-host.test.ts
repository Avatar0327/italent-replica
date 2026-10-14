import { describe, expect, it } from 'vitest';
import { evaluateHealthLevels } from '../../packages/domain/src/succession/health.js';
import type { SuccessionLevelRow } from '@italent/domain';

const row: SuccessionLevelRow = {
  rowNo: 1,
  fieldCode: null,
  filterOperator: null,
  filterValues: [],
  measure: 'green_rate',
  comparator: 'between',
  threshold: 0.3,
  thresholdHigh: 0.6,
  isPercent: true,
  population: 'all',
  populationId: null,
  fieldSource: 'org',
};
const levels = [
  { id: 'HIGH', displayOrder: 1, rules: { expression: '1', rows: [row] } },
  {
    id: 'LOW',
    displayOrder: 2,
    rules: { expression: '1', rows: [{ ...row, comparator: 'ge' as const, threshold: 0 }] },
  },
];
describe('AC-SC-07 健康度五态与优先级', () => {
  it.each([0.3, 0.6])('边界 %s 不舍入、优先命中满星', async (value) => {
    expect(await evaluateHealthLevels([...levels].reverse(), async () => ({ status: 'value', value }))).toMatchObject({
      levelId: 'HIGH',
      skipped: [],
    });
  });
  it('空值不命中；零提名是 value=0，不是 module_absent', async () => {
    expect((await evaluateHealthLevels(levels, async () => ({ status: 'empty' }))).levelId).toBeNull();
    expect((await evaluateHealthLevels(levels, async () => ({ status: 'value', value: 0 }))).levelId).toBe('LOW');
  });
  it('module_absent 跳过等级继续匹配', async () => {
    expect(
      await evaluateHealthLevels(levels, async (_row, id) =>
        id === 'HIGH' ? { status: 'module_absent' } : { status: 'value', value: 0 },
      ),
    ).toMatchObject({ levelId: 'LOW', skipped: ['HIGH'] });
  });
  it.each([
    ['forbidden', 'FIELD_FORBIDDEN'],
    ['unavailable', 'DATA_UNAVAILABLE'],
  ] as const)('%s 对象失败，不向下匹配', async (status, code) => {
    let reads = 0;
    expect(
      await evaluateHealthLevels(levels, async () => {
        reads++;
        return { status };
      }),
    ).toMatchObject({ failure: { code, levelId: 'HIGH', rowNo: 1 } });
    expect(reads).toBe(1);
  });
  it('行组合沿用 B1，空值守卫与 or 短路不隐藏来源失败', async () => {
    const group = [{ ...levels[0]!, rules: { expression: '1 or 2', rows: [row, { ...row, rowNo: 2 }] } }];
    expect(
      await evaluateHealthLevels(group, async (r) =>
        r.rowNo === 1 ? { status: 'value', value: 0.4 } : { status: 'forbidden' },
      ),
    ).toMatchObject({ failure: { code: 'FIELD_FORBIDDEN', rowNo: 2 } });
  });
});
