/** DEC-447：执行真实 server.ts 装配路径，屏蔽网络与无关调度器。 */
import { afterEach, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  db: {},
  connected: true,
  start: vi.fn(() => ({ stop: async () => undefined })),
}));
vi.mock('../../apps/api/src/modules/employment/outbox-consumer.js', () => ({
  startEmploymentOutboxConsumer: startup.start,
}));
vi.mock('@hono/node-server', () => ({ serve: vi.fn() }));
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

it.each([
  { connected: true, leave: undefined, qualification: 'off', starts: 1, interval: undefined },
  { connected: true, leave: 'on', qualification: 'off', starts: 1, interval: '30' },
  { connected: true, leave: 'off', qualification: undefined, starts: 0, interval: undefined },
  { connected: false, leave: undefined, qualification: undefined, starts: 0, interval: undefined },
])('AC-EV-leave-consumer server 启动：%j', async ({ connected, leave, qualification, starts, interval }) => {
  vi.resetModules();
  startup.connected = connected;
  vi.stubEnv('LEAVE_CONSUMER_SCHEDULER', leave);
  vi.stubEnv('LEAVE_CONSUMER_INTERVAL_MS', interval);
  vi.stubEnv('QUALIFICATION_SYNC_SCHEDULER', qualification);
  const { registerLeaveConsumer } = await import('../../apps/api/src/modules/evaluation/leave-consumer.js');
  const consumer = {
    kind: 'evaluation_leave',
    commandPrefix: 'evaluation-leave',
    label: '测试离职消费',
    handle: async () => ({ state: 'done' as const, reason: null }),
  };
  const dispose = registerLeaveConsumer(consumer);
  try {
    await import('../../apps/api/src/server.js');
    expect(startup.start).toHaveBeenCalledTimes(starts);
    if (starts) expect(startup.start).toHaveBeenCalledWith(startup.db, consumer, Number(interval ?? 5000));
  } finally {
    dispose();
  }
});
