import { serve } from '@hono/node-server';
import { createPgDb } from '@italent/db';
import { createApp } from './app.js';
import { identityResolverFromEnv } from './identity.js';
import { startEmploymentActivationScheduler } from './modules/employment/activation-scheduler.js';

// 生产环境未接入真实登录（B-01）时，这里直接抛错阻止启动，不回退到不安全的身份实现。
// 授权不在此注入：createApp 缺省使用权限模型授权器（R1-T01），默认拒绝。
const identity = identityResolverFromEnv();
const databaseUrl = process.env.DATABASE_URL;
const handle = databaseUrl ? createPgDb(databaseUrl) : undefined;
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp(handle ? { db: handle.db, identity } : { identity }).fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

// R1-T08 定时生效：按租户时区到期落地（DEC-056）；多实例同时运行由员工行锁去重，可用环境变量关闭或调整间隔。
if (handle && process.env.EMPLOYMENT_ACTIVATION_SCHEDULER !== 'off') {
  const interval = Number(process.env.EMPLOYMENT_ACTIVATION_INTERVAL_MS || 300_000);
  startEmploymentActivationScheduler(handle.db, { intervalMs: interval });
}
