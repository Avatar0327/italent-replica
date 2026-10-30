/**
 * AC-OA-30（R2-T08 §7.6）：执行期间暂停涉及组织与人员的新变动；离职 / 退休不受限，本单执行上下文豁免。
 * 夹具：P → A（空部门）；D（含 e1）→ D1；B（含 e2）。暂停覆盖 A、D、D1（直接写暂停行，模拟执行开始）。
 * F-274：停用外部祖先 P 时按 planDeactivation 返回的实际级联集合判定，A 在暂停中 → 409，P / A 版本与 revision 不变。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assertNotPausedByOrgAdjustment } from '../../apps/api/src/modules/org-adjustment/pause.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { orgPeopleWorld, resultRows, TODAY } from './AC-ORG-people-support.js';
import { pauseOrgs, seedAdjustment } from './support/org-adjustment-execution.js';

const testDb = useTestDb();

async function pausedWorld(label: string) {
  const db = testDb().db;
  const w = await orgPeopleWorld(db, label);
  await installApprovalFallbacks(db, w.tenant.id, w.user.id);
  const p = await w.org('外部祖先P');
  const a = await w.org('空部门A', p.id);
  const d = await w.org('部门D');
  const d1 = await w.org('下级D1', d.id);
  const b = await w.org('部门B');
  const b2 = await w.org('部门B2', b.id);
  const e1 = await w.hire('员工一', { departmentId: d.id });
  const e2 = await w.hire('员工二', { departmentId: b.id });
  const adjustment = await seedAdjustment(db, w.tenant.id, {
    createdBy: w.user.id,
    subjectOrgId: d.id,
    effectiveDate: TODAY,
  });
  return { w, db, p, a, d, d1, b, b2, e1, e2, adjustment };
}

type World = Awaited<ReturnType<typeof pausedWorld>>;

async function expectPaused(world: World, response: Response) {
  expect(response.status, await response.clone().text()).toBe(409);
  const body = (await response.json()) as { error: { code: string; details: Record<string, unknown> } };
  expect(body.error).toMatchObject({
    code: 'CONFLICT',
    details: { reason: 'ORG_ADJUSTMENT_EXECUTING', adjustmentCode: world.adjustment.code },
  });
}

async function orgState(world: World, ids: readonly string[]) {
  return withTenant(world.db, world.w.tenant.id, async (tx) =>
    resultRows<{ id: string; revision: number; versions: number }>(
      await tx.execute(sql`SELECT o.id, o.revision,
          (SELECT count(*)::int FROM org_versions v WHERE v.tenant_id=o.tenant_id AND v.org_id=o.id) AS versions
        FROM org_objects o WHERE o.id=ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY o.id`),
    ),
  );
}

const pause = (world: World) =>
  pauseOrgs(world.db, world.w.tenant.id, world.adjustment.id, [world.a.id, world.d.id, world.d1.id]);

async function businessResponse(world: World, employeeId: string, body: Record<string, unknown>) {
  const { revision } = await world.w.getEmployee(employeeId);
  return world.w.request('POST', `/employees/${employeeId}/businesses`, { ifMatch: revision, body });
}

describe('AC-OA-30 执行期间暂停：任职入口', () => {
  it('入职 / 调入 / 调出 / 记录编辑 / 批量编辑 / 提交草稿 → 409；离职、暂停外的变动照常', async () => {
    const world = await pausedWorld('oa30-emp');
    const { w, d, d1, b, b2, e1, e2 } = world;
    const draftResponse = await businessResponse(world, e2.id, {
      kind: 'transfer',
      mode: 'application',
      effectiveDate: '2026-10-05',
      fields: { departmentId: d1.id },
    });
    expect(draftResponse.status, await draftResponse.clone().text()).toBe(201);
    const draft = (await draftResponse.json()) as { id: string; revision: number };
    await pause(world);

    const newcomer = await w.employee('新人');
    await expectPaused(
      world,
      await w.request('POST', `/employees/${newcomer.id}/businesses`, {
        ifMatch: newcomer.revision,
        body: withLoginEmail(newcomer.id, {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: TODAY,
          fields: { employType: 'internal', departmentId: d.id },
        }),
      }),
    );
    const transfer = (employeeId: string, departmentId: string) =>
      businessResponse(world, employeeId, {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-10-03',
        fields: { departmentId },
      });
    await expectPaused(world, await transfer(e2.id, d.id));
    await expectPaused(world, await transfer(e1.id, b.id));
    const record = await w.record(e1.recordId);
    await expectPaused(
      world,
      await w.request('PATCH', `/records/${e1.recordId}`, {
        ifMatch: record.revision,
        body: { fields: { remarks: '改' } },
      }),
    );
    const batch = await w.request('POST', '/records/batch-edit', {
      body: { items: [{ id: e1.recordId, revision: record.revision }], patch: { fields: { remarks: '批量' } } },
    });
    expect(batch.status, await batch.clone().text()).not.toBe(200);
    expect(JSON.stringify(await batch.json())).toContain('ORG_ADJUSTMENT_EXECUTING');
    await expectPaused(
      world,
      await w.request('POST', `/businesses/${draft.id}/submit`, { ifMatch: draft.revision, body: {} }),
    );

    expect((await transfer(e2.id, b2.id)).status, 'B 内部调动不受影响').toBe(201);
    const leave = await businessResponse(world, e1.id, {
      kind: 'leave',
      mode: 'direct',
      effectiveDate: '2026-10-08',
      lastWorkDate: '2026-10-07',
    });
    expect(leave.status, `离职不受暂停限制：${await leave.clone().text()}`).toBe(201);
  });

  it('已审批的申请在暂停中到达“通过”也 409（审批通过 ≠ 生效，判定在落版本链之前）', async () => {
    const world = await pausedWorld('oa30-approve');
    const draft = (await (
      await businessResponse(world, world.e2.id, {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: '2026-10-05',
        fields: { departmentId: world.d.id },
      })
    ).json()) as { id: string; revision: number };
    const submitted = await world.w.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status).toBe(200);
    const reviewing = (await submitted.json()) as { revision: number };
    await pause(world);
    const approving = runEmploymentTransition(
      world.db,
      {
        tenantId: world.w.tenant.id,
        userId: world.w.user.id,
        timezone: world.w.tenant.timezone,
        now: new Date(`${TODAY}T01:00:00Z`),
        commandId: randomUUID(),
        expectedRevision: reviewing.revision,
      },
      { id: draft.id, action: 'approve' },
    );
    await expect(approving).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ORG_ADJUSTMENT_EXECUTING' },
    });
  });
});

describe('AC-OA-30 执行期间暂停：组织与职位入口', () => {
  it('新建 / 改名 / 移入 / 导入 / 更正设立日期 / 外部祖先停用（F-274）→ 409，且不留版本与 revision 变化', async () => {
    const world = await pausedWorld('oa30-org');
    const { w, p, a, d, b, b2 } = world;
    await pause(world);
    const fresh = async (id: string) => (await w.orgsAt(TODAY)).get(id)!;

    const created = await w.call('POST', 'org/organizations', {
      ifMatch: 0,
      body: { name: '暂停下新建', parents: { admin: { parentId: a.id } } },
    });
    await expectPaused(world, created);
    await expectPaused(
      world,
      await w.patchOrg(await fresh(d.id), { effectiveDate: '2026-10-05', name: 'D改名', addEmployment: false }),
    );
    await expectPaused(
      world,
      await w.patchOrg(await fresh(b.id), {
        effectiveDate: '2026-10-05',
        parents: { admin: { parentId: d.id } },
        addEmployment: false,
      }),
    );
    const target = await fresh(d.id);
    await expectPaused(
      world,
      await w.call('POST', 'org/import', {
        ifMatch: 0,
        idempotencyKey: randomUUID(),
        body: {
          rows: [
            {
              sourceCode: target.id,
              orgId: target.id,
              code: target.code,
              name: '导入改名',
              parentId: w.tenant.id,
              expectedRevision: target.revision,
              startDate: '2026-10-09',
              addEmployment: false,
            },
          ],
        },
      }),
    );

    const before = await orgState(world, [p.id, a.id, d.id]);
    // 更正设立日期只受上级设立日约束：取暂停中的顶层 D 更正（D1 的上级 D 设立于 TODAY，无法更早）。
    const sub = await fresh(d.id);
    await expectPaused(
      world,
      await w.call('PATCH', `org/organizations/${d.id}/correction`, {
        ifMatch: sub.revision,
        body: { establishedOn: '2026-09-15' },
      }),
    );
    await expectPaused(world, await w.patchOrg(await fresh(p.id), { enabled: false, effectiveDate: '2026-10-02' }));
    expect(await orgState(world, [p.id, a.id, d.id]), '更正与外部祖先停用都整体回滚').toEqual(before);

    const renamed = await w.patchOrg(await fresh(b2.id), {
      effectiveDate: '2026-10-05',
      name: 'B2改名',
      addEmployment: false,
    });
    expect(renamed.status, '暂停外组织照常').toBe(200);
  });

  it('职位：新建在暂停组织 / 改挂到暂停组织 → 409；暂停外照常', async () => {
    const world = await pausedWorld('oa30-job');
    const { w, d, b } = world;
    const post = await w.job('posts', '暂停矩阵职务');
    const position = await w.job('positions', '部门B职位', { orgId: b.id, postId: post.id });
    await pause(world);
    await expectPaused(
      world,
      await w.call('POST', 'job/positions', {
        ifMatch: 0,
        body: {
          name: '暂停中新职位',
          code: `J${randomUUID().replaceAll('-', '')}`,
          startDate: TODAY,
          orgId: d.id,
          postId: post.id,
        },
      }),
    );
    await expectPaused(
      world,
      await w.call('PATCH', `job/positions/${position.id}`, {
        ifMatch: position.revision,
        body: { orgId: d.id, effectiveDate: '2026-10-05' },
      }),
    );
    const moved = await w.call('PATCH', `job/positions/${position.id}`, {
      ifMatch: position.revision,
      body: { name: '部门B职位改名', effectiveDate: '2026-10-05' },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
  });

  it('本单执行上下文豁免：orgAdjustmentId 等于暂停所属单时放行，其他单仍拦', async () => {
    const world = await pausedWorld('oa30-self');
    await pause(world);
    const check = (orgAdjustmentId?: string) =>
      withTenant(world.db, world.w.tenant.id, (tx) =>
        assertNotPausedByOrgAdjustment(
          tx,
          { tenantId: world.w.tenant.id, orgAdjustmentId },
          { employeeId: world.e1.id, departmentIds: [world.b.id], date: TODAY },
        ),
      );
    await expect(check(world.adjustment.id)).resolves.toBeUndefined();
    await expect(check(randomUUID())).rejects.toMatchObject({ details: { reason: 'ORG_ADJUSTMENT_EXECUTING' } });
    await expect(check(), '按员工当前主职部门命中').rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
