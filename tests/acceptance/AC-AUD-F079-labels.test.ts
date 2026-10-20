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
    ['PartDisAgree', '部分不同意'],
    ['AllDisAgree', '全部不同意'],
    // R2-T04 退休审计动作的变更内容
    ['retireType', '退休类型'],
    ['reEmployed', '是否同时返聘'],
    ['expectedRetirementDate', '预计退休日期'],
    ['actualRetirementDate', '实际退休日期'],
    // R2-T04 5b 同时返聘（employment.retirement.rehired）
    ['rehireBusinessId', '返聘业务'],
    ['rehireDate', '返聘日期'],
    ['retirementEffectiveDate', '退休生效日期'],
    ['rehireContractId', '返聘合同'],
    ['initiatorUserId', '发起人'],
    // R2-T04 5d2 意向退休日期申请审计动作 retirement_intention.* 的变更内容
    ['intendedDate', '意向退休日期'],
    ['expectedDateSnapshot', '申请时预计退休日期'],
    ['earliestSnapshot', '申请时最早退休日期'],
    ['latestSnapshot', '申请时最晚退休日期'],
  ])('%s 显示为「%s」', (field, label) => {
    expect(auditFieldLabel(field)).toBe(label);
  });

  it('未登记的字段仍按编码原样显示，不猜中文名', () => {
    expect(auditFieldLabel('someUnknownField')).toBe('someUnknownField');
  });
});
