/**
 * BE-R2d4c 新增实习生一体写入（B38 / A48；DEC-662 选 A；补证 R2f1「新增实习生时合同协议终止日期必填」；31 IN-R1）：
 * POST /interns 一个请求、一个命令 ID、一个事务内完成 建档 + 绑定用户（新增）/ 沿用候选人员（重聘）+ 实习任职 + 合同协议，
 * 任一步失败整体回滚。入职日 ≤ 今天写正式合同（进“实习中”），入职日在未来写待入职合同（保守：只在待入职列表，响应
 * view = pendingEntry，原站未来入职实习生的视图归属未取证，PR“未验证”）。同键重放返回首个结果，不重复建档。
 */
import { CONTRACT_OBJECT } from '@italent/domain';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createWorld, type CreateWorld } from './AC-IN-BE-R2d4c-support.js';
import { scopedRequest } from './AC-IN-BE6a-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const world = (label: string) => createWorld(testDb().db, `r2d4c-${label}-${uniqueSuffix()}`);

const formal = (c: CreateWorld, extra: Record<string, unknown> = {}) => ({
  typeId: c.typeId,
  companyId: c.companyId,
  termType: 'fixed',
  endDate: '2027-09-30',
  ...extra,
});

describe('AC-IN-R2d4c-01 新增实习生（入职日今天）：人员 + 任职 + 正式合同 同事务', () => {
  it('201：建档并绑定用户、实习任职、正式合同起始日 = 入职日，进“实习中”，回执含 employeeId / businessId / 合同摘要 / view', async () => {
    const c = await world('today');
    const body = c.hireBody({ contract: formal(c) });
    const receipt = await c.createOk(body);
    expect(receipt).toMatchObject({
      kind: 'hire',
      view: 'interning',
      contract: { stage: 'formal', startDate: '2026-10-01', endDate: '2027-09-30', companyId: c.companyId },
    });
    expect(receipt.contract.id).toEqual(expect.any(String));
    expect(await c.employeesByCode(body.code as string)).toMatchObject([{ id: receipt.employeeId }]);
    expect(await c.contracts()).toMatchObject([
      { id: receipt.contract.id, employeeId: receipt.employeeId, effectiveDate: '2026-10-01', endDate: '2027-09-30' },
    ]);
    expect(await c.viewIds('interning')).toContain(receipt.employeeId);
    const [record] = await c.w.session.records(receipt.employeeId);
    expect(record).toMatchObject({ id: receipt.businessId, kind: 'hire' });
    expect(await c.w.view('interning')).toMatchObject([
      { employeeId: receipt.employeeId, employType: 'intern', availableActions: ['regularize', 'terminate'] },
    ]);
  });

  it('入职日早于今天：同样写正式合同，起始日 = 入职日', async () => {
    const c = await world('past');
    const receipt = await c.createOk(c.hireBody({ effectiveDate: '2026-09-15', contract: formal(c) }));
    expect(receipt).toMatchObject({ view: 'interning', contract: { stage: 'formal', startDate: '2026-09-15' } });
    expect(await c.contracts()).toMatchObject([{ employeeId: receipt.employeeId, effectiveDate: '2026-09-15' }]);
  });
});

describe('AC-IN-R2d4c-02 新增实习生（入职日在未来）：待入职合同终止日已存，视图保守归待入职', () => {
  it('201：待入职合同带终止日与合同公司，不生成正式合同，四个实习视图都没有，view = pendingEntry', async () => {
    const c = await world('future');
    const receipt = await c.createOk(
      c.hireBody({ effectiveDate: '2026-10-20', contract: { companyId: c.companyId, endDate: '2027-10-19' } }),
    );
    expect(receipt).toMatchObject({
      view: 'pendingEntry',
      contract: { stage: 'pending', id: null, startDate: '2026-10-20', endDate: '2027-10-19', companyId: c.companyId },
    });
    expect(await c.pendingContract(receipt.businessId)).toMatchObject({
      startDate: '2026-10-20',
      endDate: '2027-10-19',
      companyId: c.companyId,
    });
    expect(await c.contracts()).toEqual([]);
    for (const view of ['interning', 'converting', 'converted', 'left']) {
      expect(await c.viewIds(view)).not.toContain(receipt.employeeId);
    }
    const response = await c.w.session.request('GET', '/pending-entries?view=all');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(receipt.employeeId);
  });

  it.each([
    ['合同类型等正式合同字段在待入职阶段不落库，不静默丢弃', { typeId: '00000000-0000-4000-8000-000000000001' }],
    ['合同公司不存在', { companyId: '00000000-0000-4000-8000-000000000002' }],
  ])('400 整体不写入：%s', async (_name, patch) => {
    const c = await world('future-bad');
    const body = c.hireBody({
      effectiveDate: '2026-10-20',
      contract: { companyId: c.companyId, endDate: '2027-10-19', ...patch },
    });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
  });
});

