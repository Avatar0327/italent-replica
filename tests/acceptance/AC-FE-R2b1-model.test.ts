import { describe, expect, it } from 'vitest';
import { offerExamples } from '../../apps/web/src/demo-stubs/offers.js';
import { filterOffers, inView, rowActions, targets } from '../../apps/web/src/offers/model.js';
import { detailSections, viewSpecs } from '../../apps/web/src/offers/messages.js';
import { settings } from '../../apps/web/src/offers/settings-messages.js';

describe('AC-FE-R2b1 演示视图与原站操作边界', () => {
  const rows = offerExamples();
  it('十视图数量来自样例，三待发子视图互斥，每类都有样例', () => {
    expect(viewSpecs).toHaveLength(10);
    for (const view of viewSpecs) expect(rows.filter((r) => inView(r, view.key)).length).toBeGreaterThan(0);
    const pending = rows.filter((r) => inView(r, 'pending'));
    expect(
      pending.every((r) => ['unsubmitted', 'approving', 'approved'].filter((v) => v === r.approval).length === 1),
    ).toBe(true);
    expect(pending.some((r) => r.kind === '社招')).toBe(true);
    expect(pending.some((r) => r.kind === '实习')).toBe(true);
  });
  it('AC-OF-16 已拒绝仅主按钮转移，失效没有恢复入口，菜单顺序固定', () => {
    const expected = {
      sent: ['编辑并同步', '转移状态', '查看Offer邮件', '失效Offer', '查看Offer'],
      accepted: ['转移状态', '查看Offer邮件', '失效Offer', '发起电子签署', '查看Offer'],
      rejected: ['查看Offer邮件', '查看Offer'],
      onboarded: ['发起电子签署', '查看Offer'],
      invalid: ['查看Offer邮件', '查看Offer'],
    } as const;
    for (const state of ['sent', 'accepted', 'rejected', 'onboarded', 'invalid'] as const)
      expect(
        rowActions(
          rows.find((r) => r.state === state)!,
          state,
        ).menu,
      ).toEqual(expected[state]);
    expect(
      rowActions(
        rows.find((r) => r.state === 'rejected')!,
        'rejected',
      ).primary,
    ).toEqual(['转移状态']);
    expect(
      rowActions(
        rows.find((r) => r.state === 'invalid')!,
        'invalid',
      ).primary,
    ).toEqual(['复制']);
    expect(targets.invalid).toEqual([]);
    expect(targets.accepted).toEqual(['rejected']);
  });
  it('DEC-533 社招待发失效不按审批状态限制，实习待发没有', () => {
    const ordinary = rows[0]!;
    const intern = rows[1]!;
    for (const approval of ['unsubmitted', 'approving', 'approved'] as const) {
      expect(rowActions({ ...ordinary, approval }, 'pending').menu).toContain('失效Offer');
      expect(rowActions({ ...intern, approval }, 'pending').menu).not.toContain('失效Offer');
    }
    expect(rowActions(ordinary, 'pending').menu).toEqual([
      'Offer编辑',
      '发送Offer',
      '转移状态',
      '失效Offer',
      '关联在职实习生',
      '查看Offer',
      '删除',
    ]);
    expect(rowActions(intern, 'pending').menu).not.toContain('失效Offer');
    expect(
      rowActions(
        rows.find((r) => r.approval === 'approving')!,
        'approving',
      ),
    ).toEqual({ primary: ['催办', '转交', '撤销'], menu: ['失效Offer'] });
  });
  it('筛选仅作用于本视图字段，不修改样例或拒绝历史', () => {
    const original = structuredClone(rows);
    expect(filterOffers(rows, 'pending', { 姓名: '合成退回己' }).map((r) => r.id)).toEqual(['demo-offer-06']);
    expect(filterOffers(rows, 'pending', { 姓名: '不存在' })).toEqual([]);
    expect(filterOffers(rows, 'rejected', { 部门: '不在该视图的筛选' })).toHaveLength(1);
    expect(rows).toEqual(original);
    expect(offerExamples()).toEqual(original);
    expect(detailSections.flatMap((s) => s.fields).some((label) => /拒绝|备注/.test(label))).toBe(false);
  });
  it('设置目录顺序按截图，8项Offer加13项入职；列表摘要不含原站私人数据', () => {
    expect(settings.filter((s) => s.group === 'Offer管理').map((s) => s.id)).toEqual([
      'reasons',
      'sync',
      'edit-send',
      'headcount',
      'templates',
      'validity',
      'authorization',
      'matching',
    ]);
    expect(settings.filter((s) => s.group === '入职')).toHaveLength(13);
    expect(settings.filter((s) => s.rows).every((s) => s.rows!.length <= 3)).toBe(true);
    expect(rows.every((r) => r.name.includes('合成') && r.email.endsWith('@example.invalid'))).toBe(true);
  });
});
