/**
 * BE-7 PT-3b 权限逐入口映射（docs/08_设计/R2-T05_兼职设计.md §7.2 两行：预览 / 直接新增；视图 / 详情 / 员工页签）。
 * 顺序：功能操作权 → 按钮权 → 范围（员工按主职在范围、兼职部门在范围）→ 字段权 → 业务校验；被拒时无任何写入。
 * 读：DEC-177 两项并集（记录部门 = 兼职部门 ∪ 员工当前主职部门），范围外与不存在同一个 404，空范围看不到任何兼职（fail-closed），
 * 响应逐层 trimEmploymentResponse，无权字段缺席。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyAction, denyButton, denyFieldWrite, httpWorld, restricted } from './AC-PT-http-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import type { Request } from './support/revocable-rights.js';

const database = useTestDb();
const world = (label: string) => httpWorld(database().db, label);

describe('§7.2 预览 / 直接新增', () => {
  it('缺任职记录对象的新增权 → 403；缺 Employment.PartTime 按钮 → 403；无写入', async () => {
    const w = await world('perm-create-denied');
    const before = await w.writes();
    const send = (deny: (request: Request) => boolean) =>
      w.as(restricted({ deny }))('POST', `/employees/${w.employeeId}/part-times`, { body: w.body() });
    expect((await send(denyAction('object.create'))).status).toBe(403);
    expect((await send(denyButton('Employment.PartTime'))).status).toBe(403);
    expect(await w.writes()).toEqual(before);
    // 只有申请按钮（Employment.PartTimeApproval）不能直接新增
    const onlyApplication = restricted({ deny: denyButton('Employment.PartTime') });
    expect((await w.as(onlyApplication)('POST', `/employees/${w.employeeId}/part-times`, { body: w.body() })).status).toBe(
      403,
    );
  });

  it('预览：Employment.PartTime 或 Employment.PartTimeApproval 任一即可，两项都无 → 403；缺对象查看权 → 403', async () => {
    const w = await world('perm-preview-buttons');
    const preview = (deny: (request: Request) => boolean) =>
      w.as(restricted({ deny }))('POST', `/employees/${w.employeeId}/part-times/preview`, {
        body: w.body(),
      });
    const noDirect = denyButton('Employment.PartTime');
    const noApplication = denyButton('Employment.PartTimeApproval');
    expect((await preview(noDirect)).status).toBe(200);
    expect((await preview(noApplication)).status).toBe(200);
    expect((await preview((r) => noDirect(r) || noApplication(r))).status).toBe(403);
    expect((await preview(denyAction('object.view'))).status).toBe(403);
  });

  it('员工不在数据范围（按主职）→ 404；兼职部门不在范围 → 404；两处都在范围才放行', async () => {
    const w = await world('perm-create-scope');
    const before = await w.writes();
    const attempt = (...orgIds: string[]) =>
      w.as(restricted({ scope: w.scopeOf(...orgIds) }))('POST', `/employees/${w.employeeId}/part-times`, {
        body: w.body(),
      });
    // 员工主职在 A：只管兼职部门 B 的 HR 看不到这名员工（PT-R2）
    expect((await attempt(w.partTimeOrg.id)).status).toBe(404);
    // 员工在范围内，但兼职部门 B 不在范围（PT-R3 默认开，A-6）
    expect((await attempt(w.primaryOrg.id)).status).toBe(404);
    expect((await w.as(restricted({ scope: EMPTY_SCOPE }))('POST', `/employees/${w.employeeId}/part-times`, { body: w.body() })).status).toBe(404);
    expect(await w.writes()).toEqual(before);
    expect((await attempt(w.primaryOrg.id, w.partTimeOrg.id)).status).toBe(201);
  });

  it('预览同样受范围约束：员工范围外 / 兼职部门范围外 → 404', async () => {
    const w = await world('perm-preview-scope');
    const preview = (...orgIds: string[]) =>
      w.as(restricted({ scope: w.scopeOf(...orgIds) }))('POST', `/employees/${w.employeeId}/part-times/preview`, {
        body: w.body(),
      });
    expect((await preview(w.partTimeOrg.id)).status).toBe(404);
    expect((await preview(w.primaryOrg.id)).status).toBe(404);
    expect((await preview(w.primaryOrg.id, w.partTimeOrg.id)).status).toBe(200);
  });

  it('字段写权限按实际写入字段判：缺 endDate 写权时给了结束日期 → 403，不给结束日期则放行', async () => {
    const w = await world('perm-create-fields');
    const before = await w.writes();
    const authorize = restricted({ deny: denyFieldWrite('endDate') });
    const send = (patch: Record<string, unknown>) =>
      w.as(authorize)('POST', `/employees/${w.employeeId}/part-times`, { body: w.body(patch) });
    expect((await send({ endDate: '2026-12-31' })).status).toBe(403);
    expect(await w.writes()).toEqual(before);
    expect((await send({})).status).toBe(201);
    const noType = restricted({ deny: denyFieldWrite('partTimeType') });
    expect((await w.as(noType)('POST', `/employees/${w.employeeId}/part-times`, { body: w.body() })).status).toBe(403);
  });
});

describe('§7.2 视图 / 详情 / 员工页签', () => {
  async function seeded(label: string) {
    const w = await world(label);
    const created = await w.ok(await w.post({ endDate: '2026-12-31', fields: { directManagerId: w.employeeId } }), 201);
    const other = await w.org(`无关部门${label}`, { establishedOn: '2024-01-01' });
    const read = (orgIds: string[], fields?: string[]) =>
      w.as(restricted({ scope: w.scopeOf(...orgIds), ...(fields ? { fields } : {}) }));
    return { w, created, other, read };
  }

  it('DEC-177：只管兼职部门 B 的 HR（主职在 A）能看到该兼职；只管主职部门 A 的 HR 也能看到', async () => {
    const { w, created, read } = await seeded('perm-read-visible');
    for (const orgs of [[w.partTimeOrg.id], [w.primaryOrg.id]]) {
      const single = await read(orgs)('GET', `/part-times/${created.id}`);
      expect(single.status, orgs.join()).toBe(200);
      const list = await read(orgs)('GET', `/employees/${w.employeeId}/part-times`);
      expect((await w.ok(list)).items.map((item: { id: string }) => item.id)).toEqual([created.id]);
    }
  });

  it('PB-46 范围：只管 B 的 HR 在员工页签看到兼职，但看不到该员工的主职记录（记录链 404）', async () => {
    const { w, read } = await seeded('perm-read-primary-hidden');
    expect((await read([w.partTimeOrg.id])('GET', `/employees/${w.employeeId}/records`)).status).toBe(404);
    expect((await read([w.partTimeOrg.id])('GET', `/employees/${w.employeeId}/part-times`)).status).toBe(200);
  });

  it('范围外 / 空范围：单条 404（与不存在同码）；员工页签 404；不泄露范围外员工是否存在', async () => {
    const { w, created, other, read } = await seeded('perm-read-hidden');
    const outside = read([other.id]);
    expect((await outside('GET', `/part-times/${created.id}`)).status).toBe(404);
    expect((await outside('GET', `/employees/${w.employeeId}/part-times`)).status).toBe(404);
    const empty = w.as(restricted({ scope: EMPTY_SCOPE }));
    expect((await empty('GET', `/part-times/${created.id}`)).status).toBe(404);
    expect((await empty('GET', `/employees/${w.employeeId}/part-times`)).status).toBe(404);
  });

  it('缺任职记录对象的查看权 → 403', async () => {
    const { w, created } = await seeded('perm-read-no-view');
    const noView = w.as(restricted({ deny: denyAction('object.view') }));
    expect((await noView('GET', `/part-times/${created.id}`)).status).toBe(403);
    expect((await noView('GET', `/employees/${w.employeeId}/part-times`)).status).toBe(403);
  });

  it('响应逐层裁剪：无权查看的字段缺席（直线经理 / 结束日期 / 任职状态），有权字段保留', async () => {
    const { w, created, read } = await seeded('perm-read-trim');
    const visible = ['employeeId', 'kind', 'serviceType', 'effectiveDate', 'departmentId'];
    const trimmed = await w.ok(await read([w.partTimeOrg.id], visible)('GET', `/part-times/${created.id}`));
    expect(trimmed).toMatchObject({ employeeId: w.employeeId, effectiveDate: '2026-09-01' });
    expect(trimmed.fields).toEqual({ departmentId: w.partTimeOrg.id });
    for (const hidden of ['endDate', 'serviceStatus', 'partTimeView'] as const) expect(trimmed).not.toHaveProperty(hidden);
    const list = await w.ok(await read([w.partTimeOrg.id], visible)('GET', `/employees/${w.employeeId}/part-times`));
    expect(list.items[0].fields).toEqual({ departmentId: w.partTimeOrg.id });
    expect(list.items[0]).not.toHaveProperty('endDate');
    const everything = await w.ok(await w.one(created.id));
    expect(everything.fields.directManagerId).toBe(w.employeeId);
    expect(everything.endDate).toBe('2026-12-31');
  });
});
