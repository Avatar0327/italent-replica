/**
 * AC-F476-07（P5 部分：合同 / 员工子集 / 兼职）：冻结后撤字段权，值、原值、changedFields、键名在已办人的
 * 申请详情与审批中心详情里同时消失；办理后新增的权限不超过办理时的披露上限（三重交集，DEC-801）。
 * 「留给 P2 / P6」：附件权、导出、错误信封；「未覆盖」：外部合同（foreign）范围，P5 内没有 foreign 字段的生产方
 * （唯一生产方是 P4 任职调动快照），改由 foreignVisibility 的单元断言守住，见本文件末尾。
 * 反向自证：frozen 原样返回或只裁顶层，都会让「撤权后仍含值」断言失败。
 */
import { useTestDb } from '@italent/testkit';
import { formFieldsWithForeign, viewableWithForeign } from '../../apps/api/src/modules/approval/foreign-fields.js';
import { CONTRACT_OBJECT, MODULE_OBJECTS, SUBSETS, type SubsetKind } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import { contractScene, latestInstance, personnelScene, resubmit, rights, textFieldsOf } from './AC-F476-p5-support.js';

const testDb = useTestDb();
const text = (...bodies: unknown[]) => JSON.stringify(bodies);

describe('AC-F476-07 合同：撤字段权 / 新增权限不超上限', () => {
  const SALARY = '98765.43';
  const BEFORE = '11111.11';
  const PROBATION = '55555.55';

  async function handled(label: string, hideAtHandling: readonly string[] = []) {
    const s = await contractScene(testDb().db, label);
    const { w, n1, n2 } = s;
    const r = rights(w);
    const target = await s.direct({ regularSalary: BEFORE, probationSalary: PROBATION });
    const request = await s.apply('change', { regularSalary: SALARY, probationSalary: PROBATION }, target);
    const instance = await latestInstance(w, 'contract', request.id);
    await r.decide(instance.id, n1, 'approve');
    r.hide(CONTRACT_OBJECT, ...hideAtHandling);
    await r.decide(instance.id, n2, 'reject');
    r.show(CONTRACT_OBJECT, ...hideAtHandling);
    await resubmit(w, instance.id, w.hr.id, { regularSalary: '77777.77', probationSalary: '66666.66' });
    const read = async (user: string) => ({
      route: await r.get(user, s.requestPath(request.id)),
      centre: await r.detail(user, instance.id),
    });
    return { ...s, r, request, instance, read };
  }

  it('撤销字段权后，已办人的申请详情与审批中心详情都不再含该字段的值 / 原值 / 键名', async () => {
    const s = await handled('f476-07p5-contract-revoke');
    const baseline = await s.read(s.n2.userId);
    expect(baseline.route.body.contentView?.mode).toBe('frozen');
    expect(text(baseline.route.body, baseline.centre.body)).toContain(SALARY);

    s.r.hide(CONTRACT_OBJECT, 'regularSalary');
    const { route, centre } = await s.read(s.n2.userId);
    expect(route.status).toBe(200);
    const body = text(route.body, centre.body);
    for (const secret of [SALARY, BEFORE, '77777.77']) expect(body).not.toContain(secret);
    expect(Object.keys((route.body.submittedFields ?? {}) as object)).not.toContain('regularSalary');
    const form = (centre.body as { form?: { values?: object; originals?: object } }).form;
    expect(Object.keys(form?.values ?? {})).not.toContain('regularSalary');
    expect(Object.keys(form?.originals ?? {})).not.toContain('regularSalary');
    // 未撤权的字段仍照常披露：撤权是字段级的，不是整页拒绝
    expect(body).toContain(PROBATION);
  });

  it('办理时看不到的字段，事后补授权也不补露；现读视角（发起人 / 待办人）不受上限约束', async () => {
    const s = await handled('f476-07p5-contract-ceiling', ['probationSalary']);
    const frozen = await s.read(s.n2.userId);
    expect(frozen.route.body.contentView?.mode).toBe('frozen');
    expect(text(frozen.route.body, frozen.centre.body)).not.toContain(PROBATION);
    const live = await s.read(s.w.hr.id);
    expect(live.route.body.contentView?.mode).toBe('live');
    expect(text(live.route.body)).toContain('66666.66');
  });
});

describe('AC-F476-07 员工子集：撤字段权 / 新增权限不超上限', () => {
  const subset: SubsetKind = 'education';
  const [field, kept] = textFieldsOf(subset) as [string, string];
  const objectCode = SUBSETS[subset].objectCode;

  async function handled(label: string, hideAtHandling = false) {
    const s = await personnelScene(testDb().db, label);
    const { w, n1, n2 } = s;
    const r = rights(w);
    const target = await s.record(subset, { [field]: 'ZZ_原值', [kept]: 'ZZ_保持' });
    const request = await s.apply(subset, { [field]: 'ZZ_办理时', [kept]: 'ZZ_保持' }, target);
    const instance = await latestInstance(w, 'personnel_change', request.id);
    await r.decide(instance.id, n1, 'approve');
    if (hideAtHandling) r.hide(objectCode, kept);
    await r.decide(instance.id, n2, 'reject');
    if (hideAtHandling) r.show(objectCode, kept);
    await resubmit(w, instance.id, s.subject.userId, { [field]: 'ZZ_改后', [kept]: 'ZZ_保持' });
    const read = async (user: string) => ({
      route: await r.get(user, s.requestPath(request.id)),
      centre: await r.detail(user, instance.id),
    });
    return { ...s, r, read };
  }

  it('撤销子集字段权后，已办人读到的申请详情与审批中心详情都不含办理时值和原值', async () => {
    const s = await handled('f476-07p5-personnel-revoke');
    const baseline = await s.read(s.n2.userId);
    expect(baseline.route.body.contentView?.mode).toBe('frozen');
    expect(text(baseline.route.body, baseline.centre.body)).toContain('ZZ_办理时');

    s.r.hide(objectCode, field);
    const { route, centre } = await s.read(s.n2.userId);
    expect(route.status).toBe(200);
    const body = text(route.body, centre.body);
    for (const secret of ['ZZ_办理时', 'ZZ_原值', 'ZZ_改后']) expect(body).not.toContain(secret);
    for (const container of ['currentValues', 'originals', 'values'] as const)
      expect(Object.keys((route.body[container] ?? {}) as object)).not.toContain(field);
  });

  it('办理时不可见的（未被改动的）子集字段，事后补授权也不补露', async () => {
    const s = await handled('f476-07p5-personnel-ceiling', true);
    const frozen = await s.read(s.n2.userId);
    expect(frozen.route.body.contentView?.mode).toBe('frozen');
    const body = text(frozen.route.body, frozen.centre.body);
    expect(body).not.toContain('ZZ_保持');
    expect(body).toContain('ZZ_办理时');
    const live = await s.read(s.subject.userId);
    expect(live.route.body.contentView?.mode).toBe('live');
    expect(text(live.route.body)).toContain('ZZ_保持');
  });
});

