/**
 * AC-ESIGN-F505-15（S1 部分，设计 §4.1、§12）：Offer 物理删除不能带走签署历史——只验库级约束：
 * 锚点标记 deleted_at 后才允许删 Offer；漏标记的裸删除、仍有 signing 任务的裸删除被触发器拒绝；锚点禁止删除；
 * 无锚点的旧业务照常删除。签署的同事务撤销、已完成文件保留的业务流留 S3（本片没有发起路由）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf, sourceWorld, sqlState, type SourceWorld } from './AC-ESIGN-F505-support.js';

const db = useTestDb();

const deleteOffer = (w: SourceWorld, offerId: string) =>
  sqlState(() =>
    withTenant(db().db, w.tenantId, (tx) => tx.execute(sql`DELETE FROM offers WHERE id = ${offerId}::uuid`)),
  );
const mark = (w: SourceWorld, offerId: string) =>
  withTenant(db().db, w.tenantId, (tx) =>
    tx.execute(sql`UPDATE esign_offer_sources SET deleted_at = now() WHERE offer_id = ${offerId}::uuid`),
  );
const offerExists = async (w: SourceWorld, offerId: string) =>
  rowsOf(
    await withTenant(db().db, w.tenantId, (tx) => tx.execute(sql`SELECT 1 FROM offers WHERE id = ${offerId}::uuid`)),
  ).length === 1;

describe('AC-ESIGN-F505-15 Offer 物理删除的库级约束', () => {
  it('有锚点但未标记：裸删除被拒绝，Offer 与锚点都在', async () => {
    const w = await sourceWorld(db().db, 'del-unmarked');
    const offerId = await w.offer();
    await w.anchor(offerId);
    expect(await deleteOffer(w, offerId)).not.toBe('ok');
    expect(await offerExists(w, offerId)).toBe(true);
    expect(await w.anchorCount()).toBe(1);
  });

  it('已标记但仍有 signing 任务：裸删除被拒绝；任务撤销后可删，已完成 / 已撤销任务与锚点留存', async () => {
    const w = await sourceWorld(db().db, 'del-signing');
    const offerId = await w.offer();
    await w.anchor(offerId);
    const employeeId = w.person.employee.id;
    const seed = { scene: 'offer', offerId, employeeId, sourceRevision: 1 } as const;
    await w.task({ ...seed, status: 'completed' });
    const signing = await w.task(seed);
    await mark(w, offerId);
    expect(await deleteOffer(w, offerId)).not.toBe('ok');
    expect(await offerExists(w, offerId)).toBe(true);
    await withTenant(db().db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE esign_tasks SET status='revoked', current_node=NULL, revoked_at=now(),
        revoke_cause='business_deleted' WHERE id = ${signing}::uuid`),
    );
    expect(await deleteOffer(w, offerId)).toBe('ok');
    expect(await offerExists(w, offerId)).toBe(false);
    expect(await w.taskCount()).toBe(2);
    expect(await w.anchorCount()).toBe(1);
  });

  it('锚点禁止物理删除；无锚点的旧 Offer 照常删除', async () => {
    const w = await sourceWorld(db().db, 'del-anchor');
    const offerId = await w.offer();
    await w.anchor(offerId);
    await mark(w, offerId);
    const anchorDelete = await sqlState(() =>
      withTenant(db().db, w.tenantId, (tx) => tx.execute(sql`DELETE FROM esign_offer_sources`)),
    );
    expect(anchorDelete).not.toBe('ok');
    expect(await w.anchorCount()).toBe(1);
    expect(await deleteOffer(w, await w.offer())).toBe('ok');
  });

  it('锚点只能指向本租户真实存在的 Offer', async () => {
    const w = await sourceWorld(db().db, 'anchor-missing');
    const ghost = '00000000-0000-4000-8000-00000000f505';
    expect(await sqlState(() => w.anchor(ghost))).not.toBe('ok');
    expect(await w.anchorCount()).toBe(0);
  });
});
