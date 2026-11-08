/**
 * F-474-4c（DEC-776 / DEC-833 / DEC-836）：全部人员（原站“组织员工 → 人员信息 → 全部人员”，规格 codex-R1bd §2.3）。
 * 只读集合接口 GET /api/tenant/employment/all-people：
 * - 入口权 = 既有对象 TenantBase.EmploymentRecord 的查看权（与 -4b 任职记录列表同一对象），不再依赖人事分析（hrRoster）；
 *   不新增对象 / 字段编码，授权版本不变；
 * - 数据范围与人员侧字段权沿用员工档案对象（personScope 在分页之前过滤，total 与本页同一谓词）；
 * - 列：姓名 / 邮箱 / 工号 / 一至三级组织 / 部门 / 职级 / 职位 / 直线经理 / 入职日期 / 司龄 / 性别 / 证件类型 / 证件号码 / 年龄，
 *   无字段权的列整列缺席；用无权字段筛选 403。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { PERSON_OBJECT, RECORD_OBJECT, ROSTER_OBJECT, rosterWorld, type RosterWorld } from './AC-HA-roster-support.js';
import { ALL_PEOPLE_COLUMNS, ALL_PEOPLE_ROW } from './support/f474-all-people-row.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const allow: Authorizer = () => true;
const LIST = '/api/tenant/employment/all-people';
type Item = Record<string, unknown> & { employeeId: string; code?: string };
interface Page {
  asOf: string;
  items: Item[];
  columns: { key: string; label: string }[];
  total: number;
  page: number;
  pageSize: number;
  hasDataPermission: boolean;
}

async function job(w: RosterWorld, kind: 'posts' | 'positions' | 'levels', name: string, extra = {}) {
  const response = await w.call('POST', `/api/tenant/job/${kind}`, {
    ifMatch: 0,
    body: { name, code: `L4C_${uniqueSuffix()}`, startDate: '2024-01-01', ...extra },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}

/**
 * 集团G ─ 研发部R ─ 后端组B；集团G ─ 销售部S。租户今天 2026-10-06。
 * 张三（2025-07-01 入职，李四已在职）：后端组、内部员工、有职级 / 职位 / 用工形式、直线经理李四；李四：销售部、实习生；
 * 赵六：研发部、入职时未指定雇佣关系（系统默认内部员工）；王五：研发部入职后离职（人员状态 8，默认不列）。
 */
async function fixture(label: string) {
  const w = await rosterWorld(database().db, label);
  const group = await w.org('集团G');
  const rd = await w.org('研发部R', group);
  const backend = await w.org('后端组B', rd);
  const sales = await w.org('销售部S', group);
  const level = await job(w, 'levels', '合成职级一', { level: 1 });
  const post = await job(w, 'posts', '合成职务');
  const position = await job(w, 'positions', '合成后端工程师', { orgId: backend.id, postId: post.id });
  const forms = (await (await w.call('GET', '/api/tenant/employment/employment-forms')).json()) as {
    items: { code: string }[];
  };
  const form = forms.items[0]!.code;
  const hireFields = async (
    employeeId: string,
    department: { id: string },
    fields: Record<string, unknown>,
    effectiveDate = '2025-07-01',
  ) => {
    const employee = await w.session.getEmployee(employeeId);
    const business = await w.session.business(
      employeeId,
      { kind: 'hire', mode: 'direct', effectiveDate, fields: { departmentId: department.id, ...fields } },
      employee.revision,
    );
    expect(business.status).toBe('effective');
  };
  const li = await w.session.employee('李四', 'F4C002');
  await hireFields(li.id, sales, { employType: 'intern' }, '2025-06-01');
  await w.patchProfile(li.id, { email: 'lisi@example.com', gender: '女' });
  const zhang = await w.session.employee('张三', 'F4C001');
  await hireFields(zhang.id, backend, {
    levelId: level.id,
    positionId: position.id,
    employType: 'internal',
    employmentForm: form,
    directManagerId: li.id,
  });
  await w.patchProfile(zhang.id, {
    email: 'zhangsan@example.com',
    gender: '男',
    birthday: '1990-05-20',
    idType: '合成证件类型',
    idNumber: 'SYN-ID-0001',
  });
  const zhao = await w.hire('F4C004', '赵六', '2025-03-01', rd, { email: 'zhaoliu@example.com' });
  const wang = await w.hire('F4C003', '王五', '2025-02-01', rd, { email: 'wangwu@example.com' });
  await w.session.business(
    wang.id,
    { kind: 'leave', mode: 'direct', effectiveDate: '2026-06-01', lastWorkDate: '2026-05-31', fields: {} },
    (await w.session.getEmployee(wang.id)).revision,
  );
  return { w, group, rd, backend, sales, form, zhang, li, zhao, wang };
}

