import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvalContentFields } from './controlled-fields.js';
import { ExactAuditFields } from './transfer-linkage.js';
import { visibleChanges, visibleValue } from './visibility.js';

const ID = randomUUID();
const viewable = (...fields: string[]) => new Set(fields);

describe('approvalContentFields（F-326 变量与矩阵审计可见键）', () => {
  it('不受字段限制的查看人返回 undefined', () => {
    expect(approvalContentFields(undefined)).toBeUndefined();
  });

  it('没有任何字段权限：空集，什么都不放行（含动态键）', () => {
    const fields = approvalContentFields(viewable())!;
    expect(fields).toBeInstanceOf(ExactAuditFields);
    for (const path of ['code', 'dataType', `row:${ID}`, `row:${ID}.seq`, `column:${ID}.name`, `cells.${ID}`]) {
      expect(fields.has(path), path).toBe(false);
    }
  });

  it('基础字段只放行同名键；列名不会借「名称」权限泄露（不按末段回退）', () => {
    const fields = approvalContentFields(viewable('code', 'name', 'status'))!;
    expect([...fields].sort()).toEqual(['code', 'matrixCode', 'name', 'status']);
    expect(fields.has(`column:${ID}.name`)).toBe(false);
    const changes = [
      { field: `column:${ID}.name`, from: null, to: '部门' },
      { field: 'name', from: '甲', to: '乙' },
    ];
    expect(visibleChanges(changes, fields)).toEqual([changes[1]]);
  });

  it('节点字段：放行变量内容键、来源键与受控的动态路径，其余仍拒绝', () => {
    const fields = approvalContentFields(viewable('nodes'))!;
    for (const path of [
      'dataType',
      'defaultValue',
      'usageScopes',
      'appId',
      'origin',
      'originProcessId',
      'originVersionId',
      'originNodeKey',
      'originSlot',
      `row:${ID}`,
      `row:${ID}.seq`,
      `row:${ID}.cells`,
      `row:${ID}.cells.${ID}`,
      `column:${ID}.allowMultiple`,
      `cells.${ID}`,
      `columns.${ID}.kind`,
    ]) {
      expect(fields.has(path), path).toBe(true);
    }
    for (const path of [
      'name',
      'code',
      'row:abc',
      `row:${ID}.secret`,
      `column:${ID}.x.y`,
      `other:${ID}`,
      `rows.${ID}`,
    ]) {
      expect(fields.has(path), path).toBe(false);
    }
  });

  it('visibleValue 对 row / column 整对象保留合规子键，去掉其余', () => {
    const fields = approvalContentFields(viewable('nodes'))!;
    const value = { [`row:${ID}`]: { seq: 1, cells: { [ID]: [ID] }, extra: 'x' }, 'row:bad': { seq: 1 } };
    expect(visibleValue(value, fields)).toEqual({ [`row:${ID}`]: { seq: 1, cells: { [ID]: [ID] } } });
  });
});
