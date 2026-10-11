/**
 * 360 通用网址作答凭据的平台运维命令行（F-076 设计 §2.4、§2.4.1）。只做参数解析，业务委托给
 * modules/survey360/credential-ops.ts（已测试）：
 *   rotate  --to <版本>                                 登记密钥轮换，每租户写一条 key_rotated
 *   retire  --version <版本> [--compromised] [--resume <运行ID>] [--tenant <租户ID>]
 *                                                       计划退役 / 泄露处置的落库清理，输出手动重发清单（不含凭据）
 *   stats   --version <版本>                            按租户 / 活动统计仍以该版本存摘要的有效凭据数
 * 环境变量：DATABASE_URL（迁移角色，非超级用户、不带 BYPASSRLS）、SURVEY360_CREDENTIAL_*（与应用同一份配置）。
 * 构建后运行：node apps/api/dist/ops/survey360-credentials.js <命令> ...
 */
import { parseArgs } from 'node:util';
import { createPgDb, sql } from '@italent/db';
import { applicationNameFromEnv } from '../database.js';
import { credentialConfig } from '../modules/survey360/credential-config.js';
import { credentialStats, retireKeys, rotateKeys } from '../modules/survey360/credential-ops.js';

function version(name: string, text: string | undefined): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 须为正整数版本号`);
  return value;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      to: { type: 'string' },
      version: { type: 'string' },
      compromised: { type: 'boolean' },
      resume: { type: 'string' },
      tenant: { type: 'string' },
    },
  });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('缺少 DATABASE_URL');
  const config = credentialConfig();
  // 带 italent-api: 前缀：F-082 的部署检查脚本按它数应用连接（运维命令没跑完就不能首次启用）
  const handle = createPgDb(url, { max: 2, applicationName: applicationNameFromEnv() });
  try {
    // 超级用户或 BYPASSRLS 会绕过租户隔离的数据库兜底，一律拒绝（同 platform-cli）
    const result = await handle.db.execute(
      sql`SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname = current_user`,
    );
    const [role] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { privileged: boolean }[];
    if (role?.privileged !== false) throw new Error('连接角色是超级用户或带 BYPASSRLS，拒绝执行；请改用迁移角色');
    switch (command) {
      case 'rotate':
        return await rotateKeys(handle.db, { to: version('--to', values.to), config });
      case 'retire':
        return await retireKeys(handle.db, {
          version: version('--version', values.version),
          compromised: values.compromised === true,
          config,
          ...(values.resume ? { resumeRunId: values.resume } : {}),
          ...(values.tenant ? { tenantId: values.tenant } : {}),
        });
      case 'stats':
        return await credentialStats(handle.db, { version: version('--version', values.version) });
      default:
        throw new Error('用法：survey360-credentials <rotate|retire|stats> [参数]，见 docs/06_部署/01_部署运行手册.md');
    }
  } finally {
    await handle.close();
  }
}

main(process.argv.slice(2)).then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
