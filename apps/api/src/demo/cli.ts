/**
 * 本地演示的命令行入口（F-025），只允许 NODE_ENV=development：
 * - 无参数（pnpm demo:seed）：打开与后端相同的数据库（本地 PGlite 或 DATABASE_URL），执行幂等种子，
 *   把演示身份清单写到 `.demo/personas.json`（不入库，供 vite 开发代理与切换工具条读取）；
 * - `reset`（pnpm demo:reset 的第一步）：经 resetLocalDatabase 删除本地 PGlite（与启动同一解析与校验）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { databaseFromEnv, LOCAL_DEMO_DIR, localPgliteDir, resetLocalDatabase } from '../database.js';
import { seedDemo } from './seed.js';

const MANIFEST = `${LOCAL_DEMO_DIR}personas.json`;

if (process.env.NODE_ENV !== 'development') {
  console.error(`演示命令只允许在 NODE_ENV=development 下运行（当前：${process.env.NODE_ENV ?? '未设置'}）`);
  process.exit(1);
}

try {
  if (process.argv[2] === 'reset') reset();
  else await seed();
} catch (error) {
  console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function reset(): void {
  const isDefault = localPgliteDir({ ...process.env, LOCAL_PGLITE_DIR: undefined }) === localPgliteDir();
  const dir = resetLocalDatabase();
  // 清单只对应缺省演示库；重置自定义目录时不动它（下一次种子会重新写）
  if (isDefault) rmSync(MANIFEST, { force: true });
  console.log(`[demo] 已删除本地演示数据：${dir}`);
}

async function seed(): Promise<void> {
  const handle = await databaseFromEnv();
  if (!handle) throw new Error('没有可用的数据库');
  try {
    const { created, manifest } = await seedDemo(handle.db, { nodeEnv: 'development' });
    mkdirSync(LOCAL_DEMO_DIR, { recursive: true });
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[demo] ${created ? '已写入演示数据' : '演示数据已存在，未重复写入'}；租户 ${manifest.tenantId}`);
    for (const persona of manifest.personas) console.log(`[demo]   ${persona.role}：${persona.name}`);
  } finally {
    await handle.close();
  }
}
