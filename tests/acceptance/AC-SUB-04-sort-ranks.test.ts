/**
 * DEC-089：员工信息的组织 / 职务排序号预计算并存储——组织、职务变更时在同一事务内增量刷新全租户名次，
 * 读取直接取值、字段始终有值。存储结果逐一对照“按 G-036 规则现算”的名次（行政路径 / 职务编码）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const TODAY = '2026-10-01';

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

/** 规则现算：行政维度路径（顺序号 + 编码）排序后的全租户名次（DEC-037 / G-036）。 */
async function expectedOrgRanks(tx: Tx, tenantId: string, date: string) {
  const rows = rowsOf<{ org_id: string; n: number }>(
    await tx.execute(sql`WITH RECURSIVE cur AS (
        SELECT DISTINCT ON (org_id) id,org_id,code,stop_date,enabled FROM org_versions
        WHERE tenant_id=${tenantId} AND start_date<=${date}::date ORDER BY org_id,start_date DESC,version_no DESC
      ), paths(org_id,sort_path,visited) AS (
        SELECT org_id,ARRAY[code]::text[],ARRAY[org_id] FROM cur
        WHERE org_id=${tenantId}::uuid AND enabled AND stop_date>=${date}::date
        UNION ALL
        SELECT c.org_id,p.sort_path || (lpad(COALESCE(h.sequence,2147483647)::text,10,'0') || ':' || c.code),
          p.visited || c.org_id
        FROM cur c JOIN org_hierarchy_links h ON h.tenant_id=${tenantId} AND h.version_id=c.id AND h.dimension='admin'
        JOIN paths p ON p.org_id=h.parent_org_id
        WHERE c.enabled AND c.stop_date>=${date}::date AND NOT c.org_id=ANY(p.visited)
      ) SELECT org_id,row_number() OVER (ORDER BY sort_path)::int AS n FROM paths`),
  );
  return new Map(rows.map((row) => [row.org_id, Number(row.n)]));
}

async function expectedPostRanks(tx: Tx, tenantId: string, date: string) {
  const rows = rowsOf<{ object_id: string; n: number }>(
    await tx.execute(sql`SELECT object_id,row_number() OVER (ORDER BY code,object_id)::int AS n FROM (
        SELECT DISTINCT ON (object_id) object_id,code,stop_date,enabled FROM job_post_versions
        WHERE tenant_id=${tenantId} AND start_date<=${date}::date ORDER BY object_id,start_date DESC,version_no DESC
      ) cur WHERE enabled AND stop_date>=${date}::date`),
  );
  return new Map(rows.map((row) => [row.object_id, Number(row.n)]));
}

