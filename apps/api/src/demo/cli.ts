/**
 * pnpm demo:seed 的入口（F-025）：只允许 NODE_ENV=development；打开与后端相同的数据库（本地 PGlite 或 DATABASE_URL），
 * 执行幂等种子，并把演示身份清单写到 `.demo/personas.json`（不入库，供 vite 开发代理与切换工具条读取）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { databaseFromEnv, LOCAL_DEMO_DIR } from '../database.js';
import { seedDemo } from './seed.js';

if (process.env.NODE_ENV !== 'development') {
  console.error(`演示种子只允许在 NODE_ENV=development 下运行（当前：${process.env.NODE_ENV ?? '未设置'}）`);
  process.exit(1);
}
const handle = await databaseFromEnv();
if (!handle) throw new Error('没有可用的数据库');
try {
  const { created, manifest } = await seedDemo(handle.db, { nodeEnv: 'development' });
  mkdirSync(LOCAL_DEMO_DIR, { recursive: true });
  writeFileSync(`${LOCAL_DEMO_DIR}personas.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[demo] ${created ? '已写入演示数据' : '演示数据已存在，未重复写入'}；租户 ${manifest.tenantId}`);
  for (const persona of manifest.personas) console.log(`[demo]   ${persona.role}：${persona.name}`);
} finally {
  await handle.close();
}
