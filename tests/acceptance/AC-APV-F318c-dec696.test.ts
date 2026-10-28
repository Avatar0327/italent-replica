/** DEC-695/696：历史边只供退出中间节点跳转；候选、成员、当前负责人均不恢复。 */
import './support/exit-gate-enforced.js';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import type { ApproverSource } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { resolveSource } from '../../apps/api/src/modules/approval/source-resolver.js';
import { dimensions, orgVersion, relationWorld, resolved, source, type RelationWorld } from './AC-APV-F318c-support.js';

const database = useTestDb();
const extensions = [
  ['business_org', 'business'],
  ['profit_center', 'product'],
  ['reserve4', 'reserve4'],
  ['reserve5', 'reserve5'],
] as const;
interface Diagnostic {
  startId: string;
  skippedOrgIds: readonly string[];
  reason: string;
}
async function observe(w: RelationWorld, value: ApproverSource, businessDate = '2026-10-01') {
  const diagnostics: Diagnostic[] = [];
  const subject = {
    tenantId: w.tenant.id,
    asOf: '2026-10-01',
    businessDate,
    initiatorUserId: w.hr.id,
    subjectEmployeeId: w.subject.employeeId,
    latestDepartmentId: w.child,
    recordDepartmentId: w.child,
    sourceDiagnostics: (entry: Diagnostic) => diagnostics.push(entry),
  };
  const candidates = await withTenant(w.db, w.tenant.id, (tx) => resolveSource(tx, subject, value));
  return { users: candidates.flatMap((c) => c.userId ?? []), diagnostics };
}
async function chain(w: RelationWorld, dimension = 'business') {
  await dimensions(w);
  await w.setOrgRoles(w.tenant.id, { head: w.head.employeeId });
  await orgVersion(w, w.root, { personInChargeId: w.near.employeeId }, { [dimension]: w.tenant.id, admin: w.staff });
  await orgVersion(w, w.child, { personInChargeId: null }, { [dimension]: w.root });
}
const exit = (w: RelationWorld, id: string, date = '2026-09-01', dimension = 'business') =>
  orgVersion(w, id, { startDate: date }, { [dimension]: undefined });

