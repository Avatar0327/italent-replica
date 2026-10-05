/** 单租户万人量级合成基准；报告实际耗时，不把机器相关的耗时作为断言。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';

const database = useTestDb();
it('AC-EMP-16 万人主职首算、无变化重算、反向全量变更', async () => {
  const db = database().db;
  const w = await employmentSession(db, 'oc-10k');
  const e = await w.employee('合成人员', 'B00000');
  await w.business(e.id, { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields: {} }, 1);
  await withTenant(db, w.tenant.id, async (tx) => {
    await tx.execute(sql`CREATE TEMP TABLE order_bench_map ON COMMIT DROP AS SELECT
      gen_random_uuid() AS employee_id,gen_random_uuid() AS staff_id,gen_random_uuid() AS business_id,
      gen_random_uuid() AS payload_id,'B'||lpad(n::text,5,'0') AS code FROM generate_series(1,9999) n`);
    await tx.execute(sql`INSERT INTO employment_employees(tenant_id,id,name,code)
      SELECT ${w.tenant.id},employee_id,'合成人员',code FROM order_bench_map`);
    await tx.execute(sql`INSERT INTO employment_cycles SELECT (jsonb_populate_record(NULL::employment_cycles,
      to_jsonb(c)||jsonb_build_object('id',m.staff_id,'employee_id',m.employee_id))).*
      FROM employment_cycles c CROSS JOIN order_bench_map m WHERE c.employee_id=${e.id}::uuid`);
    await tx.execute(sql`INSERT INTO employment_business_objects(tenant_id,id,employee_id)
      SELECT ${w.tenant.id},business_id,employee_id FROM order_bench_map`);
    await tx.execute(sql`INSERT INTO employment_payload_versions
      SELECT (jsonb_populate_record(NULL::employment_payload_versions,to_jsonb(p)||jsonb_build_object(
        'id',m.payload_id,'employee_id',m.employee_id,'business_id',m.business_id,
        'version_no',1,'previous_version_id',NULL))).*
      FROM (SELECT * FROM employment_payload_versions WHERE employee_id=${e.id}::uuid
        ORDER BY version_no DESC LIMIT 1) p CROSS JOIN order_bench_map m`);
    await tx.execute(sql`INSERT INTO employment_records SELECT (jsonb_populate_record(NULL::employment_records,
      to_jsonb(r)||jsonb_build_object('id',m.business_id,'employee_id',m.employee_id,
        'staff_id',m.staff_id,'payload_version_id',m.payload_id))).*
      FROM employment_records r CROSS JOIN order_bench_map m WHERE r.employee_id=${e.id}::uuid`);
    await tx.execute(sql`INSERT INTO employment_timeline SELECT (jsonb_populate_record(NULL::employment_timeline,
      to_jsonb(t)||jsonb_build_object('record_id',m.business_id,'employee_id',m.employee_id,'staff_id',m.staff_id))).*
      FROM employment_timeline t CROSS JOIN order_bench_map m WHERE t.employee_id=${e.id}::uuid`);
  });
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { tenant: w.tenant.id, user: w.user.id };
  const configure = async (direction: string, revision: number) => {
    const response = await api.request('PUT', '/api/tenant/personnel/order-code/settings', {
      ...as,
      ifMatch: revision,
      body: { enabled: true, items: [{ field: 'code', enabled: true, direction }] },
    });
    expect(response.status).toBe(200);
  };
  const measure = async (label: string, revision: number, changed: number) => {
    const start = performance.now();
    const response = await api.request('POST', '/api/tenant/personnel/order-code/recompute', {
      ...as,
      ifMatch: revision,
      body: {},
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ changed, outcome: 'computed' });
    console.info(
      JSON.stringify({
        benchmark: 'person-order-10000',
        label,
        milliseconds: Math.round(performance.now() - start),
        mode: process.env.TEST_DATABASE_URL ? 'pg' : 'pglite',
      }),
    );
  };
  await configure('asc', 0);
  await measure('first', 1, 10000);
  await measure('unchanged', 1, 0);
  await configure('desc', 1);
  await measure('all-changed', 2, 10000);
  await withTenant(db, w.tenant.id, async (tx) => {
    expect(
      rows(
        await tx.execute(sql`SELECT count(*)::int AS n,min(order_code) AS lo,max(order_code) AS hi
      FROM personnel_employee_order_codes`),
      ),
    ).toEqual([{ n: 10000, lo: 1, hi: 10000 }]);
  });
}, 120_000);
