/**
 * F-474-4b #16（DEC-776）：全租户任职记录列表（原站“任职管理 → 任职记录”）。
 * 只读集合接口 GET /api/tenant/employment/records：授权沿用既有对象 TenantBase.EmploymentRecord（不新增对象码，
 * 不动授权版本）；数据范围按 DEC-177 可见口径在分页之前过滤，total 与本页同一谓词；字段权：任职字段按任职记录对象、
 * 姓名 / 工号 / 人员状态按人员对象裁剪，机构类列随 departmentId 字段权，不可见的字段缺席，用它筛选一律 403。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { MODULE_OBJECTS } from '@italent/domain';
import { PERSON_OBJECT, RECORD_OBJECT, rosterWorld, type RosterWorld } from './AC-HA-roster-support.js';
import { RECORD_ROW } from './support/f474-records-row.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const allow: Authorizer = () => true;
const EMPLOYEE_OBJECT = MODULE_OBJECTS.employee.code;
const LIST = '/api/tenant/employment/records';
type Item = Record<string, unknown> & { id: string; employeeCode?: string; kind?: string };
interface Page {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  hasDataPermission: boolean;
}

/**
 * 集团G ─ 研发部R ─ 后端组B；集团G ─ 销售部S。
 * 张三：后端组入职（2025-01-01）→ 调动到销售部（2026-03-01）；李四：研发部入职（2025-06-01）；
 * 王五：研发部入职（2025-02-01）→ 离职（2026-06-01，人员状态 8）。租户今天 2026-10-06。
 */
async function fixture(label: string) {
  const w = await rosterWorld(database().db, label);
  const group = await w.org('集团G');
  const rdCode = `F4B_RD_${uniqueSuffix()}`;
  const rd = await w.session.org('研发部R', {
    code: rdCode,
    establishedOn: '2024-01-01',
    parents: { admin: { parentId: group.id } },
  });
  const backend = await w.org('后端组B', rd);
  const sales = await w.org('销售部S', group);
  const zhang = await w.hire('F4B001', '张三', '2025-01-01', backend, { email: 'zhangsan@example.com' });
  await w.session.business(
    zhang.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-03-01', fields: { departmentId: sales.id } },
    (await w.session.getEmployee(zhang.id)).revision,
  );
  const li = await w.hire('F4B002', '李四', '2025-06-01', rd, { email: 'lisi@example.com' });
  const wang = await w.hire('F4B003', '王五', '2025-02-01', rd, { email: 'wangwu@example.com' });
  await w.session.business(
    wang.id,
    { kind: 'leave', mode: 'direct', effectiveDate: '2026-06-01', lastWorkDate: '2026-05-31', fields: {} },
    (await w.session.getEmployee(wang.id)).revision,
  );
  return { w, group, rd, rdCode, backend, sales, zhang, li, wang };
}

