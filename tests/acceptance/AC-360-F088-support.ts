/** F-088：只克隆合成任职种子，保留外键、不可变快照和时间线约束。 */
import { randomUUID } from 'node:crypto';
import { type Db, type DbHandle, type Tx, sql, withTenant } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll } from 'vitest';
import { fullAccess, type PersonView, world360 } from './AC-360-support.js';
import { hire } from './AC-360-F043-support.js';

interface Observation {
  query: string;
  ids: string[];
}

/** 大租户测试仍每文件一个隔离库；并行工作区争用时给全量迁移留足启动时间。 */
export function useBoundedDb(): () => DbHandle {
  let handle: DbHandle | undefined;
  beforeAll(async () => {
    handle = await createTestDb();
  }, 180_000);
  afterAll(async () => {
    await handle?.close();
  }, 180_000);
  return () => {
    if (!handle) throw new Error('F-088 隔离测试库尚未初始化');
    return handle;
  };
}

export async function boundedScene(db: Db, label: string, size: number) {
  const observations: Observation[] = [];
  const observed = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver) as unknown;
      return (run: (tx: Tx) => Promise<unknown>) =>
        target.transaction((tx) =>
          run(
            new Proxy(tx, {
              get(inner, field, owner) {
                if (field !== 'execute') return Reflect.get(inner, field, owner) as unknown;
                return async (query: Parameters<Tx['execute']>[0]) => {
                  const result = await inner.execute(query);
                  const dialect = Reflect.get(inner, 'dialect') as {
                    sqlToQuery: (query: ReturnType<typeof sql>) => { sql: string };
                  };
                  const text = typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
                  if (/SELECT t.employee_id|ORDER BY id FOR SHARE|ORDER BY id FOR NO KEY UPDATE/.test(text)) {
                    const list = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
                      id?: string;
                      employee_id?: string;
                    }[];
                    observations.push({ query: text, ids: list.map((r) => r.employee_id ?? r.id!) });
                  }
                  return result;
                };
              },
            }),
          ),
        );
    },
  });
  const access = fullAccess();
  const w = await world360(observed, label, { access });
  const org = await w.session.org('合成大租户部门', { establishedOn: '2025-01-01' });
  const manager = await hire(w, '经理', org.id);
  const seed = await hire(w, '任职种子', org.id, manager.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const managerPerson = people.find((p) => p.employeeId === manager.id)!;
  const seedPerson = people.find((p) => p.employeeId === seed.id)!;
  // UUID 首段，格式固定 8 位十六进制；不是唯一约束后缀（见 guard-unique-suffix 白名单）
  const prefix = randomUUID().slice(0, 8);
  const id = (n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  await withTenant(db, w.tenantId, async (tx) => {
    for (const [table, idPrefix] of [
      ['employment_employees', 'employee'],
      ['employment_cycles', 'staff'],
      ['employment_business_objects', 'business'],
      ['employment_payload_versions', 'payload'],
      ['employment_records', 'business'],
      ['employment_timeline', 'timeline'],
    ] as const) {
      const name = sql.identifier(table);
      const ownKey = table === 'employment_employees' ? sql`id` : sql`employee_id`;
      const patch = sql`jsonb_build_object('id',CASE WHEN ${idPrefix} = 'employee'
          THEN (${prefix} || '-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid
          ELSE md5(${w.tenantId}||${idPrefix}||g)::uuid END,
        'employee_id',(${prefix} || '-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,
        'business_id',md5(${w.tenantId}||'business'||g)::uuid,
        'record_id',md5(${w.tenantId}||'business'||g)::uuid,
        'payload_version_id',md5(${w.tenantId}||'payload'||g)::uuid,
        'staff_id',md5(${w.tenantId}||'staff'||g)::uuid,'code','A'||lpad(g::text,8,'0'))`;
      await tx.execute(sql`INSERT INTO ${name}
        SELECT (jsonb_populate_record(NULL::${name},to_jsonb(sample)||${patch})).*
        FROM (SELECT * FROM ${name} WHERE tenant_id=${w.tenantId}::uuid
          AND ${ownKey}=${seed.id}::uuid LIMIT 1) sample CROSS JOIN generate_series(1,${size}) g`);
    }
    await tx.execute(sql`INSERT INTO survey360_people
      (tenant_id,name,email,employee_id,email_locked,source,created_by)
      SELECT ${w.tenantId}::uuid,'合成员工'||g,'f088-'||g||'@example.com',
        (${prefix}||'-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,true,'org_sync',${w.admin}::uuid
      FROM generate_series(1,${size}) g`);
  });
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const activity = await w.activity();
  const object = await w.object(activity.id, managerPerson.id, [q.id]);
  observations.length = 0;
  const auto = (body: object = { roles: ['subordinate'], limits: { subordinate: 1 } }) =>
    w.request('POST', `/activities/${activity.id}/objects/${object.id}/appraisers/auto`, { ifMatch: 0, body });
  const locks = () => observations.filter((o) => o.query.includes('ORDER BY id FOR SHARE'));
  const pages = () => observations.filter((o) => o.query.includes('SELECT t.employee_id'));
  return {
    w,
    access,
    manager,
    managerPerson,
    seed,
    seedPerson,
    q,
    activity,
    object,
    id,
    auto,
    locks,
    pages,
    observations,
  };
}
