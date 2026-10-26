/** AC-APV-F318c / P2-1：维度成员必须属于业务日选中的版本，历史引用保存不按今天裁掉。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  dimensions,
  orgVersion,
  relationWorld,
  resolved,
  save,
  source,
  type RelationWorld,
} from './AC-APV-F318c-support.js';

const database = useTestDb();
const extensions = [
  ['business_org', 'business'],
  ['profit_center', 'product'],
  ['reserve4', 'reserve4'],
  ['reserve5', 'reserve5'],
] as const;
const path = '/api/tenant/approval/designer/source-candidates';
async function candidates(w: RelationWorld, type: string, id: string, date = '2026-10-01') {
  const result = await w.json<{ items: { id: string; enabled: boolean }[] }>(
    await w.request(w.hr.id, 'GET', `${path}?type=${type}&asOf=${date}&ids=${id}&includeInactive=true`),
  );
  return result.items;
}

describe('AC-APV-F318c 维度成员全链路', () => {
  for (const [type, dimension] of extensions) {
    it(`${type} 仅行政组织不进候选、不允许保存、不派给其负责人`, async () => {
      const w = await relationWorld(database().db, `membership-${type}`);
      await dimensions(w);
      expect.soft(await candidates(w, type, w.root)).toEqual([]);
      const response = await save(w, [source(type, w.root)]);
      const body = await response.json();
      expect.soft(response.status).toBe(422);
      expect.soft(body.error).toMatchObject({
        code: 'APPROVAL_SOURCE_INVALID',
        details: { reason: 'APPROVAL_SOURCE_REFERENCE_INVALID' },
      });
      // 即使旧定义已经保存，运行入口也不能把无维度关系的行政组织当成维度根。
      expect.soft(await resolved(w, source(type, w.root))).toEqual([]);
      if (response.status === 201) {
        await w.publish(body);
        const run = await w.submit(await w.application(w.subject.employeeId, { departmentId: w.staff }));
        expect.soft(w.pending(run).map((task) => task.assigneeUserId)).not.toContain(w.head.userId);
      }
      expect(await candidates(w, 'department', w.root)).toHaveLength(1);
      expect(await resolved(w, source('department', w.root))).toEqual([w.head.userId]);
    });

    it(`${type} 9月加入维度，8月不取、10月候选与真实派单均取到`, async () => {
      const w = await relationWorld(database().db, `membership-history-${type}`);
      await dimensions(w);
      await orgVersion(w, w.root, { startDate: '2026-09-01' }, { [dimension]: w.tenant.id });
      await w.publishedProcess({ nodes: [{ key: 'one', approver: source(type, w.root) }] });
      for (const date of ['2026-08-01', '2026-10-01']) {
        const belongs = date === '2026-10-01';
        expect.soft((await candidates(w, type, w.root, date)).map((item) => item.id)).toEqual(belongs ? [w.root] : []);
        expect.soft(await resolved(w, source(type, w.root), date)).toEqual(belongs ? [w.head.userId] : []);
        const person = await w.person(`合成业务日${date}`, w.child);
        const business = await w.application(person.employeeId, { departmentId: w.staff }, { effectiveDate: date });
        const response = await w.submitRaw(business);
        expect.soft(response.status).toBe(belongs ? 200 : 409);
        if (!belongs) {
          expect.soft((await response.clone().json()).error).toMatchObject({
            code: 'CONFLICT',
            details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' },
          });
          expect.soft(await w.instanceOfAll(business.id)).toEqual([]);
        }
        if (response.status === 200) {
          const run = await w.instanceOf(business.id);
          expect.soft(w.pending(run).map((task) => task.assigneeUserId)).toEqual(belongs ? [w.head.userId] : []);
        }
      }
    });

    it(`${type} 保留租户根、历史停用引用；后代和父链都不借用缺维度的组织`, async () => {
      const w = await relationWorld(database().db, `membership-tree-${type}`);
      await dimensions(w);
      await w.setOrgRoles(w.tenant.id, { head: w.head.employeeId });
      expect(await candidates(w, type, w.tenant.id)).toHaveLength(1);
      expect((await save(w, [source(type, w.tenant.id)])).status).toBe(201);
      expect(await resolved(w, source(type, w.tenant.id))).toEqual([w.head.userId]);
      await orgVersion(w, w.root, {}, { [dimension]: w.tenant.id });
      await orgVersion(w, w.child, { enabled: false }, { [dimension]: w.root });
      expect((await save(w, [source(type, w.child)])).status).toBe(201);
      expect(await candidates(w, type, w.child)).toEqual([expect.objectContaining({ id: w.child, enabled: false })]);
      expect(await resolved(w, source(type, w.child))).toEqual([w.head.userId]);
      // 行政后代 staff 未加入该维度，其负责人不应混入 descendants。
      await orgVersion(w, w.staff, { personInChargeId: w.near.employeeId }, { admin: w.root });
      expect(await resolved(w, source(type, w.root, ':descendants'))).toEqual([w.head.userId]);
      // 新版本退出维度，不影响历史引用保存；当前父链不能穿过已不属于维度的普通组织。
      await orgVersion(w, w.root, { startDate: '2026-09-01' }, { [dimension]: undefined });
      expect.soft((await save(w, [source(type, w.root)])).status).toBe(201);
      expect.soft(await resolved(w, source(type, w.child), '2026-08-01')).toEqual([w.head.userId]);
      expect.soft(await resolved(w, source(type, w.child))).toEqual([]);
      expect.soft(await resolved(w, source(type, w.root, ':descendants'))).toEqual([]);
    });
  }
  it('同一天被新版本撤掉的关系不能冒充可选历史引用', async () => {
    const w = await relationWorld(database().db, 'membership-corrected');
    await dimensions(w);
    await orgVersion(w, w.root, {}, { business: w.tenant.id });
    await orgVersion(w, w.root, {}, { business: undefined });
    expect.soft((await save(w, [source('business_org', w.root)])).status).toBe(422);
    expect.soft(await candidates(w, 'business_org', w.root)).toEqual([]);
    expect.soft(await resolved(w, source('business_org', w.root))).toEqual([]);
  });
});