describe('AC-F476-07 兼职：撤字段权 / 新增权限不超上限', () => {
  const PT = '/api/tenant/employment/part-time-requests';
  const OBJECT = MODULE_OBJECTS.employmentRecord.code;

  async function handled(label: string, hideAtHandling = false) {
    const w = await requestWorld(testDb().db, label, { editMode: 'with_approve' });
    const r = rights(w);
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    const [first, second] = w.order.extend;
    if (hideAtHandling) r.hide(OBJECT, 'originalEndDate');
    const view = await w.instance(created.id);
    await r.decide(view.id, first!, 'approve');
    if (hideAtHandling) r.show(OBJECT, 'originalEndDate');
    await r.decide(view.id, second!, 'approve', { endDate: '2027-01-31' });
    const read = async (user: string) => ({
      route: await r.get(user, `${PT}/${created.id}`),
      centre: await r.detail(user, view.id),
    });
    return { w, r, first: first!, second: second!, read };
  }

  it('撤销结束日期字段权后，已办人的申请详情与审批中心详情都不含办理时的结束日期 / 原定结束日期', async () => {
    const s = await handled('f476-07p5-pt-revoke');
    const baseline = await s.read(s.first.userId);
    expect(baseline.route.body.contentView?.mode).toBe('frozen');
    expect(text(baseline.route.body, baseline.centre.body)).toContain('2026-12-31');

    s.r.hide(OBJECT, 'endDate', 'originalEndDate');
    const { route, centre } = await s.read(s.first.userId);
    expect(route.status).toBe(200);
    const body = text(route.body, centre.body);
    for (const secret of ['2026-12-31', '2026-10-31', '2027-01-31']) expect(body).not.toContain(secret);
    expect(Object.keys(route.body)).not.toContain('endDate');
    expect(Object.keys(route.body)).not.toContain('originalEndDate');
  });

  it('办理时看不到的原定结束日期，事后补授权也不补露；现读视角读现值', async () => {
    const s = await handled('f476-07p5-pt-ceiling', true);
    const frozen = await s.read(s.first.userId);
    expect(frozen.route.body.contentView?.mode).toBe('frozen');
    expect(Object.keys(frozen.route.body)).not.toContain('originalEndDate');
    expect(text(frozen.route.body)).not.toContain('2026-10-31');
    // 审批中心的「原值」按 endDate 字段权披露（快照 originals 以 endDate 为键），不属于 originalEndDate 字段
    expect(text((frozen.centre.body as { form?: object }).form)).not.toContain('originalEndDate');
    expect(frozen.route.body.endDate).toBe('2026-12-31');
    const live = await s.read(s.w.hr.id);
    expect(live.route.body.contentView?.mode).toBe('live');
    expect([live.route.body.endDate, live.route.body.originalEndDate]).toEqual(['2027-01-31', '2026-10-31']);
  });
});

describe('AC-F476-07 外部合同（foreign）字段：单元守卫（P5 内无生产方，端到端留给 P4）', () => {
  const foreign = {
    code: 'contractChange.endDate',
    container: 'contractChange',
    objectCode: CONTRACT_OBJECT,
    field: 'endDate',
    employeeId: '00000000-0000-4000-8000-000000000001',
    creatorId: null,
  };
  const snapshot = { values: { contractChange: {}, 'contractChange.endDate': '2027-01-01' }, foreignFields: [foreign] };

  it('当前无外部合同授权时嵌套字段被剔除；没有判定入口一律按看不到处理', async () => {
    const own = new Set(['contractChange']);
    expect([...((await viewableWithForeign(snapshot, own, async () => false)) ?? [])]).toEqual(['contractChange']);
    expect([...((await viewableWithForeign(snapshot, own, undefined)) ?? [])]).toEqual(['contractChange']);
    const granted = await viewableWithForeign(snapshot, own, async () => true);
    expect([...(granted ?? [])].sort()).toEqual(['contractChange', 'contractChange.endDate']);
  });

  it('节点表单含区块字段时，嵌套字段随之进入表单（披露交集的第二重）', () => {
    expect(formFieldsWithForeign(['contractChange'], snapshot)).toEqual(['contractChange', 'contractChange.endDate']);
    expect(formFieldsWithForeign(['other'], snapshot)).toEqual(['other']);
  });
});
