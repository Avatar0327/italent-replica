import { describe, expect, it } from 'vitest';
import { OFFER_APPROVAL_STATUSES, OFFER_STATUSES, OFFER_SYNC_STATUSES, OFFER_TYPES } from '@italent/domain';
import { displayValue } from '../../apps/web/src/offers/model.js';
import { readEnums } from '../../apps/web/src/offers/messages.js';

const dictionaries = [
  {
    field: 'approvalStatus',
    label: '审批状态',
    values: OFFER_APPROVAL_STATUSES,
    labels: ['未发起审批', '审批中', '审批通过', '审批不通过'],
  },
  {
    field: 'status',
    label: 'offer状态',
    values: OFFER_STATUSES,
    labels: ['待发offer', '已发offer', '已接受offer', '已拒绝offer', '已入职offer', '失效offer'],
  },
  { field: 'offerType', label: 'Offer类型', values: OFFER_TYPES, labels: ['社招', '校招', '实习'] },
  { field: 'syncStatus', label: '同步状态', values: OFFER_SYNC_STATUSES, labels: ['成功', '失败'] },
  { field: 'hasProbation', label: '是否有试用期', values: [true, false], labels: ['是', '否'] },
];

describe('AC-FE-F298 Offer 枚举展示与后端契约一致', () => {
  it.each(dictionaries)('$field 字典无缺项或多余编码，所有取值显示中文', ({ field, label, values, labels }) => {
    expect(Object.keys(readEnums[field]!).sort()).toEqual(values.map(String).sort());
    expect(values.map((value) => displayValue({ id: 'synthetic-offer', [field]: value }, label))).toEqual(labels);
  });
  it.each(dictionaries)('$field 未知值只显示空占位，不显示原始编码', ({ field, label }) => {
    for (const value of ['future_unknown_status', 'toString']) {
      expect(displayValue({ id: 'synthetic-offer', [field]: value }, label)).toBe('--');
    }
  });
  it('普通文字字段不受枚举兜底影响', () => {
    expect(displayValue({ id: 'synthetic-offer', name: '合成候选人' }, '录用人员')).toBe('合成候选人');
  });
});
