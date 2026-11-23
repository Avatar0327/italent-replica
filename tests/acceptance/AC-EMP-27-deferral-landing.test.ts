/**
 * AC-EMP-27（F-036 S6，设计 §4.4.2 写点 #16 / §7.1）：延迟继承三种形态——部门延迟 / 职位单独延迟 / 都延迟。
 * 落地为每个没有有效覆盖值的延迟字段记一条 resolved（值、前驱记录、本单记录），部门先于职位，不追加载荷版本；
 * 策略行在后续写入之后仍在，deferralShape 不变。
 */
import { withTenant } from '@italent/db';
import { deferralShape } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import {
  createTransfer,
  deferralWorld,
  ledger,
  patchBusiness,
  submitBusiness,
  payloadVersions,
  type DeferralWorld,
  type Shape,
} from './AC-EMP-27-deferral-support.js';
import { transferDeferredExcept } from './AC-EMP-26-projection-support.js';

const database = useTestDb();

/** 调动必填部门，HR 总会填部门（覆盖值有效，不解析）；其余延迟字段按形态解析，职位只在延迟时解析。 */
function expectedResolved(shape: Shape) {
  if (shape === 'position') return ['preset:positionId'];
  // 岗位 / 职级 / 职等 / 序列由职位带出，策略行是 none（不继承，也就没有延迟解析）
  const derived = ['preset:postId', 'preset:levelId', 'preset:gradeId', 'preset:sequenceId'];
  return transferDeferredExcept(...derived, ...(shape === 'both' ? [] : ['preset:positionId']));
}

async function states(w: DeferralWorld, businessId: string) {
  return withTenant(w.db, w.session.tenant.id, (tx) =>
    loadFieldOrigins(tx, { tenantId: w.session.tenant.id }, businessId),
  );
}

const resolvedRows = async (w: DeferralWorld, id: string) => (await ledger(w, id)).filter((r) => r.kind === 'resolved');

describe('AC-EMP-27 落地写 resolved（写点 #16）', () => {
  it.each(['both', 'department', 'position'] as const)(
    '%s：直接调动落地，为每个延迟字段记解析值与前驱',
    async (shape) => {
      const w = await deferralWorld(database().db, `f036s6-land-${shape}`, shape);
      const transfer = await createTransfer(w, 'direct', '2026-10-05', { departmentId: w.from.id });
      expect(await payloadVersions(w, transfer.id)).toEqual([1]);
      expect(deferralShape(await states(w, transfer.id))).toBe(shape);

      const rows = await resolvedRows(w, transfer.id);
      expect(rows.map((r) => r.field).sort()).toEqual(expectedResolved(shape));
      for (const row of rows) expect(row).toMatchObject({ source: w.hire.id, record: transfer.id, version: 1 });
      const value = (field: string) => rows.find((r) => r.field === field)?.value;
      expect(value('preset:place')).toBe(shape === 'position' ? undefined : '原地点');
      expect(value('preset:positionId')).toBe(shape === 'department' ? undefined : w.position.id);
      // 落地不追加载荷版本，策略行与形态保持；部门有 HR 覆盖值，不写解析行
      expect(await payloadVersions(w, transfer.id)).toEqual([1]);
      expect(deferralShape(await states(w, transfer.id))).toBe(shape);
      const department = (await states(w, transfer.id)).get('preset:departmentId');
      expect(department).toMatchObject({ resolved: null });
      expect(department?.lastWriter?.originKind).toBe('hr-input');
    },
  );
});

describe('AC-EMP-27 申请路径：写入之后策略行仍在，落地取落地时的前驱', () => {
  it('申请被改一版、前驱被改后才落地：形态不变，resolved 取落地时前驱的值，只追加用户改动的载荷版本', async () => {
    const w = await deferralWorld(database().db, 'f036s6-land-application', 'both');
    const draft = await createTransfer(w, 'application', '2026-11-01', { departmentId: w.from.id });
    expect(deferralShape(await states(w, draft.id))).toBe('both');
    // 备注只在草稿上改一版；再改前驱记录（向后更新路径）
    const noted = await patchBusiness(w, draft.id, { fields: { remarks: '只改备注' } });
    expect(noted.status, await noted.clone().text()).toBe(200);
    const edit = await w.session.request('PATCH', `/records/${w.hire.id}`, {
      ifMatch: w.hire.revision,
      body: { fields: { place: '新地点' } },
    });
    expect(edit.status, await edit.clone().text()).toBe(200);
    expect(deferralShape(await states(w, draft.id))).toBe('both');
    expect((await states(w, draft.id)).get('preset:place')).toMatchObject({ policy: 'deferred', resolved: null });
    const versions = await payloadVersions(w, draft.id);
    await submitBusiness(w, draft.id);
    await w.approve(draft, '2026-10-01T02:00:00Z');
    expect(await resolvedRows(w, draft.id)).toEqual([]);

    const run = await w.runScheduler('2026-11-01T01:00:00Z');
    expect(run).toMatchObject({ activated: [draft.id], failed: [] });
    // 保护性：记录本身取落地时前驱的值（S3 之后在 main 上已成立）
    expect((await w.session.record(draft.id, '2026-11-01')).fields).toMatchObject({ place: '新地点' });
    // 红：落地解析结果必须留下，值取自落地时的前驱记录
    const rows = await resolvedRows(w, draft.id);
    expect(rows.find((r) => r.field === 'preset:place')).toMatchObject({ value: '新地点', source: w.hire.id });
    expect(rows.every((r) => r.record === draft.id)).toBe(true);
    expect(deferralShape(await states(w, draft.id))).toBe('both');
    expect(await payloadVersions(w, draft.id)).toEqual(versions);
  });
});