describe('AC-IN-R2d4c-03 合同终止日必填且不早于起始日：400 且无任何写入', () => {
  it.each([
    ['今天入职缺终止日', '2026-10-01', { endDate: undefined }],
    ['今天入职终止日早于起始日', '2026-10-01', { endDate: '2026-09-30' }],
    ['未来入职缺终止日', '2026-10-20', { endDate: undefined }],
    ['未来入职终止日早于起始日', '2026-10-20', { endDate: '2026-10-19' }],
  ])('%s', async (_name, effectiveDate, patch) => {
    const c = await world('dates');
    const body = c.hireBody({ effectiveDate, contract: formal(c, patch) });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBe(400);
    const error = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
    expect(error.error.code).toBe('VALIDATION_FAILED');
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
    expect(await c.contracts()).toEqual([]);
  });

  it('不带 contract 整体 400（实习生合同必填），不退化为只建档', async () => {
    const c = await world('no-contract');
    const body = c.hireBody();
    expect((await c.create(body)).status).toBe(400);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
  });
});

describe('AC-IN-R2d4c-04 合同写入失败：人员 / 任职 / 合同全部回滚', () => {
  it('合同类型不存在（合同模块在建档与任职之后拒绝）→ 无人员、无任职、无合同，改正后同工号可重提', async () => {
    const c = await world('rollback');
    const body = c.hireBody({ contract: formal(c, { typeId: '00000000-0000-4000-8000-000000000003' }) });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(400);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
    expect(await c.contracts()).toEqual([]);
    expect(await c.viewIds('interning')).toEqual([]);
    const fixed = await c.createOk({ ...body, contract: formal(c) }, { key: crypto.randomUUID() });
    expect(await c.employeesByCode(body.code as string)).toMatchObject([{ id: fixed.employeeId }]);
  });

  it('缺登录邮箱（入职必填，DEC-140）→ 400 且不留下人员', async () => {
    const c = await world('no-email');
    const { loginEmail: _omit, ...body } = c.hireBody({ contract: formal(c) });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
  });

  it('工号已存在 → 409，原人员与合同不受影响', async () => {
    const c = await world('dup-code');
    const first = c.hireBody({ contract: formal(c) });
    await c.createOk(first);
    const again = { ...c.hireBody({ contract: formal(c) }), code: first.code };
    expect((await c.create(again)).status).toBe(409);
    expect(await c.contracts()).toHaveLength(1);
  });
});

