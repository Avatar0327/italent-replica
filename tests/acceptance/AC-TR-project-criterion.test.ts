/** B7b：人才标准引用同事务检查 / 保存，并与删除共用来源行锁。 */
import { randomUUID } from 'node:crypto';
import { withTenant, eq, auditEvents, talentCriteria, talentReviewProjects as P } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { talentWorld } from './AC-TC-support.js';
import { createProject } from '../../apps/api/src/modules/talent-review/project-service.js';
import { projectCreate } from '../../apps/api/src/modules/talent-review/project-input.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { TR_NOW, TR_BASE } from './AC-TR-support.js';
import { waitForBlocked } from './support/pg-interleave.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const body = (ownerOrgId: string, criterionId: string) => ({
  code: `prj_${uniqueSuffix()}`,
  name: '合成标准引用项目',
  ownerOrgId,
  criterionId,
  year: 2026,
  period: '年度',
  periodStartDate: '2026-01-01',
  periodEndDate: '2026-12-31',
  matrices: [],
});
async function fixture(label: string) {
  const w = await talentWorld(testDb().db, label);
  const c = await w.criterion((await w.category()).id, []);
  const create = (criterionId = c.id) =>
    w.api.request('POST', `${TR_BASE}/projects`, {
      ...w.as,
      ifMatch: 0,
      body: body(w.orgId, criterionId),
    });
  const list = async () => await (await w.api.request('GET', `${TR_BASE}/projects`, w.as)).json();
  return { w, c, create, list };
}
describe('AC-TR-project-criterion', () => {
  it('存在且启用的租户内标准保存；缺失、跨租户、停用 400；引用拒删 409；解除后能删', async () => {
    const { w, c, create, list } = await fixture('project-criterion');
    const other = await fixture('project-foreign-criterion');
    const disabled = await w.criterion((await w.category('停用分类')).id, [], { name: '停用标准', enabled: false });
    for (const id of [randomUUID(), other.c.id, disabled.id]) {
      const res = await create(id);
      expect(res.status, await res.clone().text()).toBe(400);
      expect(await res.json()).toMatchObject({ error: { details: { reason: 'CRITERION_NOT_REFERENCEABLE' } } });
      expect(await list()).toMatchObject({ items: [] });
    }
    const res = await create(c.id.toUpperCase());
    expect(res.status, await res.clone().text()).toBe(201);
    const p = (await res.json()) as { id: string; revision: number; criterionId: string };
    expect(p.criterionId).toBe(c.id);
    const audits = () =>
      withTenant(testDb().db, w.as.tenant, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.objectId, c.id)));
    const beforeAudits = await audits();
    const changed = await w.request('PATCH', `/criteria/${c.id}`, {
      ifMatch: c.revision,
      body: { enabled: false, name: '不应保存的属性修改' },
    });
    expect(changed.status, await changed.clone().text()).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { details: { reason: 'CRITERION_DISABLE_BREAKS_PROJECT' } } });
    expect(await audits()).toEqual(beforeAudits);
    const renamed = await w.request('PATCH', `/criteria/${c.id}`, {
      ifMatch: c.revision,
      body: { name: '允许改名的已引用标准' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const current = (await renamed.json()) as { revision: number };
    const removed = await w.request('DELETE', `/criteria/${c.id}`, { ifMatch: current.revision });
    expect(removed.status, await removed.clone().text()).toBe(409);
    expect(await removed.json()).toMatchObject({ error: { details: { reason: 'CRITERION_REFERENCED' } } });
    expect(await w.read(`/criteria/${c.id}`)).toMatchObject({ id: c.id, enabled: true });
    expect(await list()).toMatchObject({ items: [p] });
    expect(
      (
        await w.api.request('PATCH', `${TR_BASE}/projects/${p.id}`, {
          ...w.as,
          ifMatch: p.revision,
          body: { criterionId: null },
        })
      ).status,
    ).toBe(200);
    expect(
      (await w.request('PATCH', `/criteria/${c.id}`, { ifMatch: current.revision, body: { enabled: false } })).status,
    ).toBe(200);
    expect((await w.request('DELETE', `/criteria/${c.id}`, { ifMatch: current.revision + 1 })).status).toBe(200);
  });

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：项目引用先写未提交，删除等待后读到引用返回 409',
    async () => {
      const { w, c } = await fixture('project-criterion-reference-first');
      const { pending, project } = await withTenant(testDb().db, w.as.tenant, async (tx) => {
        const scope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
        const project = await createProject(
          tx,
          {
            tenantId: w.as.tenant,
            userId: w.as.user,
            timezone: 'Asia/Shanghai',
            now: TR_NOW,
            commandId: randomUUID(),
            expectedRevision: 0,
            scope,
            referenceScopes: {},
          },
          projectCreate.parse(body(w.orgId, c.id)),
        );
        const pending = w.request('DELETE', `/criteria/${c.id}`, { ifMatch: c.revision });
        await waitForBlocked(testDb().db, 1);
        return { pending, project };
      });
      expect((await pending).status).toBe(409);
      expect(await w.read(`/criteria/${c.id}`)).toMatchObject({ id: c.id });
      expect(
        await withTenant(testDb().db, w.as.tenant, (tx) => tx.select().from(P).where(eq(P.id, project.id))),
      ).toHaveLength(1);
    },
  );

  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    '真 PG：删除先持排他锁，项目保存等待提交后返回 400 且无项目',
    async () => {
      const { w, c, create, list } = await fixture('project-criterion-delete-first');
      const { pending } = await withTenant(testDb().db, w.as.tenant, async (tx) => {
        await tx.delete(talentCriteria).where(eq(talentCriteria.id, c.id));
        const pending = create();
        await waitForBlocked(testDb().db, 1);
        return { pending };
      });
      const res = await pending;
      expect(res.status, await res.clone().text()).toBe(400);
      expect(await res.json()).toMatchObject({ error: { details: { reason: 'CRITERION_NOT_REFERENCEABLE' } } });
      expect(await list()).toMatchObject({ items: [] });
      expect((await w.request('GET', `/criteria/${c.id}`)).status).toBe(404);
    },
  );
});
