/**
 * F-361② 验收 09：迁移与 exit 入口隔离。作用对象：复刻系统（合成数据）。
 * DEC-937 的 1 个最小迁移只放宽 attachment_files_purpose：旧 CHECK 下登记新用途必须失败（红），迁移后成功；
 * exit 入口（员工自助）不接受、不暴露新用途的文件。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFiles, migrationsFolder, pgErrorCode, sql, withTenant, type Db } from '@italent/db';
import { createTestDb, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { attachmentWorld, png, registration, sha256 } from './AC-ATT-support.js';
import { PURPOSE } from './AC-PER-F361-support.js';
import { seedTenantWithMember } from './support/tenant-api.js';

const database = useTestDb();

/** 插入一行新用途的登记文件（直接写表：只验库约束）；成员与员工行先按旧结构造好。 */
async function registerNewPurpose(db: Db, tenantId: string, userId: string, employeeId: string) {
  const bytes = png();
  return withTenant(db, tenantId, (tx) =>
    tx.insert(attachmentFiles).values({
      id: randomUUID(),
      tenantId,
      purpose: PURPOSE,
      ownerUserId: userId,
      ownerEmployeeId: employeeId,
      filename: 'cert.png',
      declaredType: 'image/png',
      byteSize: bytes.length,
      sha256: sha256(bytes),
    }),
  );
}

async function seedEmployee(db: Db, label: string) {
  const { tenant, user } = await seedTenantWithMember(db, label);
  const employeeId = randomUUID();
  await withTenant(db, tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO employment_employees (id,tenant_id,code,name)
      VALUES (${employeeId},${tenant.id},${employeeId},'合成员工')`),
  );
  return { tenant, user, employeeId };
}

/** 放宽 attachment_files_purpose 的那条迁移的标签后缀（按内容定位，迁移号由 merge:main 定，测试不依赖编号）。 */
function purposeMigrationSuffix(): string | undefined {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tag = journal.entries
    .map((entry) => entry.tag)
    .find((name) => readFileSync(join(migrationsFolder, `${name}.sql`), 'utf8').includes(`'${PURPOSE}'`));
  return tag?.replace(/^\d+/, '');
}

describe('AC-PER-F361-09 迁移：只放宽 attachment_files_purpose', () => {
  it('升级路径：迁移前（旧 CHECK）登记新用途被拒（23514 attachment_files_purpose），迁移后成功；旧用途行不受影响', async () => {
    const suffix = purposeMigrationSuffix();
    expect(
      suffix,
      '必须有一条迁移把 personnel.subset_attachment 加入 attachment_files_purpose 的允许集合',
    ).toBeDefined();
    const handle = await createTestDb({ migrateBefore: suffix! });
    try {
      const seeded = await seedEmployee(handle.db, 'f361-mig');
      const rejected = await registerNewPurpose(handle.db, seeded.tenant.id, seeded.user.id, seeded.employeeId).catch(
        (error: unknown) => error,
      );
      expect(pgErrorCode(rejected)).toBe('23514');
      expect(String((rejected as Error).cause ?? rejected)).toContain('attachment_files_purpose');
      await handle.migrate();
      await handle.migrate();
      await registerNewPurpose(handle.db, seeded.tenant.id, seeded.user.id, seeded.employeeId);
      const purposes = await withTenant(handle.db, seeded.tenant.id, (tx) =>
        tx.select({ purpose: attachmentFiles.purpose }).from(attachmentFiles),
      );
      expect(purposes).toEqual([{ purpose: PURPOSE }]);
    } finally {
      await handle.close();
    }
  });

  it('只加一个用途：其余用途（含大小写变体、空串）仍被 CHECK 拒绝', async () => {
    const seeded = await seedEmployee(database().db, 'f361-check');
    const bytes = png();
    for (const purpose of ['personnel.subset_attachment ', 'Personnel.subset_attachment', '', 'exit.other']) {
      const error = await withTenant(database().db, seeded.tenant.id, (tx) =>
        tx.insert(attachmentFiles).values({
          id: randomUUID(),
          tenantId: seeded.tenant.id,
          purpose,
          ownerUserId: seeded.user.id,
          ownerEmployeeId: seeded.employeeId,
          filename: 'x.png',
          declaredType: 'image/png',
          byteSize: bytes.length,
          sha256: sha256(bytes),
        }),
      ).catch((e: unknown) => e);
      expect(pgErrorCode(error), `purpose=${JSON.stringify(purpose)}`).toBe('23514');
    }
  });

  it('exit 入口（员工自助）：登记新用途 400；按 ID 读 / 删别的用途文件 404（用途过滤）', async () => {
    const world = await attachmentWorld(database().db, 'f361-exit');
    const me = await world.person('合成本人甲');
    const refused = await world.register(me, { ...registration(png()), purpose: PURPOSE });
    expect(refused.status).toBe(400);
    // 同一员工名下的新用途文件（模拟 HR 为该员工上传、上传人恰为同一用户）：exit 入口读不到、删不掉
    await registerNewPurpose(database().db, world.w.tenant.id, me.userId, me.employeeId);
    const [row] = await withTenant(database().db, world.w.tenant.id, (tx) =>
      tx
        .select()
        .from(attachmentFiles)
        .where(sql`${attachmentFiles.purpose} = ${PURPOSE}`),
    );
    expect((await world.meta(me, row!.id)).status).toBe(404);
    expect((await world.content(me, row!.id)).status).toBe(404);
    expect((await world.remove(me, row!.id, row!.revision)).status).toBe(404);
  });
});