describe('AC-IN-R2d4c-05 重聘：沿用候选人员，不新建人员', () => {
  it('kind = rehire + 候选 employeeId → 同一人员追加重聘任职与合同，人员总数不变', async () => {
    const c = await world('rehire');
    const left = await c.leftIntern('离职合成实习生');
    const { revision } = await c.w.session.getEmployee(left.employee.id);
    const receipt = await c.createOk(
      {
        kind: 'rehire',
        employeeId: left.employee.id,
        effectiveDate: '2026-10-01',
        fields: { departmentId: c.w.org.id },
        contract: formal(c),
      },
      { ifMatch: revision },
    );
    expect(receipt).toMatchObject({ employeeId: left.employee.id, kind: 'rehire', view: 'interning' });
    const records = await c.w.session.records(left.employee.id);
    expect(records.find((record) => record.id === receipt.businessId)).toMatchObject({ kind: 'rehire' });
    expect(await c.w.view('interning')).toMatchObject([{ employeeId: left.employee.id, employType: 'intern' }]);
    expect(await c.contracts()).toMatchObject([{ employeeId: left.employee.id, effectiveDate: '2026-10-01' }]);
    expect(await c.viewIds('interning')).toContain(left.employee.id);
  });

  it('候选人员仍在职（不是已离职 / 退休）→ 409，不写合同', async () => {
    const c = await world('rehire-active');
    const active = await c.w.hire('在职合成实习生', 'intern');
    const { revision } = await c.w.session.getEmployee(active.employee.id);
    const response = await c.create(
      {
        kind: 'rehire',
        employeeId: active.employee.id,
        effectiveDate: '2026-10-01',
        fields: { departmentId: c.w.org.id },
        contract: formal(c),
      },
      { ifMatch: revision },
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await c.contracts()).toEqual([]);
  });

  it.each([
    ['新增带 employeeId', { employeeId: '00000000-0000-4000-8000-000000000004' }],
    ['新增缺工号', { code: undefined }],
    ['新增缺姓名', { name: undefined }],
    ['任职类型不是实习', { fields: { departmentId: 'x', employType: 'internal' } }],
  ])('请求形状：%s → 400', async (_name, patch) => {
    const c = await world('shape');
    const body = c.hireBody({ contract: formal(c), ...patch });
    expect((await c.create(body)).status).toBe(400);
  });

  it('重聘带 code / name、缺 employeeId → 400', async () => {
    const c = await world('rehire-shape');
    const base = { kind: 'rehire', effectiveDate: '2026-10-01', fields: {}, contract: formal(c) };
    expect((await c.create({ ...base, code: 'X1', name: 'Y' }, { ifMatch: 1 })).status).toBe(400);
    expect((await c.create(base, { ifMatch: 1 })).status).toBe(400);
  });
});

describe('AC-IN-R2d4c-06 同一命令 ID 重放：返回首个结果，不重复建档', () => {
  it('同键同内容 → 同一回执、一个人员、一份合同；同键异内容 → 409 IDEMPOTENCY_CONFLICT', async () => {
    const c = await world('replay');
    const body = c.hireBody({ contract: formal(c) });
    const key = crypto.randomUUID();
    const first = await c.createOk(body, { key });
    const second = await c.createOk(body, { key });
    expect(second).toEqual(first);
    expect(await c.employeesByCode(body.code as string)).toHaveLength(1);
    expect(await c.contracts()).toHaveLength(1);
    const changed = await c.create({ ...body, name: '改名' }, { key });
    expect(changed.status).toBe(409);
    expect(await c.contracts()).toHaveLength(1);
  });

  it('首次失败后同键重放：仍是同一个失败，不留半截数据', async () => {
    const c = await world('replay-fail');
    const body = c.hireBody({ contract: formal(c, { endDate: undefined }) });
    const key = crypto.randomUUID();
    expect((await c.create(body, { key })).status).toBe(400);
    expect((await c.create(body, { key })).status).toBe(400);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
  });
});

