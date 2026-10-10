/**
 * F-079（#172 审查 P3，DEC-374⑦）：审计「变更内容」里这三个字段此前按编码原样显示，补中文名。
 */
import { describe, expect, it } from 'vitest';
import { auditFieldLabel } from '../../packages/domain/src/audit/labels.js';

describe('AC-AUD-F079 审计字段中文标签（DEC-374⑦）', () => {
  it.each([
    ['displayOrder', '显示顺序'],
    ['syncQualification', '同步任职资格子集'],
    ['createdBy', '创建人'],
  ])('%s 显示为「%s」', (field, label) => {
    expect(auditFieldLabel(field)).toBe(label);
  });

  it('未登记的字段仍按编码原样显示，不猜中文名', () => {
    expect(auditFieldLabel('someUnknownField')).toBe('someUnknownField');
  });
});
