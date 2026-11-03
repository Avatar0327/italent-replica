/**
 * F-247 回归（DEC-635，只验证不改动）：延长兼职填更早结束日 → 提交与“四个审批节点同意”各弹同一条可确认警告；
 * 节点顺序 主职HRBP → 主职负责人 → 兼职HRBP → 兼职负责人。后端“缩短后保存”见 AC-PT-08 的 F-247 组与 AC-PT-date-request-http。
 */
import { PRESET_PROCESSES } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { approvalNotice } from '../../apps/web/src/approval/before-approve.js';
import { shorteningNotice } from '../../apps/web/src/part-time/request-confirmation.js';

const preset = PRESET_PROCESSES.find((item) => item.approvalType === 'part_time_extend')!;
const nodeNames = preset.definition.nodes.map((node) => node.name);
const values = { endDate: '2026-10-15', originalEndDate: '2026-10-31' };
const notice = '新结束日期（2026-10-15）早于原结束日期（2026-10-31），兼职并未延长';

describe('AC-FE-F247 延长兼职预置节点顺序（PB-38）', () => {
  it('主职HRBP → 主职负责人 → 兼职HRBP → 兼职负责人', () => {
    expect(nodeNames).toEqual(['主职部门HRBP', '主职部门负责人', '兼职部门HRBP', '兼职部门负责人']);
  });
});

describe('AC-FE-F247 四个审批节点同意前都弹缩短确认', () => {
  it.each(nodeNames.map((name, index) => ({ name, index })))('第 $index 个节点 $name：同意带确认，驳回不带', ({ name }) => {
    const detail = {
      approvalType: 'part_time_extend',
      form: { values },
      tasks: [{ id: 'task', nodeName: name, status: 'pending' }],
    };
    expect(approvalNotice(detail, 'approve')).toBe(notice);
    expect(approvalNotice(detail, 'reject')).toBeUndefined();
  });
  it('提交入口与审批入口口径一致；审批人把日期改成不早于原日期后不再提示', () => {
    expect(shorteningNotice({ ...values, kind: 'extend' })).toBe(notice);
    const detail = { approvalType: 'part_time_extend', form: { values: { ...values, endDate: '2026-11-30' } } };
    expect(approvalNotice(detail, 'approve')).toBeUndefined();
  });
});
