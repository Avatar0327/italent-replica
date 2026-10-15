/** DEC-456：合成数据，不作为真实业务命令的输入。没有 API、持久化或状态写入。 */
export type OfferState = 'pending' | 'sent' | 'accepted' | 'rejected' | 'onboarded' | 'invalid';
export type Approval = 'unsubmitted' | 'approving' | 'approved';
export interface OfferExample {
  id: string;
  name: string;
  email: string;
  kind: '社招' | '实习';
  state: OfferState;
  approval: Approval;
  department: string;
  post: string;
  job: string;
  date: string;
  overCapacity?: boolean;
  refusal?: { date: string; reason: string; remark: string };
  acceptedDate?: string;
  invalidAt?: string;
}
export function offerExamples(): OfferExample[] {
  const row = (id: string, name: string, state: OfferState, extra: Partial<OfferExample> = {}): OfferExample => ({
    id,
    name,
    state,
    email: `${id}@example.invalid`,
    kind: '社招',
    approval: 'unsubmitted',
    department: '合成研发部',
    post: '合成工程师',
    job: '合成研发职务',
    date: '2026-11-01',
    ...extra,
  });
  return [
    row('demo-offer-01', '合成社招甲', 'pending'),
    row('demo-offer-02', '合成实习乙', 'pending', { kind: '实习' }),
    row('demo-offer-03', '合成超编丙', 'sent', { overCapacity: true }),
    row('demo-offer-04', '合成接受丁', 'accepted', { acceptedDate: '2026-09-10' }),
    row('demo-offer-05', '合成拒绝戊', 'rejected', {
      refusal: { date: '2026-09-08', reason: '个人原因', remark: '合成拒绝备注' },
    }),
    row('demo-offer-06', '合成退回己', 'pending', {
      refusal: { date: '2026-09-08', reason: '个人原因', remark: '合成历史拒绝备注' },
    }),
    row('demo-offer-07', '合成入职庚', 'onboarded'),
    row('demo-offer-08', '合成失效辛', 'invalid', { invalidAt: '2026-09-12 10:00:00' }),
    row('demo-offer-09', '合成审批壬', 'pending', { approval: 'approving' }),
    row('demo-offer-10', '合成通过癸', 'pending', { approval: 'approved' }),
    ...Array.from({ length: 12 }, (_, i) =>
      row(`demo-offer-extra-${i}`, `合成候选人${i + 1}`, 'pending', {
        department: '合成运营部',
        post: '合成运营专员',
        job: '合成运营职务',
      }),
    ),
  ];
}

export const offerSettingExamples: Record<string, string[][]> = {
  reasons: [
    ['薪酬福利不满意', '--', '1', '2000-01-01', '--'],
    ['发展空间受限', '--', '2', '2000-01-01', '--'],
    ['有更好的工作机会', '--', '3', '2000-01-01', '--'],
  ],
  templates: [
    ['合成社招模板', '--', 'DEMO-TPL-01', '合成维护员', '--', '--'],
    ['合成实习模板', '--', 'DEMO-TPL-02', '合成维护员', '--', '--'],
  ],
  preparations: [
    ['入职准备', '1', '其他', '合成办公准备事项', '--', '--'],
    ['入职准备', '2', '分配邮箱', '合成邮箱准备事项', '--', '--'],
  ],
  qr: [['99', '合成默认扫码方案', '--', '合成组织', '启用', '--']],
  email: [
    ['1', '合成邮箱规则一', '合成前缀@example.invalid', '合成组织甲', '--', '--'],
    ['2', '合成邮箱规则二', '合成前缀@example.invalid', '合成组织乙', '--', '--'],
  ],
  integration: [
    ['1', '合成融入方案一', '--', '启用', '--', '--'],
    ['2', '合成融入方案二', '--', '启用', '--', '--'],
  ],
  materials: [
    ['1', '身份信息', '合成身份材料', '入职前', '--', '--', '--', '--'],
    ['2', '教育信息', '合成教育材料', '入职前', '--', '--', '--', '--'],
  ],
};
