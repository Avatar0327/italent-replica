/**
 * AC-EN-BE16-08（16a-4b0）迁移：只放宽 attachment_files_purpose，加入材料附件用途。作用对象：复刻系统（合成数据）。
 * 旧 CHECK 下登记材料用途必须失败（红），迁移后成功；离职 / 人员子集旧用途行升级后不变；其余用途仍被拒。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFiles, migrationsFolder, pgErrorCode, sql, withTenant, type Db } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png, sha256 } from './AC-ATT-support.js';
import { MATERIAL_PURPOSE } from './AC-EN-BE16-08-material-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';

const database = useTestDb();
const OLD_PURPOSES = ['exit.handwritten_application', 'personnel.subset_attachment'];

async function seedEmployee(db: Db, label: string) {
  const { tenant, user } = await seedTenantWithMember(db, label);
  const employeeId = randomUUID();
  await withTenant(db, tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO employment_employees (id,tenant_id,code,name)
      VALUES (${employeeId},${tenant.id},${employeeId},'ZZ_BE16_合成员工')`),
  );
  return { tenant, user, employeeId };
}
type Seed = Awaited<ReturnType<typeof seedEmployee>>;

/** 直接写一行登记文件（只验库约束）。 */
function insertFile(db: Db, seed: Seed, purpose: string) {
  const bytes = png();
  return withTenant(db, seed.tenant.id, (tx) =>
    tx.insert(attachmentFiles).values({
      id: randomUUID(),
      tenantId: seed.tenant.id,
      purpose,
      ownerUserId: seed.user.id,
      ownerEmployeeId: seed.employeeId,
      filename: 'cert.png',
      declaredType: 'image/png',
      byteSize: bytes.length,
      sha256: sha256(bytes),
    }),
  );
}

/** 把材料用途加入 CHECK 的那条迁移的标签后缀（按内容定位，迁移号由 merge:main 定，测试不依赖编号）。 */
function materialMigrationSuffix(): string | undefined {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tag = journal.entries
    .map((entry) => entry.tag)
    .find((name) => readFileSync(join(migrationsFolder, `${name}.sql`), 'utf8').includes(`'${MATERIAL_PURPOSE}'`));
  return tag?.replace(/^\d+/, '');
}

describe('AC-EN-BE16-08 迁移：只放宽 attachment_files_purpose', () => {
  it('升级路径：迁移前（旧 CHECK）登记材料用途被拒（23514 attachment_files_purpose），迁移后成功；旧用途行升级后原样保留', async () => {
    const suffix = materialMigrationSuffix();
    expect(suffix, '必须有一条迁移把 onboarding.material_attachment 加入 attachment_files_purpose').toBeDefined();
    const handle = await createTestDb({ migrateBefore: suffix! });
    try {
      const seed = await seedEmployee(handle.db, 'be16m-mig');
      for (const purpose of OLD_PURPOSES) await insertFile(handle.db, seed, purpose);
      const rejected = await insertFile(handle.db, seed, MATERIAL_PURPOSE).catch((error: unknown) => error);
      expect(pgErrorCode(rejected)).toBe('23514');
      expect(String((rejected as Error).cause ?? rejected)).toContain('attachment_files_purpose');
      await handle.migrate();
      await handle.migrate(); // 重复执行无副作用
      await insertFile(handle.db, seed, MATERIAL_PURPOSE);
      const purposes = await withTenant(handle.db, seed.tenant.id, (tx) =>
        tx.select({ purpose: attachmentFiles.purpose }).from(attachmentFiles),
      );
      expect(purposes.map((row) => row.purpose).sort()).toEqual([...OLD_PURPOSES, MATERIAL_PURPOSE].sort());
    } finally {
      await handle.close();
    }
  });

  it('只加一个用途：其余用途（含大小写变体、空串、前后空格）仍被 CHECK 拒绝', async () => {
    const seed = await seedEmployee(database().db, 'be16m-check');
    for (const purpose of [`${MATERIAL_PURPOSE} `, 'Onboarding.material_attachment', '', 'onboarding.material']) {
      const error = await insertFile(database().db, seed, purpose).catch((e: unknown) => e);
      expect(pgErrorCode(error), `purpose=${JSON.stringify(purpose)}`).toBe('23514');
    }
    await insertFile(database().db, seed, MATERIAL_PURPOSE);
  });
});