async function storedRanks(tx: Tx, table: 'personnel_org_sort_ranks' | 'personnel_post_sort_ranks', date: string) {
  const key = table === 'personnel_org_sort_ranks' ? sql`org_id` : sql`post_id`;
  const rows = rowsOf<{ id: string; n: number }>(
    await tx.execute(sql`SELECT ${key} AS id,sort_number AS n FROM ${sql.identifier(table)}
      WHERE valid_from<=${date}::date AND valid_to>${date}::date`),
  );
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

interface Item {
  readonly id: string;
  readonly organizationSortNumber: number | null;
  readonly postSortNumber: number | null;
}

async function world(db: Db, label: string) {
  const { tenant, user } = await seedTenantWithMember(db, label);
  let now = new Date(`${TODAY}T01:00:00Z`);
  const api = tenantApi(db, { clock: () => now });
  const as = { user: user.id, tenant: tenant.id };
  const call = (method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, `/api/tenant/${path}`, { ...as, ...(body === undefined ? {} : { body }), ifMatch });
  const ok = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  };
  type Ref = { id: string; revision: number };
  const org = async (name: string, parentId: string = tenant.id, sequence?: number) =>
    ok<Ref>(
      await call(
        'POST',
        'org/organizations',
        {
          name,
          establishedOn: '2020-01-01',
          parents: { admin: { parentId, ...(sequence === undefined ? {} : { sequence }) } },
        },
        0,
      ),
      201,
    );
  const updateOrg = async (target: Ref, patch: Record<string, unknown>) =>
    Object.assign(target, {
      revision: (await ok<Ref>(await call('PATCH', `org/organizations/${target.id}`, patch, target.revision))).revision,
    });
  const post = async (code: string) =>
    ok<Ref>(await call('POST', 'job/posts', { name: code, code, startDate: '2020-01-01' }, 0), 201);
  const updatePost = async (target: Ref, patch: Record<string, unknown>) =>
    Object.assign(target, {
      revision: (await ok<Ref>(await call('PATCH', `job/posts/${target.id}`, patch, target.revision))).revision,
    });
  async function employee(name: string, fields: Record<string, unknown>) {
    const created = await ok<Ref>(
      await call('POST', 'employment/employees', { name, code: `SR_${randomUUID().slice(0, 8)}` }, 0),
      201,
    );
    await ok(
      await call(
        'POST',
        `employment/employees/${created.id}/businesses`,
        { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields },
        1,
      ),
      201,
    );
    return created.id;
  }
  const list = async (query = '') =>
    (await ok<{ items: Item[] }>(await call('GET', `personnel/employees?pageSize=200${query}`))).items;
  /** 存储名次必须与规则现算一致，且名次连续不重复。 */
  async function assertRanks(date = TODAY) {
    await withTenant(db, tenant.id, async (tx) => {
      const orgs = await storedRanks(tx, 'personnel_org_sort_ranks', date);
      expect(orgs).toEqual(await expectedOrgRanks(tx, tenant.id, date));
      expect([...orgs.values()].sort((a, b) => a - b)).toEqual([...orgs.keys()].map((_, i) => i + 1));
      const posts = await storedRanks(tx, 'personnel_post_sort_ranks', date);
      expect(posts).toEqual(await expectedPostRanks(tx, tenant.id, date));
    });
  }
  /** 增量刷新累积出的分段（含区间切分与合并）必须与从头全量重算（迁移回填同一路径）逐行一致。 */
  async function assertMatchesFullRecompute() {
    await withTenant(db, tenant.id, async (tx) => {
      const segments = async () =>
        rowsOf(
          await tx.execute(sql`SELECT 'org' AS kind,org_id AS id,valid_from::text,valid_to::text,sort_number
            FROM personnel_org_sort_ranks UNION ALL
            SELECT 'post',post_id,valid_from::text,valid_to::text,sort_number FROM personnel_post_sort_ranks
            ORDER BY 1,2,3`),
        );
      const incremental = await segments();
      await tx.execute(sql`SELECT personnel_refresh_org_sort_ranks(${tenant.id}::uuid, DATE '0001-01-01'),
        personnel_refresh_post_sort_ranks(${tenant.id}::uuid, DATE '0001-01-01')`);
      expect(await segments()).toEqual(incremental);
    });
  }
  async function orgRank(orgId: string, date = TODAY) {
    return withTenant(db, tenant.id, async (tx) => (await expectedOrgRanks(tx, tenant.id, date)).get(orgId) ?? null);
  }
  return {
    db,
    tenant,
    org,
    updateOrg,
    post,
    updatePost,
    employee,
    list,
    assertRanks,
    assertMatchesFullRecompute,
    orgRank,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

const order = (items: Item[], ids: readonly string[]) => items.filter((i) => ids.includes(i.id)).map((i) => i.id);

describe('DEC-089 组织排序号预计算', () => {
  it('新增组织：同一事务内刷新全租户名次，员工列表不排序也有值，按排序号排序正确', async () => {
    const w = await world(database().db, 'rank-create');
    const a = await w.org('A部门', undefined, 2);
    const b = await w.org('B部门', undefined, 1);
    const c = await w.org('C部门', a.id);
    await w.assertRanks();
    const ea = await w.employee('甲', { departmentId: a.id });
    const eb = await w.employee('乙', { departmentId: b.id });
    const ec = await w.employee('丙', { departmentId: c.id });
    const plain = await w.list();
    for (const [id, orgId] of [
      [ea, a.id],
      [eb, b.id],
      [ec, c.id],
    ] as const) {
      expect(plain.find((item) => item.id === id)?.organizationSortNumber).toBe(await w.orgRank(orgId));
    }
    expect(order(await w.list('&sortBy=organizationSortNumber'), [ea, eb, ec])).toEqual([eb, ea, ec]);
    const late = await w.org('D部门', undefined, 0);
    await w.assertRanks();
    expect(await w.orgRank(late.id)).toBe(2);
    expect((await w.list()).find((item) => item.id === eb)?.organizationSortNumber).toBe(3);
  });

  it('调整组织顺序号与上级：名次随之刷新，列表取值与排序一致', async () => {
    const w = await world(database().db, 'rank-move');
    const a = await w.org('A部门', undefined, 2);
    const b = await w.org('B部门', undefined, 1);
    const c = await w.org('C部门', a.id);
    const ids = [
      await w.employee('甲', { departmentId: a.id }),
      await w.employee('乙', { departmentId: b.id }),
      await w.employee('丙', { departmentId: c.id }),
    ] as const;
    await w.updateOrg(b, { effectiveDate: TODAY, parents: { admin: { parentId: w.tenant.id, sequence: 3 } } });
    await w.assertRanks();
    expect(order(await w.list('&sortBy=organizationSortNumber'), ids)).toEqual([ids[0], ids[2], ids[1]]);
    await w.updateOrg(c, { effectiveDate: TODAY, parents: { admin: { parentId: b.id } } });
    await w.assertRanks();
    expect(order(await w.list('&sortBy=organizationSortNumber'), ids)).toEqual([ids[0], ids[1], ids[2]]);
    await w.assertMatchesFullRecompute();
    const filtered = await w.list(`&organizationSortNumber=${await w.orgRank(c.id)}`);
    expect(filtered.map((item) => item.id)).toEqual([ids[2]]);
  });

  it('停用组织：停用组织及其下级不再有名次，其余组织名次连续', async () => {
    const w = await world(database().db, 'rank-disable');
    const a = await w.org('A部门', undefined, 1);
    const b = await w.org('B部门', undefined, 2);
    const c = await w.org('C部门', a.id);
    const eb = await w.employee('乙', { departmentId: b.id });
    // DEC-129：整支仍有在职人员时拒绝停用，接口只能停用空的整支，下级 C 同日级联停用。
    await w.updateOrg(a, { effectiveDate: TODAY, enabled: false });
    await w.assertRanks();
    expect(await w.orgRank(a.id)).toBeNull();
    expect(await w.orgRank(c.id)).toBeNull();
    expect((await w.list()).find((item) => item.id === eb)?.organizationSortNumber).toBe(2);
    await w.assertMatchesFullRecompute();
  });

  it('停用组织里仍挂着员工的存量 / 导入数据：这些员工没有组织名次', async () => {
    const w = await world(database().db, 'rank-disable-legacy');
    const a = await w.org('A部门', undefined, 1);
    await w.org('B部门', undefined, 2);
    const ea = await w.employee('甲', { departmentId: a.id });
    // DEC-129 只约束接口写入；直接写库的导入仍可能留下这种数据，名次照样按停用处理。
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [old] = rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id FROM org_versions WHERE org_id=${a.id}::uuid
          ORDER BY version_no DESC LIMIT 1`),
      );
      const versionId = randomUUID();
      await tx.execute(sql`INSERT INTO org_versions
        SELECT (jsonb_populate_record(NULL::org_versions, to_jsonb(v) || jsonb_build_object(
          'id',${versionId}::uuid,'version_no',v.version_no+1,'previous_version_id',v.id,
          'start_date',${TODAY}::date,'enabled',false))).*
        FROM org_versions v WHERE v.id=${old!.id}::uuid`);
      await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id,sequence)
        VALUES (${w.tenant.id},${versionId}::uuid,'admin',${w.tenant.id}::uuid,1)`);
    });
    await w.assertRanks();
    expect((await w.list()).find((item) => item.id === ea)?.organizationSortNumber).toBeNull();
    await w.assertMatchesFullRecompute();
  });

  it('未来生效的调整：生效日前取旧名次，到生效日无需再写入即取新名次', async () => {
    const w = await world(database().db, 'rank-future');
    const a = await w.org('A部门', undefined, 2);
    const b = await w.org('B部门', undefined, 1);
    const ea = await w.employee('甲', { departmentId: a.id });
    const eb = await w.employee('乙', { departmentId: b.id });
    await w.updateOrg(b, { effectiveDate: '2026-10-10', parents: { admin: { parentId: w.tenant.id, sequence: 9 } } });
    await w.assertRanks();
    await w.assertRanks('2026-10-10');
    expect(order(await w.list('&sortBy=organizationSortNumber'), [ea, eb])).toEqual([eb, ea]);
    w.setNow('2026-10-10T01:00:00Z');
    expect(order(await w.list('&sortBy=organizationSortNumber'), [ea, eb])).toEqual([ea, eb]);
    await w.assertMatchesFullRecompute();
  });

  it('任何写入路径都在同一事务刷新（含直接写库的导入 / 夹具）', async () => {
    const w = await world(database().db, 'rank-sql');
    const a = await w.org('A部门', undefined, 1);
    const b = await w.org('B部门', undefined, 2);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      const [old] = rowsOf<{ id: string; version_no: number }>(
        await tx.execute(sql`SELECT id,version_no FROM org_versions WHERE org_id=${a.id}::uuid
          ORDER BY version_no DESC LIMIT 1`),
      );
      const versionId = randomUUID();
      await tx.execute(sql`INSERT INTO org_versions
        SELECT (jsonb_populate_record(NULL::org_versions, to_jsonb(v) || jsonb_build_object(
          'id',${versionId}::uuid,'version_no',v.version_no+1,'previous_version_id',v.id))).*
        FROM org_versions v WHERE v.id=${old!.id}::uuid`);
      await tx.execute(sql`INSERT INTO org_hierarchy_links(tenant_id,version_id,dimension,parent_org_id,sequence)
        VALUES (${w.tenant.id},${versionId}::uuid,'admin',${w.tenant.id}::uuid,5)`);
    });
    await w.assertRanks();
    expect(await w.orgRank(b.id)).toBe(2);
  });
});

