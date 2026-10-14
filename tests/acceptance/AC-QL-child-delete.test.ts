/**
 * 删除父对象时的子对象（DEC-019 删除留快照；开发自检 DEC-338 服务端规则“删除父对象时，要对每类子对象分别校验删除权，
 * 并为子对象各写删除审计和快照”）：
 * - 删除任职资格标准会连带删除它的发展通道（对象 Qualification.DevelopmentChannel）；
 * - 删除指标会连带删除手改过的指标等级描述（对象 Qualification.TargetGradeDescription）。
 * 有这类子对象时，操作人还须有子对象的删除权，否则 403、什么都不删；有权时删除成功并为子对象另写一条删除审计。
 */
import { sql, withTenant } from '@italent/db';
import { codeOf } from '../../apps/api/src/modules/qualification/access.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { qualificationWorld, type StandardView, type TargetView } from './AC-QL-support.js';

const testDb = useTestDb();

/** 只拒绝指定子对象的删除权，其余全部允许。 */
const denyDelete =
  (resource: string): Authorizer =>
  (request) =>
    !(request.action === 'object.delete' && request.resource === resource);

/** 子对象的删除审计快照（before）。 */
async function deleteSnapshots(tenantId: string, objectType: string, objectId: string) {
  return withTenant(testDb().db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT before FROM audit_events
      WHERE tenant_id = ${tenantId}::uuid AND object_type = ${objectType} AND object_id = ${objectId}
        AND action LIKE '%.delete'`);
    return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { before: unknown }[]).map(
      (row) => row.before,
    );
  });
}

async function standardWithChannel(label: string, authorize?: Authorizer) {
  const w = await qualificationWorld(testDb().db, label, authorize ? { authorize } : {});
  const klass = await w.categoryClass();
  const category = await w.category(klass.id);
  const other = await w.category(klass.id);
  const level = await w.level(10);
  const standard = await w.standard({ categoryId: category.id, levelIds: [level.id], details: [] });
  const put = await w.request('PUT', `/standards/${standard.id}/channels`, {
    ifMatch: standard.revision,
    body: { channels: [{ levelId: level.id, targetCategoryId: other.id, targetLevelId: level.id }] },
  });
  await w.ok(put);
  const current = await w.read<StandardView>(`/standards/${standard.id}`);
  return { w, standard: current, other };
}

async function targetWithManualDescription(label: string, authorize?: Authorizer) {
  const w = await qualificationWorld(testDb().db, label, authorize ? { authorize } : {});
  const type = await w.targetType();
  const scheme = await w.gradeScheme([{ name: '初级', grade: 1, description: '明细描述' }]);
  const target = await w.target(type.id, { evalMode: 'grade', gradeSchemeId: scheme.id });
  await w
    .request('PUT', `/targets/${target.id}/grade-descriptions/${scheme.details[0]!.id}`, {
      ifMatch: target.revision,
      body: { description: '手改' },
    })
    .then((r) => w.ok(r));
  return { w, target: await w.read<TargetView>(`/targets/${target.id}`) };
}

describe('DEC-019 删除标准连带发展通道', () => {
  it('没有发展通道删除权：403，标准与通道都在', async () => {
    const { w, standard } = await standardWithChannel('ql-del-ch-deny', denyDelete(codeOf('developmentChannel')));
    const response = await w.request('DELETE', `/standards/${standard.id}`, { ifMatch: standard.revision });
    expect(response.status, await response.clone().text()).toBe(403);
    expect((await w.request('GET', `/standards/${standard.id}`)).status).toBe(200);
    const channels = await w.read<{ horizontal: unknown[] }>(`/standards/${standard.id}/channels`);
    expect(channels.horizontal).toHaveLength(1);
  });

  it('有删除权：删除成功，发展通道另写一条删除审计', async () => {
    const { w, standard, other } = await standardWithChannel('ql-del-ch-ok');
    const response = await w.request('DELETE', `/standards/${standard.id}`, { ifMatch: standard.revision });
    expect(response.status, await response.clone().text()).toBe(200);
    const snapshots = await deleteSnapshots(w.tenant.id, codeOf('developmentChannel'), standard.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ standardId: standard.id, targetCategoryId: other.id });
  });
});

describe('DEC-019 删除指标连带手改的指标等级描述', () => {
  it('没有指标等级描述删除权：403，指标与手改描述都在', async () => {
    const { w, target } = await targetWithManualDescription(
      'ql-del-tgd-deny',
      denyDelete(codeOf('targetGradeDescription')),
    );
    const response = await w.request('DELETE', `/targets/${target.id}`, { ifMatch: target.revision });
    expect(response.status, await response.clone().text()).toBe(403);
    const items = await w.read<{ items: { modified: boolean }[] }>(`/targets/${target.id}/grade-descriptions`);
    expect(items.items[0]).toMatchObject({ modified: true });
  });

  it('有删除权：删除成功，指标等级描述另写一条删除审计', async () => {
    const { w, target } = await targetWithManualDescription('ql-del-tgd-ok');
    const response = await w.request('DELETE', `/targets/${target.id}`, { ifMatch: target.revision });
    expect(response.status, await response.clone().text()).toBe(200);
    const snapshots = await deleteSnapshots(w.tenant.id, codeOf('targetGradeDescription'), target.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ targetId: target.id, description: '手改' });
  });
});
