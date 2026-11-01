/** F-323：旧人员类别文本按名称精确映射到本租户预置项 ID；未知置空，三种载荷表均迁移、保持稳定 ID，并加外键。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';

const database = useTestDb({ migrateBefore: '_employment_types' });
const rows = <T>(v: unknown) => (Array.isArray(v) ? v : (v as { rows: T[] }).rows) as T[];

it('AC-EMP-F323-10：两个租户的主职 / 兼职载荷及申请迁移，未知与非精确名称置空；编制占编条件同步映射；预置 8 条、触发器恢复、外键生效', async () => {
  const db = database().db;
  const targets: { tenantId: string; id: string; value: string | null }[] = [];
  const schemes: { tenantId: string; version: string }[] = [];
  for (const label of ['f323-migration-a', 'f323-migration-b']) {
    const s = await employmentSession(db, label);
    const org = await s.org('合成迁移部门', { establishedOn: '2020-01-01' });
    const e = await s.employee();
    await withTenant(db, s.tenant.id, async (tx) => {
      for (const name of ['技术开发', '运维服务', 'YG正式员工', '不存在', ' 技术开发', null]) {
        const id = randomUUID();
        const payload = randomUUID();
        const primary = name === '技术开发';
        const kind = primary ? 'hire' : 'part_time';
        const service = primary ? 'primary' : 'part_time';
        const cycle = randomUUID();
        const date = `202${targets.filter((i) => i.tenantId === s.tenant.id).length}-01-01`;
        await tx.execute(sql`INSERT INTO employment_cycles(id,tenant_id,employee_id,entry_date,entry_type,employ_type)
          VALUES (${cycle},${s.tenant.id},${e.id},${date},'hire','internal')`);
        await tx.execute(sql`INSERT INTO employment_business_objects(id,tenant_id,employee_id)
          VALUES (${id},${s.tenant.id},${e.id})`);
        await tx.execute(sql`INSERT INTO employment_payload_versions
          (id,tenant_id,employee_id,business_id,version_no,kind,mode,effective_date,form_id,
           employment_type,employee_status)
          VALUES (${payload},${s.tenant.id},${e.id},${id},1,${kind},'direct',${date},'part_time',${name},3)`);
        await tx.execute(sql`INSERT INTO employment_records
          (id,tenant_id,employee_id,payload_version_id,staff_id,entry_date,kind,start_date,service_type,
           employment_type,employee_status,employ_type)
          VALUES (${id},${s.tenant.id},${e.id},${payload},${cycle},${date},${kind},${date},
            ${service},${name},3,'internal')`);
        if (primary)
          await tx.execute(sql`INSERT INTO employment_timeline
          (tenant_id,employee_id,record_id,staff_id,start_date,sort_order,valid_during)
          VALUES (${s.tenant.id},${e.id},${id},${cycle},${date},1,daterange(${date}::date,NULL,'[)'))`);
        await tx.execute(sql`INSERT INTO part_time_requests
          (id,tenant_id,employee_id,request_type,initiator,initiator_user_id)
          VALUES (${id},${s.tenant.id},${e.id},'add','hr',${s.user.id})`);
        await tx.execute(sql`INSERT INTO part_time_request_versions
          (id,tenant_id,employee_id,request_id,version_no,command_id,service_type,department_id,
           start_date,employment_type)
          VALUES (${payload},${s.tenant.id},${e.id},${id},1,${randomUUID()},'part_time',${org.id},${date},${name})`);
        targets.push({ tenantId: s.tenant.id, id, value: name });
      }
      const scheme = randomUUID();
      const version = randomUUID();
      await tx.execute(sql`INSERT INTO establishment_scheme_objects(id,tenant_id) VALUES (${scheme},${s.tenant.id})`);
      await tx.execute(sql`INSERT INTO establishment_scheme_versions
        (id,tenant_id,scheme_id,version_no,code,name,cycle,maintenance_mode,start_date)
        VALUES (${version},${s.tenant.id},${scheme},1,'f323','合成方案','annual','local','2026-01-01')`);
      await tx.execute(sql`INSERT INTO establishment_scheme_ranges
        (tenant_id,version_id,ordinal,employment_type,conditions) VALUES (${s.tenant.id},${version},0,'internal',
          ${JSON.stringify({ employmentType: ['技术开发', '不存在'], employmentForm: ['技术开发'] })}::jsonb)`);
      schemes.push({ tenantId: s.tenant.id, version });
    });
  }
  await database().migrate();
  for (const target of targets) {
    await withTenant(db, target.tenantId, async (tx) => {
      const presets = rows<{ name: string }>(
        await tx.execute(sql`SELECT name FROM employment_types WHERE tenant_id=${target.tenantId}`),
      );
      expect(presets).toHaveLength(8);
      const [type] = rows<{ id: string }>(
        await tx.execute(sql`
        SELECT id FROM employment_types WHERE tenant_id=${target.tenantId} AND name=${target.value}`),
      );
      if (['技术开发', '运维服务', 'YG正式员工'].includes(target.value ?? '')) expect(type?.id).toBeTruthy();
      for (const [table, key] of [
        ['employment_records', 'id'],
        ['employment_payload_versions', 'business_id'],
        ['part_time_request_versions', 'request_id'],
      ]) {
        const [record] = rows<{ employment_type: string | null }>(
          await tx.execute(sql`
          SELECT employment_type FROM ${sql.identifier(table!)}
          WHERE tenant_id=${target.tenantId} AND ${sql.identifier(key!)}=${target.id}`),
        );
        expect(record?.employment_type).toBe(type?.id ?? null);
      }
    });
  }
  for (const scheme of schemes) {
    await withTenant(db, scheme.tenantId, async (tx) => {
      const [type] = rows<{ id: string }>(
        await tx.execute(sql`SELECT id FROM employment_types WHERE tenant_id=${scheme.tenantId} AND name='技术开发'`),
      );
      const [range] = rows<{ conditions: unknown }>(
        await tx.execute(sql`SELECT conditions FROM establishment_scheme_ranges WHERE version_id=${scheme.version}`),
      );
      // 只改人员类别条件：同名的用工形式条件不受影响
      expect(range?.conditions).toEqual({ employmentType: [type!.id, '不存在'], employmentForm: ['技术开发'] });
    });
  }
  const triggers = rows<{ tgenabled: string }>(
    await db.execute(sql`
    SELECT tgenabled FROM pg_trigger WHERE tgname IN (
      'employment_records_append_only', 'employment_payload_versions_append_only',
      'part_time_request_versions_append_only', 'establishment_scheme_ranges_append_only')`),
  );
  expect(triggers).toHaveLength(4);
  expect(triggers.every((t) => t.tgenabled === 'O')).toBe(true);
  const foreignKeys = rows<{ conname: string }>(
    await db.execute(sql`SELECT conname FROM pg_constraint WHERE conname IN (
      'employment_records_type_fk', 'employment_payload_versions_type_fk', 'part_time_request_versions_type_fk')`),
  );
  expect(foreignKeys).toHaveLength(3);
});
