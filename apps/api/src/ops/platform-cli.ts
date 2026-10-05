/**
 * 平台运维命令行（R1-T17；docs/06_部署/01_部署运行手册.md）。只做参数解析与文件读写，业务全部委托给已测试的函数：
 *   grant-operator  --email <登录邮箱>                                   登记首位 / 新增平台运营身份（以“系统”记账）
 *   export          --tenant <租户ID> --out <文件>                       按租户导出加密备份（DATABASE_URL = 迁移角色）
 *   restore         --in <文件> --target-url <隔离库> [--hashes <json>]  导入隔离环境、隔离校验、授权对账（不开放）
 *   open            --in <文件> --target-url <隔离库>                    校验通过后开放访问
 * 环境变量：DATABASE_URL（现网，迁移角色）、BACKUP_ENCRYPTION_KEY（base64 的 32 字节密钥）、APP_VERSION（代码版本）。
 * 构建后运行：node apps/api/dist/ops/platform-cli.js <命令> ...
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  createPgDb,
  type DbHandle,
  eq,
  exportTenantBackup,
  grantPlatformOperator,
  openBackup,
  sealBackup,
  users,
  withPlatform,
} from '@italent/db';
import { captureAuthorizationState, openRestoredTenant, restoreTenant } from '../modules/platform/restore.js';

const meta = () => ({ actorUserId: null, commandId: `cli-${randomUUID()}` });

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function backupKey(): Buffer {
  const key = Buffer.from(required('BACKUP_ENCRYPTION_KEY', process.env.BACKUP_ENCRYPTION_KEY), 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY 须为 base64 编码的 32 字节');
  return key;
}

async function withDb<T>(url: string, fn: (handle: DbHandle) => Promise<T>): Promise<T> {
  const handle = createPgDb(url, { max: 2 });
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

/** 附件哈希表（运维从对象存储按清单算出的 { 附件ID: sha256 }）；部署接入对象存储后改为直接读取。 */
function hashStore(path: string | undefined) {
  const hashes = path ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
  return { sha256: async (id: string) => hashes[id] ?? null };
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      tenant: { type: 'string' },
      out: { type: 'string' },
      in: { type: 'string' },
      'target-url': { type: 'string' },
      hashes: { type: 'string' },
    },
  });
  const live = () => required('DATABASE_URL', process.env.DATABASE_URL);
  const sealed = () => openBackup(readFileSync(required('--in', values.in)), backupKey());
  switch (command) {
    case 'grant-operator':
      return withDb(live(), async ({ db }) => {
        const email = required('--email', values.email).toLowerCase();
        const [user] = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
        if (!user) throw new Error('账号不存在，请先建全局账号');
        return grantPlatformOperator(db, { userId: user.id, expectedRevision: 0 }, meta());
      });
    case 'export':
      return withDb(live(), async ({ db }) => {
        const tenantId = required('--tenant', values.tenant);
        const backup = await exportTenantBackup(
          db,
          { tenantId, codeVersion: process.env.APP_VERSION ?? 'unknown' },
          meta(),
        );
        writeFileSync(required('--out', values.out), sealBackup(backup, backupKey()), { mode: 0o600 });
        return { tenantId, takenAt: backup.manifest.takenAt, checksum: backup.manifest.checksum };
      });
    case 'restore': {
      const backup = sealed();
      const state = await withDb(live(), ({ db }) => captureAuthorizationState(db, backup.manifest.tenantId));
      return withDb(required('--target-url', values['target-url']), ({ db }) =>
        restoreTenant(db, { backup, live: state, attachments: hashStore(values.hashes) }, meta()),
      );
    }
    case 'open': {
      const backup = sealed();
      return withDb(required('--target-url', values['target-url']), ({ db }) =>
        openRestoredTenant(db, { tenantId: backup.manifest.tenantId }, meta(), backup),
      );
    }
    default:
      throw new Error(
        '用法：platform-cli <grant-operator|export|restore|open> [参数]，见 docs/06_部署/01_部署运行手册.md',
      );
  }
}

main(process.argv.slice(2)).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
