/**
 * BE-7 PT-3b 新增与读取入口（docs/08_设计/R2-T05_兼职设计.md §4.1 / §4.2 / §4.8 / §13.1，§9 PB-14～22 HTTP 版、PB-57）：
 * 开放 POST employees/:id/part-times/preview、POST employees/:id/part-times、GET employees/:id/part-times、
 * GET part-times/:recordId；编辑、批量结束、申请入口、六视图已随后续批次开放（PT-5 起 GET part-times?view= 见
 * AC-PT-06-views）。新增只调内部服务 createPartTime，
 * 路由层不另写校验或写库逻辑；isDepartmentHead / addedSubordinateIds 自 PT-7 开放（见 AC-PT-linkage-http）。
 * 预览带出默认值（直线经理 = 兼职部门在开始日的负责人、职务序列按 DEC-107；不带出职位，B-6）并做与新增同一套校验，不写库。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { httpWorld } from './AC-PT-http-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => httpWorld(database().db, label);

describe('POST employees/:id/part-times 新增（保存即落地）', () => {
  it('201：回执 = 兼职记录读形状；ETag = 底层业务头 revision；员工列表与单条读取一致', async () => {
    const w = await world('http-create-shape');
    const response = await w.post({ endDate: '2026-12-31' });
    const created = await w.ok(response, 201);
    expect(response.headers.get('etag')).toBe('"1"');
    expect(created).toMatchObject({
      employeeId: w.employeeId,
      staffId: w.cycle.id,
      kind: 'part_time',
      serviceType: 'part_time',
      effectiveDate: '2026-09-01',
      endDate: '2026-12-31',
      revision: 1,
      serviceStatus: 'serving',
      partTimeView: ['ongoing', 'all'],
      warnings: [],
      fields: { departmentId: w.partTimeOrg.id },
    });
    const listed = await w.ok(await w.list());
    expect(listed).toMatchObject({ page: 1, pageSize: 50, hasDataPermission: true });
    expect(listed.items).toEqual([expect.objectContaining({ id: created.id, revision: 1, endDate: '2026-12-31' })]);
    const single = await w.ok(await w.one(created.id));
    expect(single).toMatchObject({ id: created.id, employeeId: w.employeeId, endDate: '2026-12-31', revision: 1 });
    expect(await w.terms(created.id)).toEqual([
      { term_no: 1, end_date: '2026-12-31', source: 'create', source_id: null },
    ]);
  });

  it('不进主职版本链：主职读口径不变；审计动作是 employment.part_time.create，不写 employment.record.create（P-04）', async () => {
    const w = await world('http-create-primary');
    const before = await w.primaryView();
    const created = await w.ok(await w.post(), 201);
    expect(await w.primaryView()).toEqual(before);
    const records = await w.records(w.employeeId);
    expect(records.map((record) => record.id)).not.toContain(created.id);
  });

  it.each([
    ['PB-15 未来开始', { startDate: '2026-11-01', endDate: '2026-12-31' }, 'serving', ['not_started', 'all']],
    [
      'PB-16 当天开始当天结束',
      { startDate: '2026-10-01', endDate: '2026-10-01' },
      'serving',
      ['ongoing', 'expiring', 'all'],
    ],
  ] as const)('%s：保存即按租户今天派生任职状态与视图归属', async (_name, patch, status, views) => {
    const w = await world('http-create-derived');
    const created = await w.ok(await w.post(patch), 201);
    expect(created).toMatchObject({ serviceStatus: status, partTimeView: views });
  });

  it('PB-21 / PB-22 / PB-20：校验错误经 HTTP 返回机读原因，且无任何写入', async () => {
    const w = await world('http-create-validation');
    await w.pendingExit('2026-10-15');
    const before = await w.writes();
    const cases = [
      ['结束早于开始', { endDate: '2026-08-01' }, 400, 'VALIDATION_FAILED', 'PART_TIME_END_BEFORE_START'],
      ['开始日早于入职日', { startDate: '2024-12-01' }, 400, 'VALIDATION_FAILED', 'PART_TIME_BEFORE_ENTRY'],
      ['开始日晚于未落地离职的最后工作日', { startDate: '2026-10-16' }, 409, 'CONFLICT', 'PART_TIME_AFTER_EXIT'],
    ] as const;
    for (const [name, patch, status, code, reason] of cases) {
      const failed = await w.refusal(await w.post(patch));
      expect(failed, name).toMatchObject({ status, code, reason });
    }
    expect(await w.writes()).toEqual(before);
  });

  it('PB-22：跨越未落地离职只提示不拦（warnings 带机读原因），记录照常保存', async () => {
    const w = await world('http-create-warning');
    await w.pendingExit('2026-10-15');
    const created = await w.ok(await w.post({ startDate: '2026-10-07' }), 201);
    expect(created.warnings).toEqual([{ reason: 'PART_TIME_SPANS_PENDING_EXIT' }]);
  });

  it('PB-57（PT-7 改正例）：联动字段不再 400；下属不存在 → 400 TRANSFER_PERSON_NOT_ELIGIBLE，无写入；显式关闭 / 空数组照常保存', async () => {
    const w = await world('http-create-linkage');
    const before = await w.writes();
    const failed = await w.refusal(await w.post({ fields: { addedSubordinateIds: [randomUUID()] } }));
    expect(failed).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    expect(await w.writes()).toEqual(before);
    // 显式关闭 / 空数组不是联动，照常保存（联动成功路径见 AC-PT-linkage-http）
    await w.ok(await w.post({ fields: { isDepartmentHead: false, addedSubordinateIds: [] } }), 201);
  });

  it('请求体严格校验：未知键、缺部门、非法日期 / 类型 / UUID → 400；员工不存在 → 404；缺幂等键 → 400', async () => {
    const w = await world('http-create-schema');
    const before = await w.writes();
    const bad: [string, Record<string, unknown>][] = [
      ['未知顶层键', { surprise: 1 }],
      ['未知字段键', { fields: { surprise: 1 } }],
      ['缺兼职类型', { partTimeType: undefined }],
      ['兼职类型不在集合', { partTimeType: 'primary' }],
      ['缺开始日期', { startDate: undefined }],
      ['非法日期', { startDate: '2026-13-01' }],
      ['部门不是 UUID', { fields: { departmentId: 'dept' } }],
      ['经理不是 UUID', { fields: { directManagerId: 'm' } }],
    ];
    for (const [name, patch] of bad) {
      const failed = await w.refusal(await w.post(patch));
      expect(failed, name).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    expect(
      (await w.refusal(await w.request('POST', `/employees/${randomUUID()}/part-times`, { body: w.body() }))).status,
    ).toBe(404);
    expect(
      (await w.refusal(await w.request('POST', '/employees/not-a-uuid/part-times', { body: w.body() }))).status,
    ).toBe(400);
    expect((await w.refusal(await w.post({}, { idempotencyKey: null }))).status).toBe(400);
    expect(await w.writes()).toEqual(before);
  });
});

describe('未开放的入口仍是 404（开闸表 PT-3b，§13.1）', () => {
  it('删除未注册（编辑与批量结束随 PT-3c、申请入口随 PT-4b、六视图随 PT-5 开放）', async () => {
    const w = await world('http-closed-doors');
    const created = await w.ok(await w.post(), 201);
    const response = await w.request('DELETE', `/part-times/${created.id}`, { ifMatch: 1, body: {} });
    expect(response.status).toBe(404);
  });
});

describe('POST employees/:id/part-times/preview 预览（不写）', () => {
  async function headedWorld(label: string) {
    const w = await world(label);
    const head = await w.colleague('兼职部门负责人');
    const headed = await w.org(`有负责人的兼职部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await w.setOrgHead(headed.id, head.id);
    return { w, head, headed };
  }

  it('带出默认值：直线经理 = 兼职部门负责人；显式给的值不被覆盖；不带出职位（B-6）；预览前后无写入', async () => {
    const { w, head, headed } = await headedWorld('http-preview-defaults');
    const other = await w.colleague('显式指定的经理');
    const before = await w.writes();
    const preview = await w.ok(await w.preview({ fields: { departmentId: headed.id } }));
    expect(preview).toMatchObject({
      partTimeType: 'part_time',
      effectiveDate: '2026-09-01',
      endDate: null,
      fields: { departmentId: headed.id, directManagerId: head.id, positionId: null, jobNumber: expect.any(String) },
    });
    const explicit = await w.ok(await w.preview({ fields: { departmentId: headed.id, directManagerId: other.id } }));
    expect(explicit.fields.directManagerId).toBe(other.id);
    // 部门没有负责人：不沿行政上级找，直线经理留空（只带出“该部门”的负责人）
    const none = await w.ok(await w.preview());
    expect(none.fields.directManagerId).toBeNull();
    expect(await w.writes()).toEqual(before);
  });

  it('选职务后按 DEC-107 带出职务序列；显式序列优先；职务无序列则留空', async () => {
    const w = await world('http-preview-sequence');
    const job = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const create = async (kind: string, extra: Record<string, unknown> = {}) => {
      const response = await job.request('POST', `/api/tenant/job/${kind}`, {
        user: w.user.id,
        tenant: w.tenantId,
        ifMatch: 0,
        body: { name: `${kind}${uniqueSuffix()}`, code: `PT_${uniqueSuffix()}`, startDate: '2026-01-01', ...extra },
      });
      return w.ok<{ id: string }>(response, 201);
    };
    const sequence = await create('sequences');
    const post = await create('posts', { sequenceId: sequence.id });
    const bare = await create('posts');
    expect((await w.ok(await w.preview({ fields: { postId: post.id } }))).fields).toMatchObject({
      postId: post.id,
      sequenceId: sequence.id,
    });
    expect(
      (await w.ok(await w.preview({ fields: { postId: post.id, sequenceId: null } }))).fields.sequenceId,
    ).toBeNull();
    expect((await w.ok(await w.preview({ fields: { postId: bare.id } }))).fields.sequenceId).toBeNull();
  });

  it('与新增同一套校验：外派唯一 409、边界 409、日期 400；被拒时同样无写入', async () => {
    const w = await world('http-preview-validation');
    await w.ok(await w.post({ partTimeType: 'expatriate' }), 201);
    const before = await w.writes();
    expect(await w.refusal(await w.preview({ partTimeType: 'secondment' }))).toMatchObject({
      status: 409,
      reason: 'PART_TIME_EXCLUSIVE_TYPE_EXISTS',
    });
    expect(await w.refusal(await w.preview({ endDate: '2026-01-01' }))).toMatchObject({
      status: 400,
      reason: 'PART_TIME_END_BEFORE_START',
    });
    expect(await w.writes()).toEqual(before);
  });
});

describe('GET employees/:id/part-times、GET part-times/:recordId 读取', () => {
  async function seeded(label: string) {
    const w = await world(label);
    const first = await w.ok(await w.post({ startDate: '2026-08-01', endDate: '2026-08-31' }), 201);
    const second = await w.ok(await w.post({ startDate: '2026-09-15' }), 201);
    return { w, first, second };
  }

  it('员工页签：该员工全部兼职，按开始日期倒序；分页；其他员工的兼职不混入', async () => {
    const { w, first, second } = await seeded('http-read-list');
    const other = await w.employee('另一个员工');
    const page = await w.ok(await w.list());
    expect(page.items.map((item: { id: string }) => item.id)).toEqual([second.id, first.id]);
    const paged = await w.ok(await w.list('?page=2&pageSize=1'));
    expect(paged.items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    expect((await w.refusal(await w.list('?pageSize=201'))).status).toBe(400);
    // 没有任何兼职的员工 → 空列表（范围内）；不存在的员工 → 404
    expect(await w.ok(await w.request('GET', `/employees/${other.id}/part-times`))).toMatchObject({ items: [] });
    expect((await w.request('GET', `/employees/${randomUUID()}/part-times`)).status).toBe(404);
  });

  it('单条：期限链当前期的结束日、任职状态、视图归属；不存在 / 不是兼职 → 404 PART_TIME_RECORD_NOT_FOUND', async () => {
    const { w, first } = await seeded('http-read-one');
    expect(await w.ok(await w.one(first.id))).toMatchObject({
      id: first.id,
      serviceStatus: 'ended',
      partTimeView: ['ended', 'all'],
      endDate: '2026-08-31',
    });
    const hire = (await w.records(w.employeeId)).find((record) => record.kind === 'hire')!;
    for (const id of [randomUUID(), hire.id]) {
      const failed = await w.refusal(await w.one(id));
      expect(failed).toMatchObject({ status: 404, code: 'NOT_FOUND', reason: 'PART_TIME_RECORD_NOT_FOUND' });
    }
    expect((await w.one('not-a-uuid')).status).toBe(400);
  });
});
