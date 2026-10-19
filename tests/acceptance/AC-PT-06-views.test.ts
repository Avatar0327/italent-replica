/**
 * BE-7 PT-5 兼职六视图（docs/08_设计/R2-T05_兼职设计.md §6.1 / §6.2，PB-45 / PB-47，AC-PT-06）：
 * GET part-times?view=ongoing|expiring|not_started|ended|all|in_approval。视图归属与任职状态是两个维度（未开始视图行内任职状态仍是
 * 任职中）；视图之间允许重叠（即将到期 ⊂ 兼职中）；未知 view / 越界 days 一律 400，不静默回退到 all；总数与本页同一份结果，越界页
 * 返回空 items 与同一 total；范围为空 → 空集（fail-closed）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyAction, restricted } from './AC-PT-http-support.js';
import { insertPartTimeRecord } from './AC-PT-support.js';
import { MATRIX, MATRIX_VIEWS, viewsWorld, type MatrixKey } from './AC-PT-views-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => viewsWorld(database().db, label);

describe('PB-45 六视图归属与总数', () => {
  it.each(Object.entries(MATRIX_VIEWS))('%s 视图只含 %j，total 与条数一致', async (name, expected) => {
    const w = await world(`views-${name}`);
    const ids = await w.seedMatrix();
    const body = await w.view(name);
    expect(w.keysOf(ids, w.idsOf(body)).sort()).toEqual([...expected].sort());
    expect(body).toMatchObject({ total: expected.length, page: 1, pageSize: 50, hasDataPermission: true });
  });

  it('视图 × 任职状态两个维度：未开始行任职中、空区间与昨天结束任职结束、结束日 = 今天仍任职中', async () => {
    const w = await world('views-dimensions');
    const ids = await w.seedMatrix();
    const all = await w.view('all');
    const status = (key: MatrixKey) => all.items.find((item) => item.id === ids[key])!.serviceStatus;
    expect(status('startsTomorrow')).toBe('serving');
    expect(status('endsToday')).toBe('serving');
    expect(status('sameDay')).toBe('serving');
    expect(status('open')).toBe('serving');
    expect(status('emptySpan')).toBe('ended');
    expect(status('endedYesterday')).toBe('ended');
    // 行内视图归属与六视图查询同源（同一个纯函数 / SQL 镜像）
    const byRow = (view: string) => all.items.filter((item) => item.partTimeView.includes(view)).length;
    for (const [name, expected] of Object.entries(MATRIX_VIEWS)) expect(byRow(name)).toBe(expected.length);
  });

  it('serviceStatus 三处同源：视图行 = 员工页签 = 详情', async () => {
    const w = await world('views-same-source');
    const ids = await w.seedMatrix();
    const all = await w.view('all');
    const tab = await w.ok(await w.list());
    for (const key of Object.keys(MATRIX) as MatrixKey[]) {
      const row = all.items.find((item) => item.id === ids[key])!;
      const detail = await w.ok(await w.one(ids[key]));
      const tabRow = tab.items.find((item) => item.id === ids[key])!;
      expect([detail.serviceStatus, detail.partTimeView, detail.endDate]).toEqual([
        row.serviceStatus,
        row.partTimeView,
        row.endDate,
      ]);
      expect([tabRow.serviceStatus, tabRow.partTimeView]).toEqual([row.serviceStatus, row.partTimeView]);
    }
  });

  it('days：默认 30（含第 30 天）；days=1 只含今天和明天到期；days=31 并入第 31 天', async () => {
    const w = await world('views-days');
    const ids = await w.seedMatrix();
    const keys = async (days?: number) =>
      w.keysOf(ids, w.idsOf(await w.view('expiring', days === undefined ? '' : `&days=${days}`))).sort();
    expect(await keys()).toEqual(['endsDay30', 'endsToday', 'sameDay']);
    expect(await keys(1)).toEqual(['endsToday', 'sameDay']);
    expect(await keys(31)).toEqual(['endsDay30', 'endsDay31', 'endsToday', 'sameDay']);
    expect(await keys(365)).toEqual(['endsDay30', 'endsDay31', 'endsToday', 'sameDay']);
  });

  it('未知 view / 缺 view / 越界 days / 越界分页 → 400，不回退到 all', async () => {
    const w = await world('views-invalid');
    await w.seedMatrix();
    for (const path of [
      '/part-times',
      '/part-times?view=',
      '/part-times?view=overdue',
      '/part-times?view=ALL',
      '/part-times?view=expiring&days=0',
      '/part-times?view=expiring&days=366',
      '/part-times?view=expiring&days=1.5',
      '/part-times?view=expiring&days=abc',
      '/part-times?view=all&pageSize=201',
      '/part-times?view=all&page=0',
      '/part-times?view=all&serviceType=intern',
      '/part-times?view=all&startFrom=2026-13-01',
      '/part-times?view=all&startFrom=2026-10-02&startTo=2026-10-01',
      '/part-times?view=all&endFrom=2026-10-02&endTo=2026-10-01',
      '/part-times?view=all&departmentId=not-a-uuid',
      '/part-times?view=all&directManagerId=not-a-uuid',
    ]) {
      const response = await w.get(path);
      expect([path, response.status]).toEqual([path, 400]);
    }
  });

  it('分页：总数与本页同一份结果；越界页空 items 与同一 total；默认按开始日期倒序', async () => {
    const w = await world('views-paging');
    const ids = await w.seedMatrix();
    const first = await w.view('ongoing', '&pageSize=4');
    const second = await w.view('ongoing', '&pageSize=4&page=2');
    const beyond = await w.view('ongoing', '&pageSize=4&page=3');
    expect([first.items.length, second.items.length, beyond.items.length]).toEqual([4, 2, 0]);
    expect([first.total, second.total, beyond.total]).toEqual([6, 6, 6]);
    const paged = [...first.items, ...second.items];
    expect(new Set(w.idsOf({ ...first, items: paged })).size).toBe(6);
    const starts = paged.map((item) => item.effectiveDate);
    expect(starts).toEqual([...starts].sort().reverse());
    expect(w.keysOf(ids, w.idsOf({ ...first, items: paged.slice(0, 2) })).sort()).toEqual(['sameDay', 'startsToday']);
  });

  it('行形状：姓名 / 工号 / 主职部门 / 兼职部门 / 任职类型 / 开始结束日期 / 任职状态', async () => {
    const w = await world('views-shape');
    const ids = await w.seedMatrix();
    const body = await w.view('all');
    const row = body.items.find((item) => item.id === ids.endsDay30)!;
    expect(row).toMatchObject({
      employeeId: w.employeeId,
      serviceType: 'part_time',
      effectiveDate: '2026-09-01',
      endDate: '2026-10-31',
      serviceStatus: 'serving',
      partTimeView: ['ongoing', 'expiring', 'all'],
      primaryDepartmentId: w.primaryOrg.id,
      fields: { departmentId: w.partTimeOrg.id },
    });
    expect(row.employee).toEqual({ code: expect.any(String), name: '兼职员工' });
    expect(row.revision).toBe(1);
  });

  it('没有授权的对象查看权 → 403；视图不写任何数据', async () => {
    const w = await world('views-forbidden');
    await w.seedMatrix();
    const before = await w.writes();
    const response = await w.as(restricted({ deny: denyAction('object.view') }))('GET', '/part-times?view=all');
    expect(response.status).toBe(403);
    await w.get('/part-times?view=all');
    expect(await w.writes()).toEqual(before);
  });
});

describe('筛选', () => {
  it('员工关键字（姓名不区分大小写、% 不当通配符）、任职类型、开始 / 结束日期区间', async () => {
    const w = await world('views-filters');
    const ids = await w.seedMatrix();
    const name = `Filter${uniqueSuffix()}`;
    const other = await w.colleague(name);
    const otherId = await withTenant(w.db, w.tenantId, (tx) =>
      insertPartTimeRecord(tx, {
        tenantId: w.tenantId,
        employeeId: other.id,
        departmentId: w.partTimeOrg.id,
        startDate: '2026-09-15',
        endDate: '2026-11-15',
        serviceType: 'secondment',
      }),
    );
    expect(w.idsOf(await w.view('all', `&keyword=${name.toUpperCase()}`))).toEqual([otherId]);
    expect((await w.view('all', '&keyword=%25')).total).toBe(0);
    expect(w.idsOf(await w.view('all', '&serviceType=secondment'))).toEqual([otherId]);
    expect((await w.view('all', '&serviceType=part_time')).total).toBe(9);
    // 开始日期区间 [09-15, 09-30]：只有 other（09-15）
    expect(w.idsOf(await w.view('all', '&startFrom=2026-09-15&startTo=2026-09-30'))).toEqual([otherId]);
    // 结束日期区间 [10-31, 11-15]：endsDay30（10-31）、endsDay31（11-01）、other（11-15）
    const ends = await w.view('all', '&endFrom=2026-10-31&endTo=2026-11-15');
    expect([...w.keysOf(ids, w.idsOf(ends))].sort()).toEqual(['endsDay30', 'endsDay31']);
    expect(ends.total).toBe(3);
    // 无结束日期的记录不会落进任何结束日期区间
    expect(w.keysOf(ids, w.idsOf(await w.view('all', '&endFrom=2000-01-01&endTo=2999-12-31'))).includes('open')).toBe(
      false,
    );
  });

  it('兼职部门含下级（includeChildren=false 只含本级）、直线经理', async () => {
    const w = await world('views-department');
    const parent = await w.org(`上级部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    const child = await w.org(`下级部门${uniqueSuffix()}`, {
      establishedOn: '2024-01-01',
      parents: { admin: { parentId: parent.id } },
    });
    const manager = await w.colleague(`经理${uniqueSuffix()}`);
    const inParent = await w.make({ fields: { departmentId: parent.id } });
    const inChild = await w.make({ fields: { departmentId: child.id, directManagerId: manager.id } });
    await w.make();
    const ofParent = await w.view('all', `&departmentId=${parent.id}`);
    expect(w.idsOf(ofParent).sort()).toEqual([inParent.id, inChild.id].sort());
    expect(ofParent.total).toBe(2);
    expect(w.idsOf(await w.view('all', `&departmentId=${parent.id}&includeChildren=false`))).toEqual([inParent.id]);
    expect(w.idsOf(await w.view('all', `&directManagerId=${manager.id}`))).toEqual([inChild.id]);
  });

  it('筛选用到的字段不可查看 → 403（不让筛选成为探针）；字段都可见则放行', async () => {
    const w = await world('views-filter-fields');
    await w.seedMatrix();
    const all = [
      ...['id', 'employeeId', 'fields', 'effectiveDate', 'endDate', 'serviceType', 'name', 'code'],
      ...['departmentId', 'directManagerId'],
    ];
    const send = (hidden: string, query: string) =>
      w.as(restricted({ fields: all.filter((field) => field !== hidden) }))('GET', `/part-times?view=all${query}`);
    const departmentId = '&departmentId=' + w.partTimeOrg.id;
    const managerId = '&directManagerId=' + w.partTimeOrg.id;
    for (const [hidden, query] of [
      ['serviceType', '&serviceType=part_time'],
      ['effectiveDate', '&startFrom=2026-01-01'],
      ['effectiveDate', '&startTo=2026-12-31'],
      ['endDate', '&endFrom=2026-01-01'],
      ['endDate', '&endTo=2026-12-31'],
      ['name', '&keyword=a'],
      ['code', '&keyword=a'],
      ['departmentId', departmentId],
      ['directManagerId', managerId],
    ] as const) {
      expect([hidden, query, (await send(hidden, query)).status]).toEqual([hidden, query, 403]);
    }
    expect((await send('x', '&serviceType=part_time&startFrom=2026-01-01&endTo=2026-12-31&keyword=a')).status).toBe(
      200,
    );
    expect((await send('serviceType', '')).status).toBe(200);
  });
});

describe('in_approval 审批中的兼职', () => {
  async function seedRequests(w: Awaited<ReturnType<typeof world>>) {
    const ids = await w.seedMatrix();
    const add = await w.seedRequest({ requestType: 'add', startDate: '2026-10-15', endDate: '2026-12-31' });
    const extend = await w.seedRequest({
      requestType: 'extend',
      recordId: ids.open,
      startDate: '2026-09-01',
      endDate: '2026-12-31',
    });
    const end = await w.seedRequest({
      requestType: 'end',
      recordId: ids.endsDay31,
      startDate: '2026-09-01',
      endDate: '2026-10-20',
    });
    // 非审批中：草稿 / 驳回 / 作废 / 已生效 / 已删除都不进视图
    for (const state of ['draft', 'rejected', 'voided', 'deleted'])
      await w.seedRequest({ requestType: 'add', state, startDate: '2026-10-15' });
    await w.seedRequest({ requestType: 'add', state: 'effective', effectiveRecordId: ids.open });
    await w.seedRequest({ requestType: 'extend', recordId: ids.open, state: 'rejected', endDate: '2026-12-01' });
    return { ids, add, extend, end };
  }

  it('只含最新状态 = in_review 的申请，行带申请类型 / 审批状态 / 发起人 / 发起时间', async () => {
    const w = await world('views-approval');
    const { ids, add, extend, end } = await seedRequests(w);
    const body = await w.view('in_approval');
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.id).sort()).toEqual([add, extend, end].sort());
    const row = (id: string) => body.items.find((item) => item.id === id)!;
    expect(row(add)).toMatchObject({
      kind: 'add',
      status: 'in_review',
      initiator: 'hr',
      initiatorUserId: w.user.id,
      employeeId: w.employeeId,
      recordId: null,
      effectiveDate: '2026-10-15',
      endDate: '2026-12-31',
      serviceType: 'part_time',
      fields: { departmentId: w.partTimeOrg.id },
      primaryDepartmentId: w.primaryOrg.id,
    });
    expect(row(add).createdAt).toEqual(expect.any(String));
    expect(row(add).employee).toEqual({ code: expect.any(String), name: '兼职员工' });
    expect(row(extend)).toMatchObject({ kind: 'extend', recordId: ids.open, endDate: '2026-12-31' });
    expect(row(end)).toMatchObject({ kind: 'end', recordId: ids.endsDay31, endDate: '2026-10-20' });
    // 记录视图不含申请；审批中的申请不改变记录视图归属
    expect((await w.view('all')).total).toBe(9);
  });

  it('分页与筛选：申请类型之外按兼职部门 / 任职类型 / 日期区间过滤', async () => {
    const w = await world('views-approval-paging');
    await seedRequests(w);
    const first = await w.view('in_approval', '&pageSize=2');
    const second = await w.view('in_approval', '&pageSize=2&page=2');
    const beyond = await w.view('in_approval', '&pageSize=2&page=3');
    expect([first.items.length, second.items.length, beyond.items.length]).toEqual([2, 1, 0]);
    expect([first.total, second.total, beyond.total]).toEqual([3, 3, 3]);
    expect((await w.view('in_approval', '&serviceType=secondment')).total).toBe(0);
    expect((await w.view('in_approval', `&departmentId=${w.partTimeOrg.id}`)).total).toBe(3);
    expect((await w.view('in_approval', `&departmentId=${w.primaryOrg.id}`)).total).toBe(0);
    expect((await w.view('in_approval', '&endFrom=2026-12-01&endTo=2026-12-31')).total).toBe(2);
  });

  it('范围口径（§6.2）：新增取申请版本的兼职部门，延长 / 结束取目标兼职记录当前部门', async () => {
    const w = await world('views-approval-scope');
    const { ids, add, extend, end } = await seedRequests(w);
    const other = await w.org(`另一部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    // 目标记录当前部门挪到 other：延长申请跟着走
    await w.moveSnapshot(ids.open, other.id);
    const seen = async (...orgIds: string[]) =>
      (await w.view('in_approval', '', w.getAs(restricted({ scope: w.scopeOf(...orgIds) })))).items
        .map((i) => i.id)
        .sort();
    expect(await seen(w.partTimeOrg.id)).toEqual([add, end].sort());
    expect(await seen(other.id)).toEqual([extend]);
    // 员工当前主职部门在范围内：员工名下全部申请可见
    expect(await seen(w.primaryOrg.id)).toEqual([add, extend, end].sort());
  });
});

describe('PB-47 范围为空 → 空集（fail-closed）', () => {
  it.each(['ongoing', 'expiring', 'not_started', 'ended', 'all', 'in_approval'])('%s', async (name) => {
    const w = await world(`views-empty-${name}`);
    await w.seedMatrix();
    await w.seedRequest({ requestType: 'add' });
    const body = await w.view(name, '', w.getAs(restricted({ scope: EMPTY_SCOPE })));
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasDataPermission).toBe(false);
  });

  it('范围外的记录不占页位、不计入 total', async () => {
    const w = await world('views-scope-paging');
    const ids = await w.seedMatrix();
    const other = await w.org(`范围外部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    // 员工主职在 primaryOrg；只管 other 的 HR：员工不在范围，只能看 other 部门的兼职
    await w.moveSnapshot(ids.open, other.id);
    await w.moveSnapshot(ids.endsToday, other.id);
    const send = w.getAs(restricted({ scope: w.scopeOf(other.id) }));
    const page1 = await w.view('ongoing', '&pageSize=1', send);
    const page2 = await w.view('ongoing', '&pageSize=1&page=2', send);
    const page3 = await w.view('ongoing', '&pageSize=1&page=3', send);
    expect([page1.total, page2.total, page3.total]).toEqual([2, 2, 2]);
    expect([page1.items.length, page2.items.length, page3.items.length]).toEqual([1, 1, 0]);
    expect(w.keysOf(ids, [page1.items[0]!.id, page2.items[0]!.id]).sort()).toEqual(['endsToday', 'open']);
    // 主职部门不在范围内：行里不给主职部门（与申请详情的主职分组同口径）
    expect(page1.items[0]).not.toHaveProperty('primaryDepartmentId');
  });
});
