import { startSequenceSyncScheduler } from './modules/job/sequence-worker.js';
import { startOrderCodeScheduler } from './modules/personnel/order-code-scheduler.js';
import { startContractScheduler } from './modules/contracts/scheduler.js';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { databaseFromEnv, localPgliteDir } from './database.js';
import { identityResolverFromEnv } from './identity.js';
import { startEmploymentActivationScheduler } from './modules/employment/activation-scheduler.js';
import { startAuditRetentionScheduler } from './audit/retention.js';

// 生产环境未接入真实登录（B-01）时，这里直接抛错阻止启动，不回退到不安全的身份实现。
// 授权不在此注入：createApp 缺省使用权限模型授权器（R1-T01），默认拒绝。
const identity = identityResolverFromEnv();
// 设 DATABASE_URL 连真 PG；只有 NODE_ENV=development 且未设时才用本地 PGlite 并自动迁移（F-025，见 database.ts）
const handle = await databaseFromEnv();
if (handle?.driver === 'pglite') {
  console.log(`开发环境未设 DATABASE_URL：使用本地 PGlite（${localPgliteDir()}），已执行迁移`);
  // PGlite 落盘：退出前关库，避免数据目录处于未刷写状态
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void handle.close().finally(() => process.exit(0)));
  }
}
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp(handle ? { db: handle.db, identity } : { identity }).fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});

// R1-T08 定时生效：按租户时区到期落地（DEC-056）；多实例同时运行由员工行锁去重，可用环境变量关闭或调整间隔。
if (handle && process.env.EMPLOYMENT_ACTIVATION_SCHEDULER !== 'off') {
  const interval = Number(process.env.EMPLOYMENT_ACTIVATION_INTERVAL_MS || 300_000);
  startEmploymentActivationScheduler(handle.db, { intervalMs: interval });
}

if (handle && process.env.CONTRACT_SCHEDULER !== 'off') startContractScheduler(handle.db);

// F-010 / DEC-170 / 15 §12：默认每 3 小时重算，所有实例通过租户 + 周期命令去重。
if (handle && process.env.PERSONNEL_ORDER_CODE_SCHEDULER !== 'off') {
  startOrderCodeScheduler(handle.db, {
    intervalMs: Number(process.env.PERSONNEL_ORDER_CODE_INTERVAL_MS || 10_800_000),
  });
}

if (handle && process.env.JOB_SEQUENCE_SYNC_SCHEDULER !== 'off') startSequenceSyncScheduler(handle.db);
// R1-T16 日志保留期：默认每天按各租户 audit.retention 清理一次过期日志（docs/02_业务建模/20 §5 第 4 条）。
if (handle && process.env.AUDIT_RETENTION_SCHEDULER !== 'off') {
  startAuditRetentionScheduler(handle.db, {
    intervalMs: Number(process.env.AUDIT_RETENTION_INTERVAL_MS || 86_400_000),
  });
}
