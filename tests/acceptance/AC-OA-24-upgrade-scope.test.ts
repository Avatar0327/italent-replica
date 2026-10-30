import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { withPreAuditSchema } from './support/pre-audit-schema.js';

const database = useTestDb({ migrateBefore: '_approval_subjects' });
const rowsOf = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

it('AC-OA-24 旧库审批范围空表：普通角色可解析，正常及异常均撤掉，正式迁移重建后不再触碰', async () => {
  const handle = database();
  const tenantId = randomUUID();
  const table = async () =>
    rowsOf<{ name: string | null }>(
      await handle.db.execute(sql`SELECT to_regclass('public.org_adjustments')::text AS name`),
    )[0]!.name;
  expect(await table()).toBeNull();
  await withPreAuditSchema(handle.db, async () => {
    const rows = await withTenant(handle.db, tenantId, (tx) =>
      tx.execute(sql`SELECT id, tenant_id, approval_subject_org_id FROM org_adjustments`),
    );
    expect(rowsOf(rows)).toEqual([]);
  });
  expect(await table()).toBeNull();

  const failure = new Error('合成前置步骤失败');
  await expect(
    withPreAuditSchema(handle.db, async () => {
      expect(await table()).toBe('org_adjustments');
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await table()).toBeNull();

  await handle.migrate();
  const definition = async () =>
    rowsOf<{ oid: number; enabled: boolean; forced: boolean }>(
      await handle.db.execute(sql`SELECT oid::int, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid='public.org_adjustments'::regclass`),
    )[0]!;
  const formal = await definition();
  expect(formal).toMatchObject({ enabled: true, forced: true });
  await withPreAuditSchema(handle.db, async () => {
    expect(await definition()).toEqual(formal);
  });
  expect(await definition()).toEqual(formal);
});
