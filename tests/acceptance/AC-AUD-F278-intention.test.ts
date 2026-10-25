/**
 * F-278（#456 R1 转 F）：意向退休申请审计（对象类型 retirement-intention）的查看规则。
 * 申请写审计时显式归属员工 + 申请时部门快照（BE-5d2），查看口径同兼职申请（DEC-431① 单一入口）：任职记录范围
 * （employmentVisibilitySql：部门 / 员工 / 使用用户）+ 申请发起人，字段按任职记录对象的查看字段裁剪。
 * 旧实现下该类型未登记规则，审计表里有行，HR 查询却只得到 200 items: []（fail-closed 误伤）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { restricted } from './AC-PT-http-support.js';
import { intentionWorld } from './AC-RT-intention-support.js';
import { orgScope } from './support/revocable-rights.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const TYPE = 'retirement-intention';
const AT = '2026-10-01T01:00:00.000Z';
const ACTIONS = ['retirement_intention.create', 'retirement_intention.update'];

async function world(label: string) {
  const w = await intentionWorld(database().db, `f278-${label}-${uniqueSuffix()}`);
  const created = await w.create({ intendedDate: '2030-03-01', reason: '合成原因' });
  const edited = await w.patchRaw(created.id, created.revision, { intendedDate: '2030-04-01' });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const as = { tenant: w.tenant.id, user: w.hr.id };
  const seen = async (options: Parameters<typeof restricted>[0]) =>
    (await auditApi(database().db, AT, { authorize: restricted(options) }).dataChanges(as, { objectType: TYPE })).items;
  return { w, created, as, seen };
}

describe('AC-AUD-F278 意向退休申请审计查看规则', () => {
  it('任职记录范围覆盖该员工（申请时部门快照）的 HR 能查到创建 / 修改审计；范围外 HR 与空范围查不到', async () => {
    const { w, created, seen } = await world('org');
    const snapshotScope = orgScope(w.tenant.id, '2026-10-01', w.deptB);
    const rows = await seen({ scope: snapshotScope });
    expect(rows.map((row) => row.action).sort()).toEqual(ACTIONS);
    expect(new Set(rows.map((row) => row.objectId))).toEqual(new Set([created.id]));
    expect(rows[0]).toMatchObject({ objectLabel: '意向退休申请' });

    expect(await seen({ scope: orgScope(w.tenant.id, '2026-10-01', w.deptA) })).toEqual([]);
    expect(await seen({ scope: EMPTY_SCOPE })).toEqual([]);
  });

  it('创建人（使用用户维度）与兼职申请规则一致：只认申请发起人，别人的账号查不到', async () => {
    const { w, seen } = await world('creator');
    const usingUser = (creatorId: string) => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user' as const, orgIds: [], personIds: [], creatorId }],
    });
    expect((await seen({ scope: usingUser(w.hr.id) })).map((row) => row.action).sort()).toEqual(ACTIONS);
    expect(await seen({ scope: usingUser(randomUUID()) })).toEqual([]);
  });

  it('没有任职记录对象的查看权：与审计查询现有口径一致，返回空；字段按可见字段裁剪', async () => {
    const { w, seen, as } = await world('view');
    const scope = orgScope(w.tenant.id, '2026-10-01', w.deptB);
    expect(
      await seen({ scope, deny: (request) => request.action === 'object.view' && request.resource !== undefined }),
    ).toEqual([]);

    const audit = auditApi(database().db, AT, { authorize: restricted({ scope, fields: ['intendedDate'] }) });
    const [row] = (await audit.dataChanges(as, { objectType: TYPE, action: ACTIONS[0]! })).items;
    const detail = await audit.dataChange(as, row!.id);
    expect(detail.after).toMatchObject({ intendedDate: '2030-03-01' });
    expect(detail.after).not.toHaveProperty('reason');
  });
});