async function list(request: RosterWorld['call'], query = ''): Promise<Page> {
  const response = await request('GET', `${LIST}?page=1&pageSize=50${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Page;
}
/** 夹具世界里已有一名入职员工（工号 EMP_*）：keys 只看本测试的三名员工，total 要加上它的 1 条记录。 */
const BASELINE_RECORDS = 1;
const keys = (page: Page) =>
  page.items
    .filter((item) => String(item.employeeCode).startsWith('F4B'))
    .map((item) => `${item.employeeCode}:${item.kind}`);

const rowOf = (page: Page, key: string) => page.items.find((item) => `${item.employeeCode}:${item.kind}` === key)!;

describe('AC-EMP F-474-4b #16 全租户任职记录列表', () => {
  it('跨员工列出全部任职记录：按生效日倒序，行带姓名 / 工号 / 任职类型 / 机构 / 一至三级组织 / 部门', async () => {
    const { w, rdCode } = await fixture('emp4b-all');
    const page = await list(w.call);
    expect(page).toMatchObject({ total: 5 + BASELINE_RECORDS, page: 1, pageSize: 50, hasDataPermission: true });
    expect(keys(page)).toEqual(['F4B003:leave', 'F4B001:transfer', 'F4B002:hire', 'F4B003:hire', 'F4B001:hire']);
    const root = '租户emp4b-all';
    // 手写完整期望（不取别的入口的响应）：张三调动记录在销售部（二级），首条入职记录在后端组（三级）
    expect(rowOf(page, 'F4B001:transfer')).toMatchObject({
      employeeName: '张三',
      employeeCode: 'F4B001',
      orgFullName: `${root}/集团G/销售部S`,
      departmentName: '销售部S',
      orgLevels: ['集团G', '销售部S', null],
      isCurrent: true,
    });
    expect(rowOf(page, 'F4B001:hire')).toMatchObject({
      employeeCode: 'F4B001',
      orgFullName: `${root}/集团G/研发部R/后端组B`,
      departmentName: '后端组B',
      orgLevels: ['集团G', '研发部R', '后端组B'],
      isCurrent: false,
    });
    expect(rowOf(page, 'F4B002:hire')).toMatchObject({ orgCode: rdCode, effectiveDate: '2025-06-01' });
    // 响应形状与前端夹具共用同一样例（support/f474-records-row.ts）
    expect(Object.keys(rowOf(page, 'F4B001:transfer')).sort()).toEqual(Object.keys(RECORD_ROW).sort());
    expect(Object.keys(rowOf(page, 'F4B001:transfer').fields as object).sort()).toEqual(
      Object.keys(RECORD_ROW.fields).sort(),
    );
    // 员工标识类内部字段不外露：只给 employeeId（本列表的跳转键）
    expect(rowOf(page, 'F4B002:hire')).not.toHaveProperty('departmentId');
    expect(new Set(page.items.map((item) => item.serviceType))).toEqual(new Set(['primary']));
  });

  it('筛选：姓名 / 电子邮件 / 任职状态 / 任职类型 / 任职部门（含下级）/ 审批状态 / 是否当前生效', async () => {
    const { w, rd, sales } = await fixture('emp4b-filter');
    expect(keys(await list(w.call, '&name=' + encodeURIComponent('张')))).toEqual(['F4B001:transfer', 'F4B001:hire']);
    expect(keys(await list(w.call, '&email=lisi'))).toEqual(['F4B002:hire']);
    // 通配符按字面匹配：% / _ 不是“任意字符”
    for (const wildcard of ['%25', '_']) expect(await list(w.call, `&name=${wildcard}`)).toMatchObject({ total: 0 });
    // 是否当前生效：每名员工恰一条
    expect(keys(await list(w.call, '&current=true'))).toEqual(['F4B003:leave', 'F4B001:transfer', 'F4B002:hire']);
    expect(keys(await list(w.call, '&current=false'))).toEqual(['F4B003:hire', 'F4B001:hire']);
    // 任职中 = 试用 / 正式 / 非正式；离职（8）不算
    expect(keys(await list(w.call, '&current=true&employeeStatus=working'))).toEqual([
      'F4B001:transfer',
      'F4B002:hire',
    ]);
    expect(keys(await list(w.call, '&employeeStatus=8'))).toEqual(['F4B003:leave']);
    expect(await list(w.call, '&serviceType=primary')).toMatchObject({ total: 5 + BASELINE_RECORDS });
    expect(keys(await list(w.call, `&departmentId=${sales.id}`))).toEqual(['F4B001:transfer']);
    // 研发部含下级（后端组）：张三首条 + 李四 + 王五两条
    expect(keys(await list(w.call, `&departmentId=${rd.id}`))).toEqual([
      'F4B003:leave',
      'F4B002:hire',
      'F4B003:hire',
      'F4B001:hire',
    ]);
    expect(keys(await list(w.call, `&departmentId=${rd.id}&includeChildren=false`))).toEqual([
      'F4B003:leave',
      'F4B002:hire',
      'F4B003:hire',
    ]);
    expect(await list(w.call, '&approvalState=effective')).toMatchObject({ total: 5 + BASELINE_RECORDS });
    // 本列表只读生效记录：其他审批状态没有可列的记录，按非法取值拒绝，不静默给空
    for (const bad of [
      '&approvalState=in_review',
      '&employeeStatus=99',
      '&current=maybe',
      '&departmentId=not-a-uuid',
      '&serviceType=part_time',
    ])
      expect((await w.call('GET', `${LIST}?page=1&pageSize=5${bad}`)).status).toBe(400);
  });

  it('分页：total 是筛选后的全量，页内条数受 pageSize 限制，逐页拼起来等于整表，超上限 400', async () => {
    const { w } = await fixture('emp4b-page');
    const all = await list(w.call);
    const total = 5 + BASELINE_RECORDS;
    expect(all.total).toBe(total);
    const pages: Page[] = [];
    for (const page of [1, 2, 3]) {
      const body = (await (await w.call('GET', `${LIST}?page=${page}&pageSize=2`)).json()) as Page;
      expect(body).toMatchObject({ total, page, pageSize: 2 });
      expect(body.items).toHaveLength(2);
      pages.push(body);
    }
    expect(pages.flatMap((body) => body.items.map((item) => item.id))).toEqual(all.items.map((item) => item.id));
    // 越界页：空行，total 不变
    const beyond = (await (await w.call('GET', `${LIST}?page=4&pageSize=2`)).json()) as Page;
    expect(beyond).toMatchObject({ items: [], total });
    expect((await w.call('GET', `${LIST}?page=1&pageSize=201`)).status).toBe(400);
  });

  it('数据范围：分页之前按 DEC-177 可见口径过滤，total 同一口径；范围为空 fail-closed，筛选不探范围外', async () => {
    const { w, zhang, li } = await fixture('emp4b-scope');
    const mine = w.restricted(allow, { personIds: [zhang.id] });
    const page = await list(mine);
    expect(keys(page)).toEqual(['F4B001:transfer', 'F4B001:hire']);
    expect(page.total).toBe(2);
    // 一页一条也不改变 total（不是先分页后过滤）
    const one = (await (await mine('GET', `${LIST}?page=2&pageSize=1`)).json()) as Page;
    expect(keys(one)).toEqual(['F4B001:hire']);
    expect(one.total).toBe(2);
    expect(keys(await list(w.restricted(allow, { personIds: [li.id] })))).toEqual(['F4B002:hire']);
    expect(await list(w.restricted(allow, { personIds: [] }))).toMatchObject({ items: [], total: 0 });
    // 范围外的人：姓名 / 邮箱筛选命中也是 0
    expect(await list(mine, '&name=' + encodeURIComponent('李四'))).toMatchObject({ total: 0 });
    expect(await list(mine, '&email=lisi')).toMatchObject({ total: 0 });
  });

  it('字段权：不可见字段缺席，机构类列随部门字段，用不可见字段筛选 403', async () => {
    const { w, sales } = await fixture('emp4b-fields');
    const noName = w.restricted(allow, { hidden: { [EMPLOYEE_OBJECT]: ['name'] } });
    const row = rowOf(await list(noName), 'F4B001:transfer');
    expect(row).not.toHaveProperty('employeeName');
    expect(row).toMatchObject({ employeeCode: 'F4B001', orgFullName: expect.any(String) });
    expect((await noName('GET', `${LIST}?name=${encodeURIComponent('张')}`)).status).toBe(403);

    const noDepartment = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['departmentId'] } });
    const bare = rowOf(await list(noDepartment), 'F4B001:transfer');
    for (const key of ['orgCode', 'orgFullName', 'departmentName', 'orgLevels'])
      expect(bare, key).not.toHaveProperty(key);
    expect(bare.fields).not.toHaveProperty('departmentId');
    expect((await noDepartment('GET', `${LIST}?departmentId=${sales.id}`)).status).toBe(403);

    const noKind = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['kind'] } });
    const unlabeled = (await list(noKind)).items.find((item) => item.employeeCode === 'F4B001')!;
    expect(unlabeled).not.toHaveProperty('kind');

    const noEmail = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['email'] } });
    expect((await noEmail('GET', `${LIST}?email=lisi`)).status).toBe(403);
    const noStatus = w.restricted(allow, { hidden: { [EMPLOYEE_OBJECT]: ['employeeStatus'] } });
    expect((await noStatus('GET', `${LIST}?employeeStatus=working`)).status).toBe(403);
  });

  it('没有任职记录对象的查看权：403；本接口只读，没有写入口', async () => {
    const { w } = await fixture('emp4b-deny');
    const denied = w.restricted((request) => !(request.resource === RECORD_OBJECT && request.action === 'object.view'));
    expect((await denied('GET', `${LIST}?page=1&pageSize=5`)).status).toBe(403);
    for (const method of ['POST', 'PATCH', 'DELETE'])
      expect([404, 405], method).toContain((await w.call(method, LIST, { ifMatch: 0, body: {} })).status);
  });
});
