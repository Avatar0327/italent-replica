/**
 * 平台运维命令行（R1-T17；docs/06_部署/01_部署运行手册.md）。只做参数解析与文件读写，业务全部委托给已测试的函数：
 *   grant-operator  --email <登录邮箱>                                   登记首位 / 新增平台运营身份（以“系统”记账）
 *   export          --tenant <租户ID> --out <文件>                       按租户导出加密备份（DATABASE_URL = 迁移角色）
 *   restore         --in <文件> --target-url <隔离库> [--hashes <json>] [--command-id <ID>]
 *                   导入隔离环境、隔离校验、授权对账（不开放）
 *   open            --in <文件> --target-url <隔离库> [--command-id <ID>]  开放前再次对账现网，通过后开放访问
 *   rebind-calc-formulas --tenant <租户ID> [--retry-unresolved] [--command-id <ID>]
 *                   F-082：把该租户的存量计算公式改绑为按字段 ID（契约 §6.1；开关打开后对每个租户执行一次，报告里
 *                   unresolved 的租户通知其管理员修公式）。报告只有 ID 与原因码
 * 恢复与开放可带 --command-id：结果未知时用同一 ID 重试，已完成的阶段直接返回首次结果（不重复执行）。
 * 连接角色必须是迁移角色（表属主），非超级用户、不带 BYPASSRLS（受 FORCE RLS 约束），否则拒绝执行。
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
  sql,
  grantPlatformOperator,
  openBackup,
  sealBackup,
  users,
  withPlatform,
} from '@italent/db';
import { applicationNameFromEnv } from '../database.js';
import { openRestoredTenant, restoreTenant } from '../modules/platform/restore.js';
import { rebindCalcFormulas } from '../modules/talent-review/calc-rebind-command.js';

const meta = (commandId?: string) => ({ actorUserId: null, commandId: commandId ?? `cli-${randomUUID()}` });

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function backupKey(): Buffer {
  const key = Buffer.from(required('BACKUP_ENCRYPTION_KEY', process.env.BACKUP_ENCRYPTION_KEY), 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY 须为 base64 编码的 32 字节');
  return key;
}

/** 恢复 / 导出只用迁移角色：超级用户或 BYPASSRLS 会绕过租户隔离的数据库兜底，一律拒绝。 */
async function assertRestrictedRole(handle: DbHandle) {
  const result = await handle.db.execute(
    sql`SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname = current_user`,
  );
  const [row] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { privileged: boolean }[];
  if (row?.privileged !== false) throw new Error('连接角色是超级用户或带 BYPASSRLS，拒绝执行；请改用迁移角色');
}

async function withDb<T>(url: string, fn: (handle: DbHandle) => Promise<T>): Promise<T> {
  // 带 italent-api: 前缀：F-082 的部署检查脚本把它也算作应用连接（运维命令没跑完就不能首次启用）
  const handle = createPgDb(url, { max: 2, applicationName: applicationNameFromEnv() });
  try {
    await assertRestrictedRole(handle);
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
      'command-id': { type: 'string' },
      'retry-unresolved': { type: 'boolean' },
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
      return withDb(live(), (source) =>
        withDb(required('--target-url', values['target-url']), ({ db }) =>
          restoreTenant(
            db,
            { backup, live: source.db, attachments: hashStore(values.hashes) },
            meta(values['command-id']),
          ),
        ),
      );
    }
    case 'open': {
      const backup = sealed();
      return withDb(live(), (source) =>
        withDb(required('--target-url', values['target-url']), ({ db }) =>
          openRestoredTenant(
            db,
            { tenantId: backup.manifest.tenantId, live: source.db, backup },
            meta(values['command-id']),
          ),
        ),
      );
    }
    case 'rebind-calc-formulas':
      return withDb(live(), ({ db }) =>
        rebindCalcFormulas(
          db,
          required('--tenant', values.tenant),
          { retryUnresolved: values['retry-unresolved'] === true },
          meta(values['command-id']),
        ),
      );
    default:
      throw new Error(
        '用法：platform-cli <grant-operator|export|restore|open|rebind-calc-formulas> [参数]，见 docs/06_部署/01_部署运行手册.md',
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
