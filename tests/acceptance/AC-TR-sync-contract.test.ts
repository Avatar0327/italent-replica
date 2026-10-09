/**
 * R3-T04 PR-A：用共用契约套件（tests/acceptance/support/sync-port-contract.ts，SP-18）跑内存替身。
 * PR-D 的真实实现与 T05 的用例各自引用套件、传入自己的工厂，不会重复跑这里的替身。
 */
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { runSyncPortContractSuite, type SyncPortFactory } from './support/sync-port-contract.js';

/** 替身工厂：替身自身就是控制面（transaction 失败只回滚本事务，消费记录按 S / X 锁等待）。 */
const inMemoryFactory: SyncPortFactory = async (fixture) => {
  const port = createInMemoryTalentReviewSyncPort(fixture);
  return {
    port,
    transaction: (work) => port.transaction(work),
    supersede: (runId) => port.supersede(runId),
    revoke: async (change) => port.revoke(change),
    denyViewer: async (userId, denied) => port.denyViewer(userId, denied),
    denyHealthWrite: async (userId, access) => port.denyHealthWrite(userId, access),
    endProject: async (projectId) => port.endProject(projectId),
    advance: async (seconds) => port.advance(seconds),
  };
};

runSyncPortContractSuite('内存替身', inMemoryFactory);