describe('AC-APV-F318c DEC-696 历史接续', () => {
  for (const [type, dimension] of extensions) {
    it(`${type} 跳过一层；真实 HTTP 派给上级，诊断列出退出节点且候选不复活`, async () => {
      const w = await relationWorld(database().db, `h1-${type}`);
      await chain(w, dimension);
      await exit(w, w.root, '2026-09-01', dimension);
      const value = source(type, w.child);
      const observed = await observe(w, value);
      expect.soft(observed.users).toEqual([w.head.userId]);
      expect.soft(observed.diagnostics).toContainEqual({
        startId: w.child,
        skippedOrgIds: [w.root],
        reason: 'resolved',
      });
      const candidates = await w.json<{ items: unknown[] }>(
        await w.request(
          w.hr.id,
          'GET',
          `/api/tenant/approval/designer/source-candidates?type=${type}&asOf=2026-10-01&ids=${w.root}&includeInactive=true`,
        ),
      );
      expect(candidates.items).toEqual([]);
      expect(await resolved(w, source(type, w.root))).toEqual([]);
      const process = await w.publishedProcess({ nodes: [{ key: 'one', approver: value }] });
      const business = await w.application(w.subject.employeeId, { departmentId: w.staff });
      const response = await w.submitRaw(business);
      expect.soft(response.status).toBe(200);
      if (response.status === 200) {
        const run = await w.instanceOf(business.id);
        expect(w.pending(run).map((task) => task.assigneeUserId)).toEqual([w.head.userId]);
        expect(JSON.stringify(run.logs)).not.toContain(w.root);
      }
      // 仿真输入是已展开的虚拟名单，不用真实组织补齐；预览的空人出口与运行相同。
      const preview = await w.json<{ nodes: { approverUserId: string | null }[]; startable: boolean }>(
        await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/simulate`, {
          body: {
            scope: 'published',
            data: {
              values: { processCode: 'TransferProcessNew' },
              sourceRelations: { [`${type}:${w.child}`]: [w.head.userId] },
            },
          },
        }),
      );
      expect(preview.nodes[0]?.approverUserId).toBe(w.head.userId);
      const absent = await w.json<{ startable: boolean }>(
        await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/simulate`, {
          body: { scope: 'published', data: { values: { processCode: 'TransferProcessNew' } } },
        }),
      );
      expect(absent.startable).toBe(false);
      expect(JSON.stringify(absent)).not.toContain(w.head.userId);
      expect(JSON.stringify(absent)).not.toContain(w.root);
    });
  }
  it('连续跳过多层、不设固定深度上限；不取退出节点的负责人', async () => {
    const w = await relationWorld(database().db, 'h1-deep');
    await chain(w);
    let parent = w.tenant.id;
    const skipped: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await w.org(`合成历史层${i}`);
      await orgVersion(w, id, { personInChargeId: w.near.employeeId }, { business: parent });
      await exit(w, id);
      skipped.unshift(id);
      parent = id;
    }
    await orgVersion(w, w.child, {}, { business: parent });
    expect(await observe(w, source('business_org', w.child))).toEqual({
      users: [w.head.userId],
      diagnostics: [{ startId: w.child, skippedOrgIds: skipped, reason: 'resolved' }],
    });
  });
  it('业务日已退出而当前又回来，以及业务日仍在而当前退出，均不读取未来关系', async () => {
    const w = await relationWorld(database().db, 'h1-date');
    await chain(w);
    await exit(w, w.root, '2026-08-01');
    await orgVersion(w, w.root, { startDate: '2026-09-01' }, { business: w.staff });
    await exit(w, w.root, '2026-10-01');
    expect(await resolved(w, source('business_org', w.child), '2026-08-15')).toEqual([w.head.userId]);
    expect(await resolved(w, source('business_org', w.child), '2026-09-15')).toEqual([w.near.userId]);
    // 最近一次成员关系指向 staff；它从未属于此维度，不得跳过它猜租户根。
    expect(await resolved(w, source('business_org', w.child))).toEqual([]);
  });
  it('同日较高修订撤销旧边，不复活；更早规范版本仍可接续', async () => {
    const w = await relationWorld(database().db, 'h1-canonical');
    await chain(w);
    await orgVersion(w, w.staff, { personInChargeId: w.near.employeeId }, { business: w.tenant.id });
    await orgVersion(w, w.root, { startDate: '2026-08-01' }, { business: w.staff });
    await exit(w, w.root, '2026-08-01');
    expect(await resolved(w, source('business_org', w.child))).toEqual([w.head.userId]);
    // 初始日期的唯一旧边也被同日修订覆盖时，整个历史都没有可选边。
    const middle = await w.org('合成同日首次加入');
    await orgVersion(w, middle, {}, { business: w.staff });
    await orgVersion(w, middle, {}, { business: undefined });
    await orgVersion(w, w.child, {}, { business: middle });
    expect(await observe(w, source('business_org', w.child))).toEqual({
      users: [],
      diagnostics: [{ startId: w.child, skippedOrgIds: [middle], reason: 'broken_chain' }],
    });
  });
  it('退出前多次改挂，取业务日前最近那次，不取最早或未来那次', async () => {
    const w = await relationWorld(database().db, 'h1-reparent');
    await chain(w);
    await orgVersion(w, w.staff, { personInChargeId: w.near.employeeId }, { business: w.tenant.id });
    await orgVersion(w, w.root, { startDate: '2026-07-01' }, { business: w.staff });
    await exit(w, w.root, '2026-08-01');
    await orgVersion(w, w.root, { startDate: '2026-11-01' }, { business: w.tenant.id });
    expect(await observe(w, source('business_org', w.child))).toEqual({
      users: [w.near.userId],
      diagnostics: [{ startId: w.child, skippedOrgIds: [w.root], reason: 'resolved' }],
    });
  });
  for (const boundary of ['root_empty', 'cycle', 'null_parent', 'never_member', 'foreign_root'] as const) {
    it(`${boundary} 终止且真实首节点走既有空人拒绝，无实例和 500`, async () => {
      const w = await relationWorld(database().db, `h1-${boundary}`);
      await chain(w);
      if (boundary === 'root_empty') await w.setOrgRoles(w.tenant.id, { head: null });
      if (boundary === 'cycle') await orgVersion(w, w.root, {}, { business: w.child });
      if (boundary === 'null_parent') await orgVersion(w, w.root, {}, { business: null });
      if (boundary === 'never_member') await orgVersion(w, w.child, {}, { business: w.staff });
      await exit(w, w.root);
      const foreign = boundary === 'foreign_root' ? await relationWorld(w.db, 'h1-other-tenant') : null;
      if (foreign) await chain(foreign);
      const value = source('business_org', foreign?.child ?? w.child);
      const observation = await observe(w, value);
      expect(observation.users).toEqual([]);
      if (boundary !== 'foreign_root')
        expect(observation.diagnostics).toContainEqual({
          startId: w.child,
          skippedOrgIds: [boundary === 'never_member' ? w.staff : w.root],
          reason: ['cycle', 'root_empty'].includes(boundary) ? boundary : 'broken_chain',
        });
      if (boundary === 'foreign_root') return;
      await w.publishedProcess({ nodes: [{ key: 'one', approver: source('business_org', w.child) }] });
      const business = await w.application(w.subject.employeeId, { departmentId: w.staff });
      const response = await w.submitRaw(business);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' },
      });
      expect(await w.instanceOfAll(business.id)).toEqual([]);
    });
  }
});