async function list(request: RosterWorld['call'], query = ''): Promise<Page> {
  const response = await request('GET', `${LIST}?page=1&pageSize=50${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Page;
}
/** 夹具世界里另有一名入职员工（工号 EMP_*）：断言只看本测试的四名员工。 */
const mine = (page: Page) => page.items.filter((item) => String(item.code).startsWith('F4C')).map((item) => item.code);
const rowOf = (page: Page, code: string) => page.items.find((item) => item.code === code)!;

describe('AC-EMP F-474-4c 全部人员', () => {
  it('默认列出人员状态为试用 / 正式的人，行与列按原站顺序；离职的人默认不列', async () => {
    const { w, zhang } = await fixture('emp4c-default');
    const page = await list(w.call);
    expect(page).toMatchObject({ asOf: '2026-10-06', page: 1, pageSize: 50, hasDataPermission: true });
    expect(mine(page)).toEqual(['F4C001', 'F4C002', 'F4C004']);
    expect(page.total).toBe(page.items.length);
    expect(page.columns).toEqual(ALL_PEOPLE_COLUMNS.map(({ key, label }) => ({ key, label })));
    expect(rowOf(page, 'F4C001')).toEqual({
      ...ALL_PEOPLE_ROW,
      employeeId: zhang.id,
      employeeName: '张三',
      email: 'zhangsan@example.com',
      code: 'F4C001',
      orgLevel1: '集团G',
      orgLevel2: '研发部R',
      orgLevel3: '后端组B',
      departmentName: '后端组B',
      level: '合成职级一',
      positionName: '合成后端工程师',
      directManagerName: '李四',
      entryDate: '2025-07-01',
      companyTenureYears: '1.2',
      gender: '男',
      idType: '合成证件类型',
      idNumber: 'SYN-ID-0001',
      age: 36,
    });
    // 没有职级 / 职位 / 经理的人：该列为空而不是缺席（列由字段权决定，不由数据决定）
    expect(rowOf(page, 'F4C002')).toMatchObject({
      orgLevel2: '销售部S',
      orgLevel3: null,
      departmentName: '销售部S',
      level: null,
      positionName: null,
      directManagerName: null,
    });
  });

  it('筛选：人员状态（可多选，默认试用 + 正式）/ 雇佣关系 / 用工形式 / 姓名 / 邮箱 / 员工 / 任职类型', async () => {
    const { w, form, zhang } = await fixture('emp4c-filters');
    expect(mine(await list(w.call, '&employeeStatus=8'))).toEqual(['F4C003']);
    expect(mine(await list(w.call, '&employeeStatus=3,8'))).toEqual(['F4C001', 'F4C002', 'F4C003', 'F4C004']);
    expect(mine(await list(w.call, '&employeeStatus=2'))).toEqual([]);
    expect(mine(await list(w.call, '&employType=internal'))).toEqual(['F4C001', 'F4C004']);
    expect(mine(await list(w.call, '&employType=intern'))).toEqual(['F4C002']);
    expect(mine(await list(w.call, `&employmentForm=${encodeURIComponent(form)}`))).toEqual(['F4C001']);
    expect(mine(await list(w.call, `&name=${encodeURIComponent('张')}`))).toEqual(['F4C001']);
    expect(mine(await list(w.call, '&email=LISI'))).toEqual(['F4C002']);
    expect(mine(await list(w.call, `&employeeId=${zhang.id}`))).toEqual(['F4C001']);
    expect(mine(await list(w.call, '&serviceType=primary'))).toEqual(['F4C001', 'F4C002', 'F4C004']);
    for (const bad of [
      'serviceType=secondary',
      'employeeStatus=99',
      'employeeStatus=x',
      'employType=boss',
      'employeeId=x',
    ])
      expect((await w.call('GET', `${LIST}?${bad}`)).status, bad).toBe(400);
    expect((await w.call('GET', `${LIST}?unknown=1`)).status).toBe(400);
  });

  it('分页：total 是筛选后的全量，逐页拼起来等于整表，越界页为空，pageSize 超上限 400', async () => {
    const { w } = await fixture('emp4c-page');
    const all = await list(w.call);
    const pages: Item[] = [];
    for (let page = 1; page <= Math.ceil(all.total / 2); page++) {
      const body = (await (await w.call('GET', `${LIST}?page=${page}&pageSize=2`)).json()) as Page;
      expect(body.total).toBe(all.total);
      expect(body.items.length).toBeLessThanOrEqual(2);
      pages.push(...body.items);
    }
    expect(pages.map((item) => item.employeeId)).toEqual(all.items.map((item) => item.employeeId));
    expect(await (await w.call('GET', `${LIST}?page=9&pageSize=2`)).json()).toMatchObject({
      items: [],
      total: all.total,
    });
    expect((await w.call('GET', `${LIST}?page=1&pageSize=201`)).status).toBe(400);
  });

  it('数据范围：分页之前按员工档案范围过滤，total 同一谓词；范围为空 fail-closed，筛选探不到范围外', async () => {
    const { w, zhang, li } = await fixture('emp4c-scope');
    const onlyZhang = w.restricted(allow, { personIds: [zhang.id] });
    const page = await list(onlyZhang);
    expect(mine(page)).toEqual(['F4C001']);
    expect(page.total).toBe(1);
    expect((await (await onlyZhang('GET', `${LIST}?page=1&pageSize=1`)).json()) as Page).toMatchObject({ total: 1 });
    expect(mine(await list(w.restricted(allow, { personIds: [li.id] })))).toEqual(['F4C002']);
    expect(await list(w.restricted(allow, { personIds: [] }))).toMatchObject({ items: [], total: 0 });
    expect(await list(onlyZhang, `&name=${encodeURIComponent('李四')}`)).toMatchObject({ total: 0 });
    expect(await list(onlyZhang, '&email=lisi')).toMatchObject({ total: 0 });
    expect(await list(onlyZhang, `&employeeId=${li.id}`)).toMatchObject({ total: 0 });
  });

  it('字段权：无权的列整列缺席，机构类列随部门字段，用无权字段筛选 403', async () => {
    const { w, backend } = await fixture('emp4c-fields');
    const noEmail = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['email'] } });
    const page = await list(noEmail);
    expect(page.columns.map((column) => column.key)).not.toContain('email');
    expect(rowOf(page, 'F4C001')).not.toHaveProperty('email');
    expect(rowOf(page, 'F4C001')).toMatchObject({ employeeName: '张三', idNumber: 'SYN-ID-0001' });
    expect((await noEmail('GET', `${LIST}?email=zhang`)).status).toBe(403);

    const noIdType = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['idType', 'idNumber', 'name'] } });
    const bare = await list(noIdType);
    for (const key of ['idType', 'idNumber', 'employeeName'])
      expect(
        bare.columns.map((column) => column.key),
        key,
      ).not.toContain(key);
    expect(rowOf(bare, 'F4C001')).not.toHaveProperty('idType');
    expect(rowOf(bare, 'F4C001')).toHaveProperty('employeeId');
    expect((await noIdType('GET', `${LIST}?name=${encodeURIComponent('张')}`)).status).toBe(403);

    const noDepartment = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['departmentId'] } });
    const flat = await list(noDepartment);
    for (const key of ['orgLevel1', 'orgLevel2', 'orgLevel3', 'departmentName'])
      expect(
        flat.columns.map((column) => column.key),
        key,
      ).not.toContain(key);
    expect(rowOf(flat, 'F4C001')).not.toHaveProperty('departmentName');
    // 部门不可见时，也不能用它之外的路径探到部门：非本接口筛选项，这里只核对响应不带机构类键
    expect(Object.keys(rowOf(flat, 'F4C001'))).not.toContain('orgLevel1');
    expect(backend.id).toBeTruthy();

    const noStatus = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['employeeStatus'] } });
    expect((await noStatus('GET', `${LIST}?employeeStatus=8`)).status).toBe(403);
    const noEmployType = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['employType'] } });
    expect((await noEmployType('GET', `${LIST}?employType=internal`)).status).toBe(403);
    const noForm = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['employmentForm'] } });
    expect((await noForm('GET', `${LIST}?employmentForm=x`)).status).toBe(403);
    const noType = w.restricted(allow, { hidden: { [RECORD_OBJECT]: ['serviceType'] } });
    expect((await noType('GET', `${LIST}?serviceType=primary`)).status).toBe(403);
    // 对照：不用这些筛选时，字段不可见不影响整页
    expect((await noType('GET', `${LIST}?page=1&pageSize=5`)).status).toBe(200);
  });

  it('入口权是任职记录对象的查看权：只有人事分析查看权 403；只有任职记录查看权 200（DEC-836）', async () => {
    const { w } = await fixture('emp4c-gate');
    const onlyRoster = w.restricted(
      (request) => !(request.resource === RECORD_OBJECT && request.action === 'object.view'),
    );
    expect((await onlyRoster('GET', `${LIST}?page=1&pageSize=5`)).status).toBe(403);
    const onlyRecord = w.restricted(
      (request) => !(request.resource === ROSTER_OBJECT && request.action === 'object.view'),
    );
    const page = await list(onlyRecord);
    expect(mine(page)).toEqual(['F4C001', 'F4C002', 'F4C004']);
    // 任职记录查看权不放行人事分析：花名册入口仍按人事分析对象拒绝，授权口径互不串用
    expect((await onlyRecord('GET', '/api/tenant/hr-analysis/roster?page=1&pageSize=5')).status).toBe(403);
    // 缺员工档案对象查看权：数据范围与人员字段无从解析，同样拒绝（不退化成全部可见）
    const noPerson = w.restricted(
      (request) => !(request.resource === PERSON_OBJECT && request.action === 'object.view'),
    );
    expect((await noPerson('GET', `${LIST}?page=1&pageSize=5`)).status).toBe(403);
  });

  it('租户隔离：另一租户看不到本租户的人，用本租户的人员 ID 筛选也是 0', async () => {
    const a = await fixture('emp4c-tenant-a');
    const b = await fixture('emp4c-tenant-b');
    const aPage = await list(a.w.call);
    const bPage = await list(b.w.call);
    const aIds = new Set(aPage.items.map((item) => item.employeeId));
    expect(bPage.items.every((item) => !aIds.has(item.employeeId))).toBe(true);
    expect(mine(aPage)).toEqual(mine(bPage));
    expect(await list(b.w.call, `&employeeId=${a.zhang.id}`)).toMatchObject({ items: [], total: 0 });
  });

  it('只读：没有写入口；响应键集与前端夹具一致', async () => {
    const { w } = await fixture('emp4c-readonly');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'])
      expect([404, 405], method).toContain((await w.call(method, LIST, { ifMatch: 0, body: {} })).status);
    const row = rowOf(await list(w.call), 'F4C001');
    expect(Object.keys(row).sort()).toEqual(Object.keys(ALL_PEOPLE_ROW).sort());
  });
});