describe('DEC-089 职务排序号预计算', () => {
  it('新增与改编码都刷新职务名次，员工列表取值与排序一致', async () => {
    const w = await world(database().db, 'rank-post');
    const p20 = await w.post('P20');
    const p10 = await w.post('P10');
    await w.assertRanks();
    const e20 = await w.employee('甲', { postId: p20.id });
    const e10 = await w.employee('乙', { postId: p10.id });
    expect(order(await w.list('&sortBy=postSortNumber'), [e20, e10])).toEqual([e10, e20]);
    expect((await w.list()).find((item) => item.id === e10)?.postSortNumber).toBe(1);
    await w.updatePost(p20, { code: 'P05', effectiveDate: TODAY });
    await w.assertRanks();
    expect(order(await w.list('&sortBy=postSortNumber'), [e20, e10])).toEqual([e20, e10]);
    await w.assertMatchesFullRecompute();
  });
});

describe('DEC-089 并发变更', () => {
  it('并发新增 / 调整组织与职务后，存储名次与规则现算一致且连续', async () => {
    const w = await world(database().db, 'rank-concurrent');
    const base = await w.org('基准部门', undefined, 5);
    await Promise.all([
      ...[3, 1, 4, 1, 5, 9].map((sequence, i) => w.org(`并发部门${i}`, undefined, sequence)),
      ...['Q3', 'Q1', 'Q2'].map((code) => w.post(code)),
      w.updateOrg(base, { effectiveDate: TODAY, parents: { admin: { parentId: w.tenant.id, sequence: 2 } } }),
    ]);
    await w.assertRanks();
    await w.assertMatchesFullRecompute();
  });
});
