/**
 * F-474-4a（DEC-776）：员工列表补列——机构ID、组织全称、雇佣关系、职位（原站员工列表 #14）。
 * 取值与时点花名册同口径（组织全称沿用 org 模块的解析，不另写一份）；字段权按人员对象裁剪；无任职的人员列为空。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { PERSON_OBJECT, rosterWorld, type RosterWorld } from './AC-HA-roster-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const allow: Authorizer = () => true;
const LIST = '/api/tenant/personnel/employees';
type ListItem = Record<string, unknown> & { id: string };

async function job(w: RosterWorld, kind: 'posts' | 'positions', name: string, extra: Record<string, unknown> = {}) {
  const response = await w.call('POST', `/api/tenant/job/${kind}`, {
    ifMatch: 0,
    body: { name, code: `L4A_${uniqueSuffix()}`, startDate: '2024-01-01', ...extra },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string };
}

/** 集团 → 研发部；张三任研发部“合成后端工程师”，李四只建档未入职。 */
async function fixture(label: string) {
  const w = await rosterWorld(database().db, label);
  const group = await w.org('集团G');
  // 机构编码由夹具指定，测试里手写完整期望，不拿别的入口的响应当预期（4a 第 1 轮 P3-1）
  const rdCode = `L4A_RD_${uniqueSuffix()}`;
  const rd = await w.session.org('研发部R', {
    code: rdCode,
    establishedOn: '2024-01-01',
    parents: { admin: { parentId: group.id } },
  });
  const post = await job(w, 'posts', '合成职务');
  const position = await job(w, 'positions', '合成后端工程师', { orgId: rd.id, postId: post.id });
  const zhang = await w.session.employee('张三', 'L4A001');
  await w.session.business(
    zhang.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: rd.id, positionId: position.id, employType: 'internal' },
    },
    zhang.revision,
  );
  const li = await w.session.employee('李四', 'L4A002');
  return { w, rd, rdCode, zhang, li };
}

async function list(request: RosterWorld['call'], query = '') {
  const response = await request('GET', `${LIST}?page=1&pageSize=50${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ListItem[] }).items;
}
const byCode = (items: ListItem[], code: string) => items.find((item) => item.code === code)!;

describe('AC-PRM F-474-4a 员工列表补列', () => {
  it('返回机构ID、组织全称、雇佣关系、职位，组织全称与时点花名册同口径', async () => {
    const { w, rdCode, zhang } = await fixture('prm4a-cols');
    const row = byCode(await list(w.call), 'L4A001');
    const roster = (await w.rosterOk('2026-10-06')).items.find((item) => item.code === 'L4A001')!;
    expect(row).toMatchObject({ id: zhang.id, employType: 'internal', positionName: '合成后端工程师' });
    expect(row.orgFullName).toBe(roster.orgFullName);
    // 夹具手写的精确期望：完整全称（租户根 → 集团 → 研发部，夹具租户根名为“租户<label>”）与机构编码
    expect(row.orgFullName).toBe('租户prm4a-cols/集团G/研发部R');
    expect(row.orgCode).toBe(rdCode);
    // 部门 ID 只用于解析组织，不随列表返回
    expect(row).not.toHaveProperty('departmentId');
  });

  it('未入职、没有任职记录的人员：四列为空，不报错', async () => {
    const { w } = await fixture('prm4a-empty');
    const row = byCode(await list(w.call), 'L4A002');
    expect(row).toMatchObject({ orgCode: null, orgFullName: null, employType: null, positionName: null });
  });

  it('字段权：人员对象没有查看权的列不返回，其余列照常', async () => {
    const { w } = await fixture('prm4a-hidden');
    const request = w.restricted(allow, { hidden: { [PERSON_OBJECT]: ['orgFullName', 'positionName'] } });
    const row = byCode(await list(request), 'L4A001');
    expect(row).not.toHaveProperty('orgFullName');
    expect(row).not.toHaveProperty('positionName');
    expect(row).toMatchObject({ employType: 'internal' });
    expect(row.orgCode).toEqual(expect.any(String));
  });
});