describe('AC-IN-R2d4c-07 权限：同 POST /employees（Employee.Create + 看全部，DEC-121）与任职 / 合同写入权', () => {
  const deny =
    (match: (request: Parameters<Authorizer>[0]) => boolean): Authorizer =>
    (request) =>
      !match(request);

  it.each([
    ['无人员对象新增权', deny((r) => r.action === 'object.create' && r.resource === 'TenantBase.Employee')],
    ['无任职对象新增权', deny((r) => r.action === 'object.create' && r.resource === 'TenantBase.EmploymentRecord')],
    ['无合同对象新增权', deny((r) => r.action === 'object.create' && r.resource === CONTRACT_OBJECT)],
  ])('403：%s，无人员 / 任职 / 合同写入', async (_name, authorize) => {
    const c = await world('denied');
    const body = c.hireBody({ contract: formal(c) });
    const response = await c.createAs(authorize, body);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
    expect(await c.contracts()).toEqual([]);
  });

  it('非“看全部”范围 → 404（新员工尚无任职鉴权字段，同 POST /employees），无写入', async () => {
    const c = await world('scope');
    const body = c.hireBody({ contract: formal(c) });
    const request = scopedRequest(c.w, [c.w.org.id], ['code', 'name', 'departmentId', 'employType']);
    const response = await request('POST', '/interns', { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(404);
    // 区别于“接口不存在”：是范围拒绝（同 POST /employees 的 404「任职数据不存在」）
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe('任职数据不存在');
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
    expect(await c.contracts()).toEqual([]);
  });

  it('对照：同一组字段可见、范围为“看全部” → 201', async () => {
    const c = await world('scope-all');
    const body = c.hireBody({ contract: formal(c) });
    const request = scopedRequest(c.w, [], ['code', 'name', 'departmentId', 'employType'], true);
    const response = await request('POST', '/interns', { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
  });
});

const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

describe('AC-IN-R2d4c-08 第 2 轮 P2-1：已占用的重聘候选不得重复创建待入职', () => {
  it.each([
    ['先晚后早', '2026-10-20', '2026-10-10'],
    ['先早后晚', '2026-10-10', '2026-10-20'],
  ])('%s：第二次 409 REHIRE_REQUIRES_LEAVE，无任何写入', async (_name, first, second) => {
    const c = await world('occupied');
    const left = await c.leftIntern('占用合成实习生');
    const contract = { companyId: c.companyId, endDate: '2027-12-31' };
    const base = (effectiveDate: string) => c.rehireBody(left.employee.id, { effectiveDate, contract });
    await c.createOk(base(first), { ifMatch: (await c.w.session.getEmployee(left.employee.id)).revision });
    const before = (await c.w.session.records(left.employee.id)).length;
    const revision = (await c.w.session.getEmployee(left.employee.id)).revision;
    const response = await c.create(base(second), { ifMatch: revision });
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await reasonOf(response)).toBe('REHIRE_REQUIRES_LEAVE');
    expect(await c.w.session.records(left.employee.id)).toHaveLength(before);
  });
});

describe('AC-IN-R2d4c-09 第 2 轮 P2-2：回执取自实际保存的合同，矛盾输入入口拒绝', () => {
  it('请求、合同读回、回执三者的终止日一致', async () => {
    const c = await world('end-consistent');
    const receipt = await c.createOk(c.hireBody({ contract: formal(c, { endDate: '2027-06-30' }) }));
    expect(receipt.contract.endDate).toBe('2027-06-30');
    expect(await c.contracts()).toMatchObject([{ id: receipt.contract.id, endDate: '2027-06-30' }]);
  });

  it('termType = indefinite 却带终止日 → 400 INTERN_CONTRACT_TERM_CONFLICT，无写入', async () => {
    const c = await world('end-indefinite');
    const body = c.hireBody({ contract: formal(c, { termType: 'indefinite' }) });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await reasonOf(response)).toBe('INTERN_CONTRACT_TERM_CONFLICT');
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
    expect(await c.contracts()).toEqual([]);
  });

  it('累计第 3 次签订且类型为无固定期限（合同服务会把终止日置空）→ 拒绝并整体回滚，不回填请求值', async () => {
    const c = await world('end-type-indefinite');
    const left = await c.leftIntern('累计签订合成实习生');
    await c.priorContract(left.employee.id, c.typeId, c.companyId, 2024);
    await c.priorContract(left.employee.id, c.typeId, c.companyId, 2025);
    await c.markIndefinite(c.typeId);
    const { revision } = await c.w.session.getEmployee(left.employee.id);
    const contract = { typeId: c.typeId, companyId: c.companyId, endDate: '2027-09-30' };
    const response = await c.create(c.rehireBody(left.employee.id, { contract }), { ifMatch: revision });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await reasonOf(response)).toBe('INTERN_CONTRACT_TERM_CONFLICT');
    expect(await c.contracts()).toHaveLength(2);
    expect(await c.w.session.records(left.employee.id)).toHaveLength(2);
  });
});

describe('AC-IN-R2d4c-10 第 2 轮 P2-3：首次响应丢失后可经命令结果回查恢复到业务详情（F-120）', () => {
  it('GET /commands/:id/result → succeeded，businessId 指向新建业务，详情可读', async () => {
    const c = await world('recover');
    const key = crypto.randomUUID();
    const receipt = await c.createOk(c.hireBody({ contract: formal(c) }), { key });
    const result = await c.commandResult(key);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'succeeded', businessId: receipt.businessId, businessType: 'hire' });
    const detail = await c.w.session.request('GET', `/businesses/${receipt.businessId}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
  });

  it('待入职（未来入职）同样可回查', async () => {
    const c = await world('recover-pending');
    const key = crypto.randomUUID();
    const body = c.hireBody({
      effectiveDate: '2026-10-20',
      contract: { companyId: c.companyId, endDate: '2027-10-19' },
    });
    const receipt = await c.createOk(body, { key });
    expect((await c.commandResult(key)).body).toMatchObject({ status: 'succeeded', businessId: receipt.businessId });
  });
});

describe('AC-IN-R2d4c-11 第 2 轮 P2-4：匹配器返回的退休候选可完成重聘', () => {
  it('rehire-matches 命中退休 → 一体保存成功，实际任职类型为退休后重聘，进“实习中”', async () => {
    const c = await world('retired');
    const retired = await c.retiredIntern('退休合成实习生');
    const idNumber = `SYN${uniqueSuffix()}`;
    await c.w.identify(retired.employee.id, 'id_card', idNumber);
    const matched = await c.w.match({ idType: 'id_card', idNumber });
    expect(((await matched.json()) as { candidate: { endKind: string } }).candidate.endKind).toBe('retirement');
    const { revision } = await c.w.session.getEmployee(retired.employee.id);
    const receipt = await c.createOk(c.rehireBody(retired.employee.id, { contract: formal(c) }), { ifMatch: revision });
    expect(receipt).toMatchObject({ employeeId: retired.employee.id, kind: 'retire_rehire', view: 'interning' });
    expect(await c.viewIds('interning')).toContain(retired.employee.id);
  });

  it('离职候选路径不回退：仍是 rehire', async () => {
    const c = await world('left-still-rehire');
    const left = await c.leftIntern('离职合成实习生');
    const { revision } = await c.w.session.getEmployee(left.employee.id);
    const receipt = await c.createOk(c.rehireBody(left.employee.id, { contract: formal(c) }), { ifMatch: revision });
    expect(receipt.kind).toBe('rehire');
  });
});

describe('AC-IN-R2d4c-12 第 2 轮 P2-5：终止日必须晚于起始日（与正式合同服务一致），相等边界入口拒绝', () => {
  it.each([
    ['今天入职、同日终止', '2026-10-01', '2026-10-01'],
    ['未来入职、同日终止', '2026-10-20', '2026-10-20'],
  ])('%s → 400 INTERN_CONTRACT_DATE_INVALID，写入前拒绝', async (_name, effectiveDate, endDate) => {
    const c = await world('end-equal');
    const body = c.hireBody({ effectiveDate, contract: formal(c, { endDate }) });
    const response = await c.create(body);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await reasonOf(response)).toBe('INTERN_CONTRACT_DATE_INVALID');
    expect(await c.employeesByCode(body.code as string)).toEqual([]);
  });

  it.each([
    ['今天入职、次日终止', '2026-10-01', '2026-10-02', 'interning'],
    ['未来入职、次日终止', '2026-10-20', '2026-10-21', 'pendingEntry'],
  ])('%s → 成功', async (_name, effectiveDate, endDate, view) => {
    const c = await world('end-plus-one');
    const contract = effectiveDate === '2026-10-01' ? formal(c, { endDate }) : { companyId: c.companyId, endDate };
    const receipt = await c.createOk(c.hireBody({ effectiveDate, contract }));
    expect(receipt).toMatchObject({ view, contract: { endDate } });
  });
});
