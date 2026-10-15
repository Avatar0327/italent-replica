/** F-161 / DEC-516：负责人自助身份判定不展开组织；负责组织按去重组织数计上限，上限语义不变（比照 F-107）。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { EVALUATION_APP } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/errors.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { managerIdentity, managerIdentityWithOrgs } from '../../apps/api/src/modules/permission/manager-identity.js';
import type { ScopeRoot } from '../../apps/api/src/modules/permission/scope-hierarchy.js';
import { managerReferenceQuery } from '../../apps/api/src/modules/transfer/manager-references.js';
import { managerTeamQuery } from '../../apps/api/src/modules/transfer/manager-team.js';
import {
  ACTIVITIES,
  activityFixtures,
  activityOperator,
  activityWorld,
  type ActivityOperator,
  type ActivityView,
  type ActivityWorld,
} from './AC-EV-activity-support.js';
import { ok } from './AC-EV-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const DEPTH = 10;
const LEAVES = 2100;
const LIMIT = 20_000;
const AS_OF = '2026-10-01';

describe('AC-BE-F161 负责人自助身份展开按去重组织计数（DEC-516）', () => {
  let w: ActivityWorld;
  let op: ActivityOperator;
  let chain: string[];
  let existing: ActivityView;

  const query = () => ({ tenantId: w.tenant.id, userId: op.userId, asOf: AS_OF });
  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(database().db, w.tenant.id, fn);
  /** 经理自助查询只用到租户、用户与租户日期；其余字段与本用例无关。 */
  const managerCtx = () =>
    ({
      tenantId: w.tenant.id,
      userId: op.userId,
      timezone: 'Asia/Shanghai',
      now: new Date(`${AS_OF}T04:00:00Z`),
      commandId: randomUUID(),
      expectedRevision: 0,
    }) satisfies EmploymentContext;
  async function tooLarge(run: () => Promise<unknown>) {
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  }
  /** 批量合成组织（同 AC-EV-F107），全部在本测试隔离库内。 */
  async function leaves(parent: string, label: string, count: number) {
    await w.asOwner(async (run) => {
      const tid = w.tenant.id;
      await run(sql`INSERT INTO org_objects(id,tenant_id)
        SELECT md5(${tid}||${label}||g)::uuid,${tid} FROM generate_series(1,${count}) g`);
      // 停用叶子仍在负责组织的下级范围内（DEC-146），也避免为两万个叶子重算无关的人员排序号。
      await run(sql`INSERT INTO org_versions(id,tenant_id,org_id,version_no,start_date,code,name,full_name,enabled)
        SELECT md5(${tid}||${label}||'v'||g)::uuid,${tid},md5(${tid}||${label}||g)::uuid,1,'2025-01-01',
        ${label}||g,'合成组织'||g,'合成组织'||g,false FROM generate_series(1,${count}) g`);
      await run(sql`ANALYZE org_objects`);
      await run(sql`ANALYZE org_versions`);
      await run(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id)
        SELECT ${tid},md5(${tid}||${label}||'v'||g)::uuid,'admin',${parent}::uuid
        FROM generate_series(1,${count}) g`);
      await run(sql`ANALYZE org_hierarchy_links`);
    });
  }

  beforeAll(async () => {
    w = await activityWorld(database().db);
    const f = await activityFixtures(w);
    op = await activityOperator(w, { personOrgs: [w.orgA] });
    existing = await w.adminActivity(f.body());
    await w.adminActivity(f.body({ ownerOrgId: w.orgB, orgRange: f.orgs(w.orgB) }));
    // 评定活动的显式范围只给 orgA 本身，与负责人身份无关，排除 F-107 的范围计数干扰。
    const root: ScopeRoot = { orgId: w.orgA, dimension: 'admin', includeDescendants: false };
    const mou = await ok<{ id: string }>(
      await w.api.request('POST', '/api/tenant/permission/mous', {
        ...w.asAdmin,
        ifMatch: 0,
        body: { code: `F161_${uniqueSuffix()}`, name: '仅本组织', orgRanges: [root] },
      }),
      201,
    );
    await ok(
      await w.api.request('PUT', `/api/tenant/permission/scopes/${op.userId}/${EVALUATION_APP}`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
    chain = [w.orgA];
    for (let i = 1; i < DEPTH; i++) chain.push(await w.childOrg(chain[i - 1]!));
    await w.asOwner(async (run) => {
      const person = randomUUID();
      await run(sql`INSERT INTO employment_employees(id,tenant_id,code,name)
        VALUES (${person}::uuid,${w.tenant.id},'F161_HEAD','合成负责人')`);
      await run(sql`INSERT INTO permission_user_person_links(tenant_id,user_id,employee_id)
        VALUES (${w.tenant.id},${op.userId}::uuid,${person}::uuid)`);
      // 一条组织链上每层都由同一人负责：旧口径下每个负责组织各自展开整棵子树，深层组织被重复计数。
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
    });
    await leaves(chain[DEPTH - 1]!, 'F161small', LEAVES);
  }, 120_000);

  it('AC-BE-F161 负责 10 层链 21,055 行 / 2,110 个组织：打开评定活动列表与详情不再被 413', async () => {
    expect(DEPTH * LEAVES + (DEPTH * (DEPTH + 1)) / 2).toBeGreaterThan(LIMIT);
    const listed = await ok<{ items: ActivityView[] }>(await op.request('GET', ACTIVITIES));
    expect(listed.items.map((item) => item.id)).toEqual([existing.id]);
    expect((await ok<ActivityView>(await op.request('GET', `${ACTIVITIES}/${existing.id}`))).name).toBe(existing.name);
  });

  it('AC-BE-F161 身份判定只看是否负责组织 / 有直属下级，不展开组织', async () => {
    const identity = await inTenant((tx) => managerIdentity(tx, query()));
    expect(identity.active).toBe(true);
    expect([...identity.rootIds].sort()).toEqual([...chain].sort());
    expect(identity).not.toHaveProperty('orgIds');
  });

  it('AC-BE-F161 负责组织展开为 2,110 个去重组织，经理团队与参照查询均可用', async () => {
    const identity = await inTenant((tx) => managerIdentityWithOrgs(tx, query()));
    expect(identity.active).toBe(true);
    expect(identity.orgIds).toHaveLength(DEPTH + LEAVES);
    expect(new Set(identity.orgIds).size).toBe(DEPTH + LEAVES);
    expect(identity.orgIds).toEqual(expect.arrayContaining(chain));
    expect(identity.orgIds).not.toContain(w.orgB);
    await inTenant((tx) => managerTeamQuery(tx, managerCtx()));
    await inTenant((tx) => managerReferenceQuery(tx, managerCtx(), { effectiveDate: AS_OF }));
  });

  it('AC-BE-F161 去重后恰好 20,000 个组织完整返回', async () => {
    await leaves(chain[DEPTH - 1]!, 'F161large', LIMIT - DEPTH - LEAVES);
    const identity = await inTenant((tx) => managerIdentityWithOrgs(tx, query()));
    expect(identity.orgIds).toHaveLength(LIMIT);
    expect(new Set(identity.orgIds).size).toBe(LIMIT);
  }, 120_000);

  it('AC-BE-F161 去重后 20,001 个组织：展开仍 413，身份判定与评定活动列表不受影响', async () => {
    await leaves(chain[DEPTH - 1]!, 'F161over', 1);
    await tooLarge(() => inTenant((tx) => managerIdentityWithOrgs(tx, query())));
    await tooLarge(() => inTenant((tx) => managerTeamQuery(tx, managerCtx())));
    await tooLarge(() => inTenant((tx) => managerReferenceQuery(tx, managerCtx(), { effectiveDate: AS_OF })));
    expect((await inTenant((tx) => managerIdentity(tx, query()))).active).toBe(true);
    const listed = await ok<{ items: ActivityView[] }>(await op.request('GET', ACTIVITIES));
    expect(listed.items.map((item) => item.id)).toEqual([existing.id]);
  }, 120_000);
});
