/** AC-TRF-F481-10：执行真实 server.ts，确认有数据库时默认启动电子签调度。 */
import { afterEach, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  db: {},
  connected: true,
  start: vi.fn(() => ({ stop: async () => undefined })),
  serve: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/esign/scheduler.js', () => ({ startESignScheduler: startup.start }));
vi.mock('../../apps/api/src/modules/evaluation/leave-consumer.js', () => ({
  maybeStartLeaveConsumerScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/attachments/cleanup-scheduler.js', () => ({
  startAttachmentCleanupScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/offer/sync-scheduler.js', () => ({ startOfferSyncScheduler: vi.fn() }));
// 该依赖只装在 API 工作区；从根测试文件按裸包名 mock 会变成另一个虚拟模块。
vi.mock('../../apps/api/node_modules/@hono/node-server/dist/index.mjs', () => ({ serve: startup.serve }));
vi.mock('../../apps/api/src/app.js', () => ({ createApp: () => ({ fetch: vi.fn() }) }));
vi.mock('../../apps/api/src/database.js', () => ({
  databaseFromEnv: async () => (startup.connected ? { db: startup.db, driver: 'pg' } : null),
  localPgliteDir: vi.fn(),
}));
vi.mock('../../apps/api/src/identity.js', () => ({ identityResolverFromEnv: vi.fn() }));
vi.mock('../../apps/api/src/modules/qualification/sync-worker.js', () => ({
  maybeStartQualificationSyncScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/job/sequence-worker.js', () => ({ startSequenceSyncScheduler: vi.fn() }));
vi.mock('../../apps/api/src/modules/evaluation/review-group-exit-worker.js', () => ({
  startReviewGroupExitScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/personnel/order-code-scheduler.js', () => ({ startOrderCodeScheduler: vi.fn() }));
vi.mock('../../apps/api/src/modules/contracts/scheduler.js', () => ({ startContractScheduler: vi.fn() }));
vi.mock('../../apps/api/src/modules/employment/activation-scheduler.js', () => ({
  startEmploymentActivationScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/audit/retention.js', () => ({ startAuditRetentionScheduler: vi.fn() }));
vi.mock('../../apps/api/src/modules/succession/scheduler.js', () => ({ startSuccessionScheduler: vi.fn() }));
vi.mock('../../apps/api/src/modules/survey360/export-runtime.js', () => ({ exportStartupCheck: vi.fn() }));
vi.mock('../../apps/api/src/modules/survey360/credential-config.js', () => ({
  checkCredentialConfigAtStartup: () => ({ kdf: {} }),
}));
vi.mock('../../apps/api/src/modules/survey360/credential-maintenance.js', () => ({
  assertNoKeyRollback: vi.fn(),
  startCredentialMaintenanceScheduler: vi.fn(),
}));
vi.mock('../../apps/api/src/modules/survey360/credentials.js', () => ({ dummyDigest: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([true, false])('AC-TRF-F481-10 server 数据库连接=%s 的调度接线', async (connected) => {
  vi.resetModules();
  startup.connected = connected;
  await import('../../apps/api/src/server.js');
  expect(startup.serve).toHaveBeenCalledTimes(1);
  expect(startup.start).toHaveBeenCalledTimes(connected ? 1 : 0);
  if (connected) expect(startup.start).toHaveBeenCalledWith(startup.db);
});
