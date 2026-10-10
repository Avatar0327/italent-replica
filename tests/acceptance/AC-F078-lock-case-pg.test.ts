/**
 * AC-F078-lock-case-pg · 其余咨询锁键的 UUID 规范化（F-078；#182 第 4 轮同类排查；DEC-374⑦）：
 * qualification 级别顺序、contracts 配置、survey360 角色设置与作答、审批优先级、职务序列任务。
 * 同一租户 / 对象，一个请求用小写、一个用大写 UUID：必须排在同一把锁后面（串行）；试取锁（职务序列闸）必须被拒。
 */
import { useTestDb } from '@italent/testkit';
import { describe, it } from 'vitest';
import { lockApprovalPriority } from '../../apps/api/src/modules/approval/definitions.js';
import { lockContractConfig } from '../../apps/api/src/modules/contracts/configuration.js';
import { lockJobSequence, tryLockJobSequence } from '../../apps/api/src/modules/job/sequence-worker.js';
import { lockLevelOrder } from '../../apps/api/src/modules/qualification/config-service.js';
import { lockAppraiser } from '../../apps/api/src/modules/survey360/answering.js';
import { lockRoleSettings } from '../../apps/api/src/modules/survey360/settings.js';
import { expectSerializedBehind, expectTryLockRefused, uuidWithLetters, variants } from './support/lock-case.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(realPostgres)('其余咨询锁键大小写交错（真 PG）', () => {
  it('qualification 级别顺序：租户 UUID 的大小写变体串行', async () => {
    const tenant = variants(uuidWithLetters());
    await expectSerializedBehind(
      testDb().db,
      tenant.lower,
      `ql_levels:${tenant.lower}`,
      (tx) => lockLevelOrder(tx, tenant.upper),
      'hashtextextended',
    );
  });

  it('contracts 配置（设置 / 类型 / 规则三处共用）：租户 UUID 的大小写变体串行', async () => {
    const tenant = variants(uuidWithLetters());
    await expectSerializedBehind(testDb().db, tenant.lower, `${tenant.lower}:contract-config`, (tx) =>
      lockContractConfig(tx, tenant.upper),
    );
  });

  it('survey360 角色设置：租户 UUID 的大小写变体串行', async () => {
    const tenant = variants(uuidWithLetters());
    await expectSerializedBehind(testDb().db, tenant.lower, `${tenant.lower}:survey360-roles`, (tx) =>
      lockRoleSettings(tx, tenant.upper),
    );
  });

  it('survey360 作答：租户、活动、评价者 UUID 的大小写变体串行', async () => {
    const tenant = variants(uuidWithLetters());
    const activity = variants(uuidWithLetters());
    const person = variants(uuidWithLetters());
    await expectSerializedBehind(
      testDb().db,
      tenant.lower,
      `${tenant.lower}:survey360-answer:${activity.lower}:${person.lower}`,
      (tx) => lockAppraiser(tx, tenant.upper, activity.upper, person.upper),
    );
  });

  it('审批优先级：租户 UUID 的大小写变体串行（同类型）', async () => {
    const tenant = variants(uuidWithLetters());
    await expectSerializedBehind(testDb().db, tenant.lower, `approval_priority:${tenant.lower}:employment`, (tx) =>
      lockApprovalPriority(tx, tenant.upper, 'employment'),
    );
  });

  it('职务序列任务：租户 UUID 的大小写变体串行；试取锁被拒', async () => {
    const tenant = variants(uuidWithLetters());
    const db = testDb().db;
    await expectSerializedBehind(db, tenant.lower, `job-sequence:${tenant.lower}`, (tx) =>
      lockJobSequence(tx, tenant.upper),
    );
    await expectTryLockRefused(db, tenant.lower, `job-sequence:${tenant.lower}`, (tx) =>
      tryLockJobSequence(tx, tenant.upper),
    );
  });
});
