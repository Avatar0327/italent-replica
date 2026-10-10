import { startSequenceSyncScheduler } from './modules/job/sequence-worker.js';
import { startOrderCodeScheduler } from './modules/personnel/order-code-scheduler.js';
import { startContractScheduler } from './modules/contracts/scheduler.js';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { databaseFromEnv, localPgliteDir } from './database.js';
import { identityResolverFromEnv } from './identity.js';
import { startEmploymentActivationScheduler } from './modules/employment/activation-scheduler.js';
import { startAuditRetentionScheduler } from './audit/retention.js';
import { startSuccessionScheduler } from './modules/succession/scheduler.js';
import { exportStartupCheck } from './modules/survey360/export-runtime.js';
import { checkCredentialConfigAtStartup } from './modules/survey360/credential-config.js';
import {
  assertNoKeyRollback,
  startCredentialMaintenanceScheduler,
} from './modules/survey360/credential-maintenance.js';
import { dummyDigest } from './modules/survey360/credentials.js';

// F-080：360 报告 PDF / 报表 PNG 用项目内置的中文字体；字体缺失或被改动时这里抛错，进程拒绝启动（不再有缺字体 503）
await exportStartupCheck((line) => console.log(line));

// 生产环境未接入真实登录（B-01）时，这里直接抛错阻止启动，不回退到不安全的身份实现。
// 授权不在此注入：createApp 缺省使用权限模型授权器（R1-T01），默认拒绝。
const identity = identityResolverFromEnv();
// F-076：作答凭据 / outbox 加密密钥配置有误（缺失、长度不足、版本关系不合法）时进程拒绝启动
const credentialConfig = checkCredentialConfigAtStartup();
// 设 DATABASE_URL 连真 PG；只有 NODE_ENV=development 且未设时才用本地 PGlite 并自动迁移（F-025，见 database.ts）
const handle = await databaseFromEnv();
if (handle?.driver === 'pglite') {
  console.log(`开发环境未设 DATABASE_URL：使用本地 PGlite（${localPgliteDir()}），已执行迁移`);
  // PGlite 落盘：退出前关库，避免数据目录处于未刷写状态
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void handle.close().finally(() => process.exit(0)));
  }
}
// F-076：已登记的凭据密钥版本只增不减——部署回滚把旧 CURRENT 带回来时拒绝启动；并预热哑摘要（设计 §2.4、§3.8）
if (handle) await assertNoKeyRollback(handle.db, credentialConfig);
await dummyDigest(credentialConfig.kdf);
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
// R3-T05 继任定时任务（离职自动结束 sweep、职位风险、组织统计，DEC-343①）：任务随 PR 登记，没有任务时不起定时器。
if (handle && process.env.SUCCESSION_SCHEDULER !== 'off') {
  startSuccessionScheduler(handle.db, {
    intervalMs: Number(process.env.SUCCESSION_SCHEDULER_INTERVAL_MS || 900_000),
  });
}

// F-076 通用网址作答凭据维护任务（认领发放、清理过期会话与限频行）：多实例靠认领 CAS 与 SKIP LOCKED 去重，可关闭或调整间隔。
if (handle && process.env.SURVEY360_CREDENTIAL_MAINTENANCE_SCHEDULER !== 'off') {
  startCredentialMaintenanceScheduler(handle.db, {
    intervalMs: Number(process.env.SURVEY360_CREDENTIAL_MAINTENANCE_INTERVAL_MS || 60_000),
  });
}
