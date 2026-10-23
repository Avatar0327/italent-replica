/** F234B D2/D3、D5、D8～D13；DEC-673：机构与申请来源等取证，本单只读扩展。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { restricted } from './AC-PT-http-support.js';
import { insertPartTimeRecord } from './AC-PT-support.js';
import { viewsWorld, type ViewBody } from './AC-PT-views-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => viewsWorld(database().db, `f255-${label}`);
const fields = [
  ...MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code),
  ...MODULE_OBJECTS.employee.fields.map((field) => field.code),
  'id',
  'revision',
];

describe('AC-PT-F255 排序在分页前执行', () => {
  it('即将到期默认开始日升序、同日单号升序，其余记录视图保留倒序', async () => {
    const w = await world('defaults');
    const first = await w.seedPartTime({ startDate: '2026-08-01', endDate: '2026-10-10' });
    const same = await w.seedPartTime({ startDate: '2026-08-01', endDate: '2026-10-11' });
    const last = await w.seedPartTime({ startDate: '2026-09-01', endDate: '2026-10-12' });
    const ascending = [...[first, same].sort(), last];
    expect(w.idsOf(await w.view('expiring'))).toEqual(ascending);
    expect(w.idsOf(await w.view('ongoing'))).toEqual([last, ...[first, same].sort()]);
    const pages = await Promise.all([1, 2, 3].map((page) => w.view('expiring', `&pageSize=1&page=${page}`)));
    expect(pages.flatMap(w.idsOf)).toEqual(ascending);
    expect(pages.map((page) => page.total)).toEqual([3, 3, 3]);
  });

  it('开始日/结束日/类型双向排序，空结束日始终最后，期限取最新期', async () => {
    const w = await world('sort');
    const a = await w.seedPartTime({ startDate: '2026-07-01', endDate: '2026-10-01' });
    const b = await w.seedPartTime({ startDate: '2026-08-01', endDate: '2026-10-20', serviceType: 'secondment' });
    const c = await w.seedPartTime({ startDate: '2026-09-01', endDate: null, serviceType: 'expatriate' });
    await withTenant(w.db, w.tenantId, (tx) => tx.execute(w.term(a, 2, '2026-10-30', 'edit')));
    for (const [key, asc, desc] of [
      ['effectiveDate', [a, b, c], [c, b, a]],
      ['endDate', [b, a, c], [a, b, c]],
      ['serviceType', [a, b, c], [c, b, a]],
    ] as const) {
      expect(w.idsOf(await w.view('all', `&sortBy=${key}&direction=asc`)), key).toEqual(asc);
      expect(w.idsOf(await w.view('all', `&sortBy=${key}&direction=desc`)), key).toEqual(desc);
    }
  });

  it('工号排序与人员多选：多值 OR、不同筛选 AND、分页不丢行', async () => {
    const w = await world('people');
    const records: string[] = [];
    const employees: string[] = [];
    for (const code of ['C', 'A', 'B']) {
      const employee = await w.employee(`合成员工${code}`, `${code}-${uniqueSuffix()}`);
      await w.business(
        employee.id,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2025-01-01',
          fields: { departmentId: w.primaryOrg.id },
        },
        employee.revision,
      );
      employees.push(employee.id);
      records.push(
        await withTenant(w.db, w.tenantId, (tx) =>
          insertPartTimeRecord(tx, {
            tenantId: w.tenantId,
            employeeId: employee.id,
            departmentId: w.partTimeOrg.id,
            startDate: '2026-09-01',
            serviceType: code === 'B' ? 'secondment' : 'part_time',
          }),
        ),
      );
    }
    const query = `&employeeIds=${employees[0]}&employeeIds=${employees[1]}&sortBy=code&direction=asc`;
    expect(w.idsOf(await w.view('all', query))).toEqual([records[1], records[0]]);
    expect(w.idsOf(await w.view('all', '&sortBy=code&direction=desc'))).toEqual([records[0], records[2], records[1]]);
    expect(w.idsOf(await w.view('all', `${query}&pageSize=1&page=2`))).toEqual([records[0]]);
    expect((await w.view('all', `${query}&serviceTypes=secondment`)).total).toBe(0);
    expect((await w.view('all', '&serviceTypes=part_time&serviceTypes=secondment')).total).toBe(3);
  });

  it('非法字段/方向、重复单值及视图不支持的排序一律 400', async () => {
    const w = await world('bad-sort');
    for (const query of [
      'view=all&sortBy=unknown',
      'view=all&sortBy=institution',
      'view=all&sortBy=name',
      'view=all&sortBy=effectiveDate&direction=sideways',
      'view=all&direction=desc',
      'view=all&sortBy=code&sortBy=endDate',
      'view=in_approval&sortBy=code',
      'view=ongoing&sortBy=postId',
      'view=ongoing&sortBy=directManagerId',
    ])
      expect((await w.get(`/part-times?${query}`)).status, query).toBe(400);
  });
});

describe('AC-PT-F256 字段与筛选', () => {
  it('任职状态与当前生效独立筛选；空区间仍属结束，未开始仍任职中', async () => {
    const w = await world('status');
    const ids = await w.seedMatrix();
    const keys = async (query: string) => w.keysOf(ids, w.idsOf(await w.view('all', query))).sort();
    expect(await keys('&serviceStatuses=serving&current=false')).toEqual(['startsTomorrow']);
    expect(await keys('&serviceStatuses=ended')).toEqual(['emptySpan', 'endedYesterday']);
    expect(await keys('&serviceStatuses=serving&serviceStatuses=ended&current=true')).toEqual([
      'endsDay30',
      'endsDay31',
      'endsToday',
      'open',
      'sameDay',
      'startsToday',
    ]);
  });

  it('兼职职务按当前快照筛选；部门排序、经理排序、申请职务排序可用', async () => {
    const w = await world('references');
    const api = tenantApi(w.db);
    const response = await api.request('POST', '/api/tenant/job/posts', {
      tenant: w.tenantId,
      user: w.user.id,
      ifMatch: 0,
      body: { name: '合成兼职职务', code: `POST-${uniqueSuffix()}`, startDate: '2024-01-01' },
    });
    const post = await w.ok<{ id: string }>(response, 201);
    const manager = await w.colleague('合成经理');
    const a = await w.make({ startDate: '2026-11-01', fields: { postId: post.id, directManagerId: manager.id } });
    const b = await w.make({ startDate: '2026-11-02' });
    expect(w.idsOf(await w.view('all', `&postId=${post.id}`))).toEqual([a.id]);
    expect(w.idsOf(await w.view('not_started', '&sortBy=directManagerId&direction=asc'))).toEqual([a.id, b.id]);
    const other = await w.org(`Z部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
    await w.moveSnapshot(a.id, other.id);
    expect((await w.view('all', `&postId=${post.id}`)).total).toBe(0);
    const departmentOrder = await w.view('all', '&sortBy=departmentId&direction=asc');
    expect(departmentOrder.total).toBe(2);
    const request = await w.seedRequest({ requestType: 'add' });
    expect(w.idsOf(await w.view('in_approval', '&sortBy=postId&direction=asc'))).toEqual([request]);
  });

  it('即将到期取最新未删除延长/结束申请，按该申请状态筛选而非任意历史状态', async () => {
    const w = await world('latest');
    const record = await w.seedPartTime({ endDate: '2026-10-20' });
    const bare = await w.seedPartTime({ endDate: '2026-10-21' });
    await w.seedRequest({ requestType: 'extend', recordId: record, state: 'rejected' });
    await w.seedRequest({ requestType: 'end', recordId: record, state: 'in_review' });
    await w.seedRequest({ requestType: 'extend', recordId: record, state: 'deleted' });
    const body = await w.view('expiring');
    expect(body.items.find((row) => row.id === record)).toMatchObject({
      pendingKind: 'end',
      pendingStatus: 'in_review',
    });
    expect(body.items.find((row) => row.id === bare)).toMatchObject({ pendingKind: null, pendingStatus: null });
    expect(w.idsOf(await w.view('expiring', '&pendingStatuses=in_review'))).toEqual([record]);
    expect((await w.view('expiring', '&pendingStatuses=rejected')).total).toBe(0);
    expect(w.idsOf(await w.view('expiring', '&pendingStatuses=rejected&pendingStatuses=in_review'))).toEqual([record]);
  });

  it('审批视图默认审批中，可多选申请类型/审批状态，删除申请始终不可见', async () => {
    const w = await world('requests');
    const record = await w.seedPartTime({ endDate: '2026-10-20' });
    const add = await w.seedRequest({ requestType: 'add' });
    const extend = await w.seedRequest({ requestType: 'extend', recordId: record, state: 'rejected' });
    const end = await w.seedRequest({ requestType: 'end', recordId: record, state: 'draft' });
    await w.seedRequest({ requestType: 'add', state: 'deleted' });
    expect(w.idsOf(await w.view('in_approval'))).toEqual([add]);
    expect(w.idsOf(await w.view('in_approval', '&kinds=extend&statuses=rejected'))).toEqual([extend]);
    expect(
      w.idsOf(await w.view('in_approval', '&kinds=extend&kinds=end&statuses=rejected&statuses=draft')).sort(),
    ).toEqual([extend, end].sort());
    expect((await w.get('/part-times?view=in_approval&statuses=deleted')).status).toBe(400);
  });

  it('数组中非法值、错视图筛选和超长人员数组不被静默忽略', async () => {
    const w = await world('invalid');
    for (const query of [
      'view=all&employeeIds=bad',
      'view=all&serviceTypes=part_time&serviceTypes=primary',
      'view=all&postId=bad',
      'view=all&serviceStatuses=unknown',
      'view=all&current=unknown',
      'view=in_approval&kinds=other',
      'view=in_approval&statuses=other',
      'view=expiring&pendingStatuses=other',
      'view=all&pendingStatuses=in_review',
      'view=ongoing&current=false',
      'view=all&kinds=add',
      'view=all&statuses=in_review',
      `view=all&${Array.from({ length: 201 }, () => `employeeIds=${randomUUID()}`).join('&')}`,
    ])
      expect((await w.get(`/part-times?${query}`)).status, query.slice(0, 100)).toBe(400);
  });
});

describe('AC-PT-F255-F256 当前权限和租户边界', () => {
  it('排序/筛选无字段权 403，关联申请两列分别跟随 kind/status 裁剪', async () => {
    const w = await world('fields');
    const record = await w.seedPartTime({ endDate: '2026-10-20' });
    await w.seedRequest({ requestType: 'end', recordId: record });
    for (const [field, query] of [
      ['code', 'view=all&sortBy=code'],
      ['serviceType', 'view=all&serviceTypes=part_time'],
      ['employeeId', `view=all&employeeIds=${w.employeeId}`],
      ['postId', `view=all&postId=${randomUUID()}`],
      ['effectiveDate', 'view=all&sortBy=effectiveDate'],
      ['departmentId', 'view=all&sortBy=departmentId'],
      ['serviceStatus', 'view=all&serviceStatuses=serving'],
      ['partTimeView', 'view=all&current=true'],
      ['kind', 'view=in_approval&kinds=add'],
      ['status', 'view=in_approval&statuses=rejected'],
      ['status', 'view=expiring&pendingStatuses=in_review'],
    ]) {
      const send = w.getAs(restricted({ fields: fields.filter((key) => key !== field) }));
      expect((await send(`/part-times?${query}`)).status, field).toBe(403);
    }
    for (const [hidden, absent, present] of [
      ['kind', 'pendingKind', 'pendingStatus'],
      ['status', 'pendingStatus', 'pendingKind'],
    ]) {
      const body = await w.view(
        'expiring',
        '',
        w.getAs(restricted({ fields: fields.filter((key) => key !== hidden) })),
      );
      expect(body.items[0]).not.toHaveProperty(absent!);
      expect(body.items[0]).toHaveProperty(present!);
    }
  });

  it('新筛选不放宽范围；跨租户人员 ID 返回空集，空范围分页 total 为 0', async () => {
    const a = await world('tenant-a');
    const b = await world('tenant-b');
    await a.seedPartTime({ endDate: '2026-10-20' });
    await b.seedPartTime({ endDate: '2026-10-20' });
    const query = `&employeeIds=${b.employeeId}&sortBy=effectiveDate&direction=asc`;
    expect((await a.view('all', query)).total).toBe(0);
    const body: ViewBody = await a.view(
      'all',
      `&employeeIds=${a.employeeId}&sortBy=endDate`,
      a.getAs(restricted({ scope: EMPTY_SCOPE })),
    );
    expect(body).toMatchObject({ items: [], total: 0, hasDataPermission: false });
  });
});
