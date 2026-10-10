/**
 * AC-PRM-F078-lock-case-pg · 权限类咨询锁键的 UUID 规范化（F-078；#182 第 4 轮同类排查；DEC-374⑦）：
 * 许可（licenses）、范围策略（scope-policy-service）、管理单元层级（data-scope-admin）、人员绑定（user-provisioning）。
 * 同一租户 / 对象，一个请求用小写、一个用大写 UUID：必须排在同一把锁后面（串行），不能各拿各的。
 */
import { useTestDb } from '@italent/testkit';
import { describe, it } from 'vitest';
import { lockMouHierarchyOf } from '../../apps/api/src/modules/permission/data-scope-admin.js';
import { lockLicenseType } from '../../apps/api/src/modules/permission/licenses.js';
import { lockScopeObject } from '../../apps/api/src/modules/permission/scope-policy-service.js';
import { lockPersonLink } from '../../apps/api/src/modules/permission/user-provisioning.js';
import { expectSerializedBehind, uuidWithLetters, variants } from './support/lock-case.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(realPostgres)('权限类咨询锁键大小写交错（真 PG）', () => {
  it('许可：同租户同类许可，小写与大写租户 UUID 串行', async () => {
    const tenant = variants(uuidWithLetters());
    await expectSerializedBehind(testDb().db, tenant.lower, `${tenant.lower}:license:core_hr`, (tx) =>
      lockLicenseType(tx, tenant.upper, 'core_hr'),
    );
  });

  it('范围策略：租户与身份 UUID 的大小写变体串行（身份范围、范围应用、动态组织授权、范围策略共用 lockScopeObject）', async () => {
    const tenant = variants(uuidWithLetters());
    const profile = variants(uuidWithLetters());
    const grant = variants(uuidWithLetters());
    const db = testDb().db;
    await expectSerializedBehind(
      db,
      tenant.lower,
      `${tenant.lower}:identity-scope:${profile.lower}:app:entity:Org`,
      (tx) => lockScopeObject(tx, tenant.upper, `identity-scope:${profile.upper}:app:entity:Org`),
    );
    await expectSerializedBehind(db, tenant.lower, `${tenant.lower}:dynamic-org:${grant.lower}`, (tx) =>
      lockScopeObject(tx, tenant.upper, `dynamic-org:${grant.upper}`),
    );
    await expectSerializedBehind(db, tenant.lower, `${tenant.lower}:scope-app:TalentReview`, (tx) =>
      lockScopeObject(tx, tenant.upper, 'scope-app:TalentReview'),
    );
  });

  it('管理单元层级：租户 UUID 的大小写变体串行', async () => {
    const tenant = variants(uuidWithLetters());
    await expectSerializedBehind(testDb().db, tenant.lower, `${tenant.lower}:mou-hierarchy`, (tx) =>
      lockMouHierarchyOf(tx, tenant.upper),
    );
  });

  it('人员绑定：租户与账号 UUID 的大小写变体串行', async () => {
    const tenant = variants(uuidWithLetters());
    const user = variants(uuidWithLetters());
    await expectSerializedBehind(testDb().db, tenant.lower, `${tenant.lower}:person-link:${user.lower}`, (tx) =>
      lockPersonLink(tx, tenant.upper, user.upper),
    );
  });
});
