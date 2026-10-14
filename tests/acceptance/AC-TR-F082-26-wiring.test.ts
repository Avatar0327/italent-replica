/**
 * F-082 AC-26（字段目录版本接线，契约 §1.3）：新建 / 改名 / 删除、预置字段安装（开通与 DEC-361 回补）、租户恢复都推进版本；
 * 种子补装在全部登记项（含其后的预置九宫格）装完后统一推进**一次**；停用不推进；
 * 源码扫描：talent-review 模块与种子里对 talent_review_fields 的 insert / delete / 改名更新调用点都经过 bumpFieldCatalog。
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openRestoredTenant, restoreTenant } from '@italent/api';
import { createTestDb, useTestDb } from '@italent/testkit';
import { exportTenantBackup, sql, withTenant, type Db } from '@italent/db';
import { afterAll, describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { f082World, catalogVersion } from './AC-TR-F082-support.js';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

describe('AC-26 种子补装：统一推进一次', () => {
  it('缺预置字段 / 九宫格的租户回补：版本推进（只在事务末尾一次）；再次回补什么都不缺则不推进', async () => {
    const db = testDb().db;
    const w = await f082World(db, 'f082-w1');
    const before = await catalogVersion(db, w);
    const run = () =>
      withTenant(db, w.as.tenant, (tx) =>
        installMissingSeeds(tx, { tenantId: w.as.tenant, actorUserId: null, now: new Date(), commandId: randomUUID() }),
      );
    const first = await run();
    expect(first.some((item) => item.installed.length > 0)).toBe(true);
    const afterFirst = await catalogVersion(db, w);
    expect(afterFirst).toBeGreaterThan(before);
    const second = await run();
    expect(second.every((item) => item.installed.length === 0)).toBe(true);
    expect(await catalogVersion(db, w)).toBe(afterFirst);
  });
});

describe('AC-26 租户恢复（DEC-061）：恢复后的版本不会回到备份里的旧值', () => {
  it('备份之后现网又推进了版本：恢复开放后的版本大于现网已发出的值', async () => {
    const live = testDb().db;
    const api = tenantApi(live, { authorize: undefined });
    const operator = await seedOperator(live);
    const admin = await newUser(live, 'f082-restore-admin');
    const tenant = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id });
    const as = { user: admin.id, tenant: tenant.tenant.id };
    const versionOf = async (db: Db) =>
      withTenant(db, tenant.tenant.id, async (tx) =>
        Number(
          rowsOf<{ version: string }>(
            await tx.execute(sql`SELECT version::text AS version FROM talent_review_field_catalog_versions`),
          )[0]?.version ?? 0,
        ),
      );
    expect(await versionOf(live)).toBeGreaterThan(0); // 开通时预置字段安装推进了版本
    const backup = await exportTenantBackup(
      live,
      { tenantId: tenant.tenant.id, codeVersion: 'f082' },
      cmd(operator.id),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fixture = tenantApi(live);
    const created = await fixture.request('POST', '/api/tenant/talent-review/fields', {
      ...as,
      ifMatch: 0,
      body: { code: 'after_backup', name: '备份之后建的', kind: 'number', group: 'result' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const liveVersion = await versionOf(live);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const handle = await createTestDb();
    try {
      const report = await restoreTenant(
        handle.db,
        { backup, live, attachments: { sha256: async () => null } },
        cmd(operator.id),
      );
      expect(report.ok, JSON.stringify(report.reconciliation)).toBe(true);
      await openRestoredTenant(handle.db, { tenantId: tenant.tenant.id, live, backup }, cmd(operator.id));
      expect(await versionOf(handle.db)).toBeGreaterThan(liveVersion);
    } finally {
      await handle.close();
    }
  }, 120_000);
});

describe('AC-26 源码扫描：字段表的写入调用点都经过 bumpFieldCatalog', () => {
  const root = join(__dirname, '../../apps/api/src');
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );
  const source = (path: string) => readFileSync(join(root, path), 'utf8');
  const scanned = [...files('modules/talent-review'), ...files('seeds'), 'modules/platform/restore.ts'].filter(
    (path) => !path.endsWith('.test.ts'),
  );

  /** 对字段表的 insert / delete，或带 name（或展开整个补丁）的 update。 */
  const WRITES = [
    /\.insert\(\s*(?:F|talentReviewFields)\s*\)/,
    /\.delete\(\s*(?:F|talentReviewFields)\s*\)/,
    /\.update\(\s*(?:F|talentReviewFields)\s*\)\s*\.set\(\s*\{[^}]*(?:\bname\b|\.\.\.)/,
    /(?:createConfig|updateConfig|deleteConfig|lockConfigRow)\(\s*tx\s*,\s*FIELD\b/,
  ];

  it('有字段写入的文件都引用 bumpFieldCatalog（或返回 catalogChanged 交给补装统一推进）', () => {
    const offenders = scanned.filter(
      (path) =>
        WRITES.some((pattern) => pattern.test(source(path))) && !/bumpFieldCatalog|catalogChanged/.test(source(path)),
    );
    expect(offenders).toEqual([]);
  });

  it('field-service 的新建 / 改名 / 删除入口各自调用 bumpFieldCatalog；预置字段安装返回 catalogChanged 而不直接推进', () => {
    const service = source('modules/talent-review/field-service.ts');
    for (const name of ['createField', 'updateField', 'deleteField']) {
      const start =
        service.indexOf(`export async function ${name}`) >= 0
          ? service.indexOf(`export async function ${name}`)
          : service.indexOf(`export function ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const next = service.indexOf('\nexport ', start + 10);
      expect(service.slice(start, next < 0 ? undefined : next), name).toMatch(/bumpFieldCatalog/);
    }
    const presets = source('modules/talent-review/presets.ts');
    expect(presets).toMatch(/catalogChanged/);
    expect(presets).not.toMatch(/bumpFieldCatalog\(/);
  });

  it('租户恢复的校验步骤里调用 bumpFieldCatalog', () => {
    expect(source('modules/platform/restore.ts')).toMatch(/bumpFieldCatalog\(/);
  });

  afterAll(() => undefined);
});
