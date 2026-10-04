/**
 * PR #26 审计遗留（非 blocking 2、3）：人员列表、嵌套子集与历史读取的 SQL 语句数不随行数增长；
 * 组织 / 职务排序号预计算并存储（DEC-089），读取时直接取值，不在请求里做全租户递归排名。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { PERSONNEL_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const ROWS = 200;

/** 通过 drizzle 会话的 logger 统计实际下发的语句（事务内新会话沿用同一 options）。 */
function recordStatements(db: Db) {
  const session = (db as unknown as { session: { logger: unknown; options: Record<string, unknown> } }).session;
  const statements: string[] = [];
  const logger = { logQuery: (query: string) => statements.push(query) };
  const previous = { logger: session.logger, options: session.options };
  session.logger = logger;
  session.options = { ...session.options, logger };
  return {
    statements,
    stop() {
      session.logger = previous.logger;
      session.options = previous.options;
    },
  };
}

describe('AC-SUB 人员读取有界：语句数与行数无关', () => {
  let world: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    world = await fixture();
  });

  async function fixture() {
    const db = database().db;
    const seed = await seedPermissionWorld(db);
    const clock = () => new Date('2026-10-01T01:00:00Z');
    const setup = tenantApi(db, { clock });
    const api = tenantApi(db, { clock, authorize: undefined });
    const reader = await addMember(seed, 'personnel-bulk-reader');
    const profile = await createProfile(seed, 'personnel-bulk');
    for (const definition of PERSONNEL_OBJECTS) {
      const response = await setObjectPermission(
        seed,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
          buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
        },
        definition.code,
      );
      expect(response.status).toBe(200);
    }
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, reader.id, profile.id)).status).toBe(201);
    const create = async (path: string, body: object, ifMatch = 0) => {
      const r = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, body, ifMatch });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json()) as { id: string; revision: number };
    };
    const parent = { admin: { parentId: seed.tenant.id } };
    const org = await create('org/organizations', { name: '批量部门', establishedOn: '2020-01-01', parents: parent });
    const late = await create('org/organizations', { name: '后排部门', establishedOn: '2020-01-01', parents: parent });
    const person = await create('employment/employees', { code: 'BULK-0001', name: '合成员工' });
    await create(
      `employment/employees/${person.id}/businesses`,
      { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: { departmentId: org.id } },
      1,
    );
    const patched = await setup.request('PATCH', `/api/tenant/personnel/employees/${person.id}`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: { engName: 'Synthetic' },
    });
    expect(patched.status).toBe(200);
    const education = await create(`personnel/employees/${person.id}/subsets/education`, { school: '合成大学' });
    await create(`personnel/employees/${person.id}/subsets/family`, { name: '合成家属' });
    const scope = await api.request('PUT', `/api/tenant/permission/scopes/${reader.id}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: {
        kind: 'org_range',
        orgRanges: [
          { orgId: org.id, includeDescendants: true },
          { orgId: late.id, includeDescendants: true },
        ],
      },
    });
    expect(scope.status).toBe(200);
    return {
      ...seed,
      db,
      api,
      setup,
      create,
      org,
      late,
      person,
      education,
      as: { user: reader.id, tenant: seed.tenant.id },
    };
  }

  const readPaths = () => [
    `/employees?pageSize=${ROWS}`,
    `/subsets/education?pageSize=${ROWS}`,
    `/subsets/family?pageSize=${ROWS}&sortBy=code`,
    `/employees/${world.person.id}?includeSubsets=true`,
    `/employees/${world.person.id}/history?pageSize=${ROWS}`,
    `/employees/${world.person.id}/subsets/education/${world.education.id}/history?pageSize=${ROWS}`,
  ];

  async function measure(path: string) {
    const recorder = recordStatements(world.db);
    try {
      const response = await world.api.request('GET', `/api/tenant/personnel${path}`, world.as);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { items?: unknown[] };
      return { count: recorder.statements.length, statements: [...recorder.statements], items: body.items?.length };
    } finally {
      recorder.stop();
    }
  }

  /** 复制合成样本：员工主档、任职链、员工信息版本与子集；只改主键、外键与业务编码。 */
  async function cloneEmployees(total: number) {
    const tid = world.tenant.id;
    const sample = world.person.id;
    await withTenant(world.db, tid, async (tx) => {
      const tables = [
        ['employment_employees', 'person', sql`id`],
        ['employment_cycles', 'staff', sql`employee_id`],
        ['employment_business_objects', 'business', sql`employee_id`],
        ['employment_payload_versions', 'payload', sql`employee_id`],
        ['employment_records', 'business', sql`employee_id`],
        ['employment_timeline', 'timeline', sql`employee_id`],
        ['personnel_employee_versions', 'profile', sql`employee_id`],
        ['personnel_education', 'education', sql`employee_id`],
        ['personnel_family', 'family', sql`employee_id`],
      ] as const;
      for (const [table, prefix, owner] of tables) {
        const tableSql = sql.identifier(table);
        const patch = sql`jsonb_build_object('id',md5(${tid}||${prefix}||g)::uuid,
          'employee_id',md5(${tid}||'person'||g)::uuid,'business_id',md5(${tid}||'business'||g)::uuid,
          'payload_version_id',md5(${tid}||'payload'||g)::uuid,'staff_id',md5(${tid}||'staff'||g)::uuid,
          'record_id',md5(${tid}||'business'||g)::uuid,'previous_version_id',NULL,
          'code','BULK-'||lpad(g::text,4,'0'))`;
        await tx.execute(sql`INSERT INTO ${tableSql}
          SELECT (jsonb_populate_record(NULL::${tableSql},to_jsonb(sample)||${patch})).*
          FROM (SELECT * FROM ${tableSql} WHERE tenant_id=${tid} AND ${owner}=${sample}::uuid
            ORDER BY created_at LIMIT 1) sample
          CROSS JOIN generate_series(2,${total}) g`);
      }
      // 同一员工 / 同一子集记录的版本链也扩到 total 条，验证历史分页同样有界。
      await tx.execute(sql`INSERT INTO personnel_employee_versions
        SELECT (jsonb_populate_record(NULL::personnel_employee_versions,to_jsonb(v)||jsonb_build_object(
          'id',gen_random_uuid(),'revision',v.revision+g,'previous_version_id',NULL))).*
        FROM (SELECT * FROM personnel_employee_versions WHERE tenant_id=${tid} AND employee_id=${sample}::uuid
          ORDER BY revision DESC LIMIT 1) v CROSS JOIN generate_series(1,${total}) g`);
      await tx.execute(sql`INSERT INTO personnel_education_versions
        SELECT (jsonb_populate_record(NULL::personnel_education_versions,to_jsonb(v)||jsonb_build_object(
          'id',gen_random_uuid(),'revision',v.revision+g))).*
        FROM (SELECT * FROM personnel_education_versions
          WHERE tenant_id=${tid} AND record_id=${world.education.id}::uuid ORDER BY revision DESC LIMIT 1) v
        CROSS JOIN generate_series(1,${total}) g`);
    });
  }

  it(`列表、嵌套子集、历史：1 行与 ${ROWS} 行的语句数相同`, async () => {
    const small = new Map<string, number>();
    for (const path of readPaths()) small.set(path, (await measure(path)).count);
    await cloneEmployees(ROWS);
    for (const path of readPaths()) {
      const large = await measure(path);
      if (path.includes('?pageSize')) expect(large.items, path).toBe(ROWS);
      expect(large.count, path).toBe(small.get(path));
    }
  });

  it('DEC-089：任何读取（含按排序号排序 / 筛选）都不现算排名，排序号不排序时也有值', async () => {
    const paths = [...readPaths(), `/employees?pageSize=${ROWS}&sortBy=organizationSortNumber`];
    for (const path of paths) {
      const { statements } = await measure(path);
      // 数据范围展开本身也用递归 CTE，所以只认排名特征：沿行政路径排序后编号。
      expect(
        statements.filter((s) => /sort_path|row_number\s*\(\s*\)\s*OVER/i.test(s)),
        path,
      ).toEqual([]);
    }
    const response = await world.api.request('GET', `/api/tenant/personnel/employees?pageSize=${ROWS}`, world.as);
    const items = ((await response.json()) as { items: { organizationSortNumber: number | null }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => typeof item.organizationSortNumber === 'number')).toBe(true);
  });

  it('按组织排序号排序 / 筛选时按行政路径的全租户名次', async () => {
    const person = await world.create('employment/employees', { code: `LATE-${randomUUID()}`, name: '后排员工' });
    await world.create(
      `employment/employees/${person.id}/businesses`,
      { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: { departmentId: world.late.id } },
      1,
    );
    const read = async (query: string) => {
      const response = await world.api.request('GET', `/api/tenant/personnel/employees?${query}`, world.as);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { id: string; organizationSortNumber: number | null }[] }).items;
    };
    const ascending = await read('sortBy=organizationSortNumber&pageSize=1');
    const descending = await read('sortBy=organizationSortNumber&direction=desc&pageSize=1');
    expect(descending.map((item) => item.id)).toEqual([person.id]);
    expect(ascending[0]!.id).not.toBe(person.id);
    const lateRank = descending[0]!.organizationSortNumber!;
    expect(lateRank).toBeGreaterThan(ascending[0]!.organizationSortNumber!);
    expect((await read(`organizationSortNumber=${lateRank}`)).map((item) => item.id)).toEqual([person.id]);
    // 职务排序号同样只在按其排序时计算。
    const sorted = await world.api.request('GET', '/api/tenant/personnel/employees?sortBy=postSortNumber', world.as);
    expect(sorted.status).toBe(200);
  });
});
