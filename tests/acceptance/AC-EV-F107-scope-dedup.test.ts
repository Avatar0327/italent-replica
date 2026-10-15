/** F-107 / DEC-455④：活动权限按去重组织数计上限，覆盖真实授权器、事务内复核与重放。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { EVALUATION_APP, EVALUATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { scopeRows, type ScopeRoot } from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import {
  ACTIVITIES,
  activityFixtures,
  activityOperator,
  activityWorld,
  type ActivityFixtures,
  type ActivityOperator,
  type ActivityView,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { errorOf, ok } from './AC-EV-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const OBJECT = EVALUATION_OBJECTS.evaluationActivity.code;
const DEPTH = 10;
const LEAVES = 2100;
const LIMIT = 20_000;

describe('AC-EV-F107 活动权限范围去重计数（DEC-455④）', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  let op: ActivityOperator;
  let chain: string[];
  let existing: ActivityView;
  let outside: ActivityView;
  let scopeRevision = 0;
  let policyRevision = 0;

  async function setRoots(roots: ScopeRoot[]) {
    const mou = await ok<{ id: string }>(
      await w.api.request('POST', '/api/tenant/permission/mous', {
        ...w.asAdmin,
        ifMatch: 0,
        body: { code: `F107_${uniqueSuffix()}`, name: '去重范围管理单元', orgRanges: roots },
      }),
      201,
    );
    const saved = await ok<{ revision: number }>(
      await w.api.request('PUT', `/api/tenant/permission/scopes/${op.userId}/${EVALUATION_APP}`, {
        ...w.asAdmin,
        ifMatch: scopeRevision,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
    scopeRevision = saved.revision;
  }
  const roots = (ids: string[], dimension = 'admin') =>
    ids.map((orgId) => ({ orgId, dimension, includeDescendants: true }));
  async function policy(dimension: 'management' | 'organization') {
    const saved = await ok<{ revision: number }>(
      await w.api.request('PUT', `/api/tenant/permission/scope-policies/${EVALUATION_APP}/${OBJECT}/entity/${OBJECT}`, {
        ...w.asAdmin,
        ifMatch: policyRevision,
        body: { rules: [{ dimension, ...(dimension === 'organization' ? { roleCode: 'head' } : {}) }] },
      }),
    );
    policyRevision = saved.revision;
  }
  async function resolved() {
    return withTenant(database().db, w.tenant.id, (tx) =>
      resolveDataScope(tx, {
        tenantId: w.tenant.id,
        userId: op.userId,
        appCode: EVALUATION_APP,
        objectCode: OBJECT,
        asOf: '2026-10-01',
      }),
    );
  }
  /** 批量合成组织，避免通过组织 API 为每个叶子重复重建树；全部在本测试隔离库内。 */
  async function leaves(parent: string, label: string, count: number, dimensions: string[]) {
    await w.asOwner(async (run) => {
      const tid = w.tenant.id;
      await run(sql`INSERT INTO org_objects(id,tenant_id)
        SELECT md5(${tid}||${label}||g)::uuid,${tid} FROM generate_series(1,${count}) g`);
      await run(sql`INSERT INTO org_versions(id,tenant_id,org_id,version_no,start_date,code,name,full_name)
        SELECT md5(${tid}||${label}||'v'||g)::uuid,${tid},md5(${tid}||${label}||g)::uuid,1,'2025-01-01',
        ${label}||g,'合成组织'||g,'合成组织'||g FROM generate_series(1,${count}) g`);
      // 批量造数后刷新统计，避免逐行排序触发器沿用小表计划反复全表扫描。
      await run(sql`ANALYZE org_objects`);
      await run(sql`ANALYZE org_versions`);
      for (const dimension of dimensions) {
        await run(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
          SELECT ${tid},md5(${tid}||${label}||'v'||g)::uuid,${dimension},${parent}::uuid
          FROM generate_series(1,${count}) g`);
      }
      await run(sql`ANALYZE org_hierarchy_links`);
    });
  }

  beforeAll(async () => {
    w = await activityWorld(database().db);
    f = await activityFixtures(w);
    op = await activityOperator(w, { personOrgs: [w.orgA] });
    existing = await w.adminActivity(f.body());
    outside = await w.adminActivity(f.body({ ownerOrgId: w.orgB, orgRange: f.orgs(w.orgB) }));
    chain = [w.orgA];
    for (let i = 1; i < DEPTH; i++) chain.push(await w.childOrg(chain[i - 1]!));
    await w.asOwner(async (run) => {
      const person = randomUUID();
      await run(sql`INSERT INTO employment_employees(id,tenant_id,code,name)
        VALUES (${person}::uuid,${w.tenant.id},'F107_HEAD','合成负责人')`);
      await run(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
        VALUES (${w.tenant.id},${op.userId}::uuid,${person}::uuid)`);
      // 追加组织版本，把同一操作人设为链上各根的负责人，验证组织角色规则同样去重。
      for (const orgId of chain) {
        const version = randomUUID();
        await run(sql`INSERT INTO org_versions
          SELECT (jsonb_populate_record(NULL::org_versions, to_jsonb(v) || jsonb_build_object(
            'id',${version}::uuid,'version_no',v.version_no+1,'previous_version_id',v.id,
            'start_date','2025-12-01'::date,'person_in_charge_id',${person}::uuid))).*
          FROM org_versions v WHERE v.tenant_id=${w.tenant.id} AND v.org_id=${orgId}::uuid
          ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1`);
        await run(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id,sequence)
          SELECT h.tenant_id,${version}::uuid,h.dimension,h.parent_org_id,h.sequence
          FROM org_hierarchy_links h JOIN org_versions v ON v.previous_version_id=h.version_id
          WHERE v.tenant_id=${w.tenant.id} AND v.id=${version}::uuid`);
      }
      await run(sql`UPDATE org_settings SET business_enabled=true WHERE tenant_id=${w.tenant.id}`);
    });
    await leaves(chain[DEPTH - 1]!, 'F107small', LEAVES, ['admin']);
    await leaves(w.orgB, 'F107large', LIMIT - 1, ['admin', 'business']);
  }, 120_000);

  it('AC-EV-F107 管理范围 21,055 行 / 2,110 个组织：列表、详情、新建、修改、重放和删除均成功', async () => {
    await setRoots(roots(chain));
    const listed = await ok<{ items: ActivityView[] }>(await op.request('GET', ACTIVITIES));
    const scope = await resolved();
    expect(scope.all).toBe(false);
    expect(scope.orgIds).toHaveLength(DEPTH + LEAVES);
    expect(DEPTH * LEAVES + (DEPTH * (DEPTH + 1)) / 2).toBeGreaterThan(LIMIT);
    expect(listed.items.map((item) => item.id)).toEqual([existing.id]);
    expect((await ok<ActivityView>(await op.request('GET', `${ACTIVITIES}/${existing.id}`))).name).toBe(existing.name);
    const body = f.body();
    const key = randomUUID();
    const create = () => op.request('POST', ACTIVITIES, { ifMatch: 0, idempotencyKey: key, body });
    const created = await ok<ActivityView>(await create(), 201);
    expect(created.chains.find((item) => item.type === 'defense')?.formId).toBe(f.form1.id);
    expect(await ok(await create(), 201)).toEqual(created);
    const changed = await ok<ActivityView>(
      await op.request('PATCH', `${ACTIVITIES}/${created.id}`, {
        ifMatch: created.revision,
        body: { name: '去重后修改' },
      }),
    );
    expect(changed.name).toBe('去重后修改');
    expect(changed.revision).toBe(created.revision + 1);
    await ok(await op.request('DELETE', `${ACTIVITIES}/${created.id}`, { ifMatch: changed.revision }));
    expect((await op.request('GET', `${ACTIVITIES}/${created.id}`)).status).toBe(404);
  });

  it('AC-EV-F107 去重后仍按真实组织范围裁剪，范围外读写 404 且业务值不变', async () => {
    await setRoots(roots(chain));
    const before = await w.adminRead(outside.id);
    expect((await op.request('GET', `${ACTIVITIES}/${outside.id}`)).status).toBe(404);
    const denied = await op.request('PATCH', `${ACTIVITIES}/${outside.id}`, {
      ifMatch: outside.revision,
      body: { name: '不可写入' },
    });
    expect(denied.status, await denied.clone().text()).toBe(404);
    expect(await errorOf(denied)).toMatchObject({ code: 'NOT_FOUND' });
    expect(await w.adminRead(outside.id)).toEqual(before);
  });

  it('AC-EV-F107 组织负责人规则的重叠根也按 2,110 个组织计数，事务内写复核不再 413', async () => {
    await setRoots(roots(chain));
    await policy('organization');
    try {
      expect((await resolved()).orgIds).toHaveLength(DEPTH + LEAVES);
      const changed = await ok<ActivityView>(
        await op.request('PATCH', `${ACTIVITIES}/${existing.id}`, {
          ifMatch: existing.revision,
          body: { name: '负责人范围去重' },
        }),
      );
      expect(changed.name).toBe('负责人范围去重');
    } finally {
      await policy('management');
    }
  });

  it('AC-EV-F107 跨行政 / 业务维度共 40,000 行但恰好 20,000 个组织，完整返回且允许读取', async () => {
    await setRoots([...roots([w.orgB]), ...roots([w.orgB], 'business')]);
    const scope = await resolved();
    expect(scope.orgIds).toHaveLength(LIMIT);
    expect(new Set(scope.orgIds).size).toBe(LIMIT);
    expect(scope.orgIds).toContain(w.orgB);
    expect((await ok<ActivityView>(await op.request('GET', `${ACTIVITIES}/${outside.id}`))).name).toBe(outside.name);
  });

  it('AC-EV-F107 去重后 20,001 个组织仍 413，不能在维度去重前截断而漏掉深层组织', async () => {
    await w.asOwner(async (run) => {
      // 第 20,001 个组织放到第二层；提前 LIMIT 会漏掉它，不能因此错误放行。
      await run(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
        SELECT ${w.tenant.id},id,'business',md5(${w.tenant.id}||'F107large'||'1')::uuid
        FROM org_versions WHERE tenant_id=${w.tenant.id} AND org_id=${w.orgC}::uuid`);
    });
    await setRoots([...roots([w.orgB]), ...roots([w.orgB], 'business')]);
    const snapshot = () =>
      withTenant(database().db, w.tenant.id, async (tx) =>
        scopeRows(
          await tx.execute(sql`SELECT id,name,revision FROM ev_activities
        WHERE tenant_id=${w.tenant.id} ORDER BY id`),
        ),
      );
    const before = await snapshot();
    const key = randomUUID();
    for (const response of [
      await op.request('GET', ACTIVITIES),
      await op.request('GET', `${ACTIVITIES}/${outside.id}`),
      await op.request('POST', ACTIVITIES, { ifMatch: 0, idempotencyKey: key, body: f.body() }),
      await op.request('PATCH', `${ACTIVITIES}/${outside.id}`, {
        ifMatch: outside.revision,
        body: { name: '超限不可写入' },
      }),
      await op.request('DELETE', `${ACTIVITIES}/${outside.id}`, { ifMatch: outside.revision }),
    ]) {
      expect(response.status, await response.clone().text()).toBe(413);
      expect(await errorOf(response)).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    }
    expect(await snapshot()).toEqual(before);
    const ledger = await withTenant(database().db, w.tenant.id, async (tx) =>
      scopeRows(
        await tx.execute(sql`SELECT command_id FROM command_ledger
        WHERE tenant_id=${w.tenant.id} AND command_id=${key}`),
      ),
    );
    expect(ledger).toEqual([]);
  });
});
