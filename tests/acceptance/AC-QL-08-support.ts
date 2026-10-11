/**
 * R3-T02 C1-6（AC-QL-08）发展通道查看的公共夹具：在 C1-3 的 currentWorld 上建
 * - 本类别标准（级别 P1 / P2 / P3，P2 有一条带能力标准的明细）与它的横向通道（P1 → 其他类别 P2；P3 → 其他类别 P3）；
 * - 其他类别的标准（级别 P1 / P2，P2 有明细），供“点横向目的地的级别看标准”；
 * - 没有标准的第三个类别（目的地无标准的情形）。
 * 配置经 PR-A 的真实接口创建（全部允许的授权钩子），查看请求按用例换授权器。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql } from '@italent/db';
import { expect } from 'vitest';
import type { useTestDb } from '@italent/testkit';
import { currentWorld } from './AC-QL-current-support.js';
import type { StandardView } from './AC-QL-support.js';
import { cmd } from './support/tenant-api.js';

export const MANAGEMENT = '/api/tenant/qualification/employees';
export const ESS = '/api/tenant/self-service';

export async function channelWorld(database: ReturnType<typeof useTestDb>, label: string) {
  const cw = await currentWorld(database, label);
  const { w, category, otherCategory, p1, p2, p3 } = cw;
  const klass = await w.categoryClass();
  const bareCategory = await w.category(klass.id);
  const type = await w.targetType();
  const ownTarget = await w.target(type.id, { name: '本类指标' });
  const otherTarget = await w.target(type.id, { name: '他类指标' });
  const standard = await w.standard({
    categoryId: category.id,
    levelIds: [p1.id, p2.id, p3.id],
    details: [{ levelId: p2.id, targetId: ownTarget.id, abilities: [{ content: '本类二级能力' }] }],
  });
  const otherStandard = await w.standard({
    categoryId: otherCategory.id,
    levelIds: [p1.id, p2.id],
    details: [{ levelId: p2.id, targetId: otherTarget.id, abilities: [{ content: '他类二级能力' }] }],
  });
  const put = await w.request('PUT', `/standards/${standard.id}/channels`, {
    ifMatch: standard.revision,
    body: {
      channels: [
        { levelId: p1.id, targetCategoryId: otherCategory.id, targetLevelId: p2.id },
        { levelId: p3.id, targetCategoryId: otherCategory.id, targetLevelId: p1.id },
        { levelId: p1.id, targetCategoryId: bareCategory.id, targetLevelId: p3.id },
      ],
    },
  });
  expect(put.status, await put.clone().text()).toBe(200);
  return { ...cw, standard: standard as StandardView, otherStandard, bareCategory, ownTarget, otherTarget };
}
export type ChannelWorld = Awaited<ReturnType<typeof channelWorld>>;

/** 建一个账号：本租户成员，并绑定到给定员工（本人入口的前提，permission_user_person_links）。 */
export async function boundUser(cw: ChannelWorld, employeeId: string, label = 'ess') {
  const user = await createUser(cw.db, { email: `${label}-${randomUUID()}@example.com`, displayName: label }, cmd());
  await grantMembership(cw.db, { tenantId: cw.w.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
  await cw.tx((t) =>
    t.execute(sql`INSERT INTO permission_user_person_links(tenant_id, user_id, employee_id)
      VALUES (${cw.w.tenant.id}, ${user.id}::uuid, ${employeeId}::uuid)`),
  );
  return { userId: user.id, as: { user: user.id, tenant: cw.w.tenant.id } };
}
