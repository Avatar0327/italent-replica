import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
const database = useTestDb();
const rows = (r: unknown) => (Array.isArray(r) ? r : (r as { rows: Record<string, unknown>[] }).rows);

describe('AC-SUB-01 事务及数据库约束', () => {
  it('直接 SQL 也不能为同一员工保存两个最高标记；跨员工标记互不影响', async () => {
    const db = database().db;
    const s = await personnelSession(db);
    const first = await s.add('education', { isHighestEducation: true, school: '甲校' });
    try {
      await withTenant(db, s.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO personnel_education
        (id,tenant_id,employee_id,revision,source_type,created_by,command_id,is_highest_education)
        VALUES(${randomUUID()},${s.tenant.id},${s.employee.id},1,'hr_direct',${s.user.id},'raw',true)`),
      );
      throw new Error('数据库允许了第二个最高学历');
    } catch (error) {
      expect(pgErrorCode(error)).toBe('23505');
    }
    expect(await (await s.request('GET', `${s.path('education')}/${first.id}`)).json()).toMatchObject({
      revision: 1,
      isHighestEducation: true,
    });
  });
  it('并发最高标记切换最多一条；旧标记版本不可修改', async () => {
    const db = database().db;
    const s = await personnelSession(db);
    const [a, b] = await Promise.all([
      s.add('education', { isHighestEducation: true, school: '甲校' }),
      s.add('education', { isHighestEducation: true, school: '乙校' }),
    ]);
    const list = (await (await s.request('GET', s.path('education'))).json()) as {
      items: { isHighestEducation: boolean }[];
    };
    expect(list.items.filter((i) => i.isHighestEducation)).toHaveLength(1);
    expect(a.id).not.toBe(b.id);
    await expect(
      withTenant(db, s.tenant.id, (tx) =>
        tx.execute(sql`UPDATE personnel_education_versions
      SET school='tampered' WHERE employee_id=${s.employee.id}`),
      ),
    ).rejects.toThrow();
  });
  it('审计失败使旧标记、员工主档、子集、outbox和命令台账整体回滚，日志不含敏感值', async () => {
    const db = database().db;
    const s = await personnelSession(db);
    const first = await s.add('education', { isHighestEducation: true, educationLevel: '本科', school: '甲校' });
    const key = randomUUID();
    await db.execute(sql`CREATE FUNCTION personnel_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.command_id='${sql.raw(key)}' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
      RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER personnel_test_fail BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION personnel_test_fail_audit()`);
    const log = vi.spyOn(console, 'error');
    try {
      const response = await s.request('POST', s.path('education'), {
        ifMatch: 0,
        idempotencyKey: key,
        body: { school: 'SECRET-SYNTHETIC', educationLevel: '硕士', isHighestEducation: true },
      });
      expect(response.status).toBe(503);
      expect(log).not.toHaveBeenCalled();
      expect(await (await s.request('GET', `${s.path('education')}/${first.id}`)).json()).toMatchObject({
        revision: 1,
        isHighestEducation: true,
      });
      expect(await (await s.request('GET', `/employees/${s.employee.id}`)).json()).toMatchObject({
        educationLevel: '本科',
      });
      await withTenant(db, s.tenant.id, async (tx) => {
        for (const table of ['command_ledger', 'personnel_outbox', 'audit_events'])
          expect(
            rows(await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE command_id=${key}`)),
          ).toHaveLength(0);
      });
    } finally {
      log.mockRestore();
      await db.execute(sql`DROP TRIGGER personnel_test_fail ON audit_events`);
      await db.execute(sql`DROP FUNCTION personnel_test_fail_audit()`);
    }
  });
  it('信息采集来源保留，字段级审计只记实际变化，outbox不含敏感值', async () => {
    const db = database().db;
    const s = await personnelSession(db);
    const sourceId = randomUUID();
    const item = await s.add('family', {
      name: '合成家属',
      idNumber: 'SECRET-SYNTHETIC',
      sourceType: 'info_collection',
      sourceId,
    });
    expect(item).toMatchObject({ sourceType: 'info_collection', sourceId });
    const key = randomUUID();
    const changed = await s.request('PATCH', `${s.path('family')}/${item.id}`, {
      ifMatch: 1,
      idempotencyKey: key,
      body: { name: '新的合成姓名' },
    });
    expect(changed.status).toBe(200);
    await withTenant(db, s.tenant.id, async (tx) => {
      const [event] = rows(await tx.execute(sql`SELECT before,after FROM audit_events WHERE command_id=${key}`));
      expect(event?.before).toHaveProperty('name', '合成家属');
      expect(event?.after).not.toHaveProperty('idNumber');
      const outbox = rows(await tx.execute(sql`SELECT * FROM personnel_outbox WHERE employee_id=${s.employee.id}`));
      expect(JSON.stringify(outbox)).not.toContain('SECRET-SYNTHETIC');
    });
  });
});
