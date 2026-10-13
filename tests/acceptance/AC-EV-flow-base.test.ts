/** C2-1a：活动级命令、评定终态与当前范围（设计 §3.2～3.5、§5.1、§8）。 */
import { randomUUID } from 'node:crypto';
import { APP_ROLE, pgErrorCode, sql, withTenant } from '@italent/db';
import { EVALUATION_FLOW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { activityFixtures, activityOperator, activityWorld } from './AC-EV-activity-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { auditApi } from './AC-AUD-support.js';
import { EV_NOW } from './AC-EV-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const BASE = '/api/tenant/evaluation';
const FLOW = EVALUATION_FLOW_OBJECTS.staffEvaluation;
const rows = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

describe('AC-EV-flow-base', () => {
  let w: Awaited<ReturnType<typeof activityWorld>>;
  let f: Awaited<ReturnType<typeof activityFixtures>>;
  beforeAll(async () => {
    w = await activityWorld(testDb().db);
    f = await activityFixtures(w);
  });
  const fresh = async () => w.adminActivity(f.body({ categoryIds: [(await w.qlCategory()).id] }));
  const action = (id: string, revision: number, name: string, key = randomUUID()) =>
    w.setup.request('POST', `${BASE}/activities/${id}/${name}`, {
      ...w.asAdmin,
      ifMatch: revision,
      idempotencyKey: key,
      body: {},
    });
  async function ok(response: Response, status = 200) {
    expect(response.status, await response.clone().text()).toBe(status);
    return response.json();
  }
  async function rejected(response: Response, reason: string) {
    expect(response.status, await response.clone().text()).toBe(409);
    expect(JSON.stringify(await response.json())).toContain(reason);
  }
  async function seed(activityId: string, employeeId: string, values: Record<string, unknown> = {}) {
    return withTenant(testDb().db, w.tenant.id, async (tx) => {
      const cycle = rows<{ id: string }>(
        await tx.execute(sql`SELECT id FROM employment_cycles
        WHERE tenant_id=${w.tenant.id}::uuid AND employee_id=${employeeId}::uuid`),
      )[0]!;
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO ev_staff_evaluations
        (id, tenant_id, activity_id, employee_id, cycle_id, source, initiator_user_id,
          apply_category_id, apply_level_id, created_by)
        VALUES (${id}, ${w.tenant.id}, ${activityId}, ${employeeId}, ${cycle.id}, 'self',
          ${w.asAdmin.user}, ${f.cat1.id}, ${f.lv1.id}, ${w.asAdmin.user})`);
      if (Object.keys(values).length) {
        const changes = Object.entries(values).map(([key, value]) => sql`${sql.identifier(key)}=${value}`);
        await tx.execute(sql`UPDATE ev_staff_evaluations SET ${sql.join(changes, sql`, `)}
          WHERE tenant_id=${w.tenant.id}::uuid AND id=${id}::uuid`);
      }
      return id;
    });
  }
  const read = (id: string) =>
    withTenant(
      testDb().db,
      w.tenant.id,
      async (tx) =>
        rows<Record<string, unknown>>(
          await tx.execute(sql`SELECT * FROM ev_staff_evaluations
      WHERE tenant_id=${w.tenant.id}::uuid AND id=${id}::uuid`),
        )[0]!,
    );

  it('草稿发布、原键重放、取消发布；非法状态与 revision 冲突不改活动', async () => {
    const a = await fresh();
    await rejected(await action(a.id, a.revision, 'unpublish'), 'ACTIVITY_STATE');
    const key = randomUUID();
    const published = await ok(await action(a.id, a.revision, 'publish', key));
    expect(published).toMatchObject({ id: a.id, status: 'published', revision: 2 });
    expect(await ok(await action(a.id, a.revision, 'publish', key))).toEqual(published);
    await rejected(await action(a.id, 1, 'unpublish'), 'REVISION_CONFLICT');
    await rejected(await action(a.id, 2, 'publish'), 'ACTIVITY_STATE');
    expect(await ok(await action(a.id, 2, 'unpublish'))).toMatchObject({ status: 'draft', revision: 3 });
    await w.setStatus(a.id, 'completed');
    await rejected(await action(a.id, 3, 'publish'), 'ACTIVITY_STATE');
    expect((await w.adminRead(a.id)).status).toBe('completed');
  });

  it('两个同范围草稿先后发布：后者 409；含下级与部分重叠使用保存侧同一规则', async () => {
    const child = await w.childOrg(w.orgA);
    const category = await w.qlCategory();
    const a = await w.adminActivity(f.body({ categoryIds: [category.id], orgRange: f.orgs(child) }));
    const b = await w.adminActivity(
      f.body({ categoryIds: [category.id], orgRange: [{ orgId: w.orgA, includeDescendants: true }] }),
    );
    await ok(await action(a.id, 1, 'publish'));
    await rejected(await action(b.id, 1, 'publish'), 'ACTIVITY_SCOPE_DUPLICATE');
    expect(await w.adminRead(b.id)).toMatchObject({ status: 'draft', revision: 1 });
  });

  it('取消发布须无报名，活动级授权不要求负责人或参评人都在人员范围内；重放撤权后拒绝', async () => {
    const a = await fresh();
    const op = await activityOperator(w, { evOrgs: [w.orgA], personOrgs: [] });
    const key = randomUUID();
    const post = (name: string, revision: number, command = randomUUID()) =>
      op.request('POST', `/activities/${a.id}/${name}`, { ifMatch: revision, body: {}, idempotencyKey: command });
    await ok(await post('publish', 1, key));
    await w.setApplyCount(a.id, 1);
    await rejected(await post('unpublish', 2), 'ACTIVITY_HAS_APPLICANTS');
    expect(await w.adminRead(a.id)).toMatchObject({ status: 'published', revision: 2 });
    await op.setEvOrgs([]);
    expect((await post('publish', 1, key)).status).toBe(404);
  });

  it('全列底座、唯一进行中谓词、三个终止原因；终态不动，重复终止不加审计，通知仅 pending', async () => {
    const kernel = await import('../../apps/api/src/modules/evaluation/flow-service.js');
    const a = await fresh();
    const states = [
      {},
      { apply_status: 'reviewing' },
      { material_status: 'failed' },
      { apply_status: 'failed' },
      { result_status: 'published' },
      { terminated_at: EV_NOW.toISOString(), terminated_reason: 'revoked' },
    ];
    const ids: string[] = [];
    for (const state of states) ids.push(await seed(a.id, f.mgrA.id, state));
    const before = await Promise.all(ids.map(read));
    for (const reason of ['leave', 'activity_completed', 'revoked'] as const) {
      await withTenant(testDb().db, w.tenant.id, (tx) =>
        kernel.terminateEvaluations(
          tx,
          {
            tenantId: w.tenant.id,
            userId: w.asAdmin.user,
            timezone: 'Asia/Shanghai',
            now: EV_NOW,
            commandId: randomUUID(),
            expectedRevision: 0,
          },
          ids,
          reason,
        ),
      );
    }
    const after = await Promise.all(ids.map(read));
    after.slice(0, 3).forEach((row) => expect(row).toMatchObject({ terminated_reason: 'leave', revision: 2 }));
    expect(after.slice(3)).toEqual(before.slice(3));
    const camel = (await import('../../apps/api/src/modules/evaluation/read-model.js')).view;
    for (const field of FLOW.fields) expect(camel(after[0]!)).toHaveProperty(field.code);
    const { isInProgress, inProgressSql } = kernel;
    expect(before.map((row) => isInProgress(camel(row)))).toEqual([true, true, true, false, false, false]);
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      expect(
        rows(
          await tx.execute(sql`SELECT id FROM ev_staff_evaluations e
        WHERE e.activity_id=${a.id}::uuid AND ${inProgressSql('e')}`),
        ),
      ).toHaveLength(0);
      const logs = rows(
        await tx.execute(sql`SELECT id FROM audit_events WHERE tenant_id=${w.tenant.id}::uuid
        AND action='evaluation.staff-evaluation.terminate' AND object_id=ANY(${`{${ids.join(',')}}`}::text[])`),
      );
      expect(logs).toHaveLength(3);
      const notices = rows<{ state: string }>(
        await tx.execute(sql`SELECT state FROM ev_notifications
        WHERE tenant_id=${w.tenant.id}::uuid AND activity_id=${a.id}::uuid`),
      );
      expect(notices).toHaveLength(3);
      expect(notices.every((notice) => notice.state === 'pending')).toBe(true);
    });
  });

  it('管理列表/详情与审计共用当前活动∧人员范围；分页前过滤，范围外不计数，字段裁剪', async () => {
    const a = await fresh();
    const inside = await seed(a.id, f.mgrA.id, { final_score: '88.25', effective_date: '2026-11-01' });
    const outside = await seed(a.id, f.mgrB.id, { final_score: '99.50' });
    const op = await activityOperator(w, { evOrgs: [w.orgA], auditor: true });
    const profile = await createProfile(w, `flow-${uniqueSuffix()}`, { apps: ['TEvaluation'] });
    await ok(
      await setObjectPermission(
        w,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          buttons: [],
          fields: FLOW.fields.map((field) => ({
            fieldCode: field.code,
            view: field.code !== 'finalScore',
            edit: false,
          })),
        },
        FLOW.code,
      ),
    );
    await makeGrantable(w, [profile.id]);
    await ok(await grant(w, op.userId, profile.id), 201);
    const path = `/staff-evaluations?activityId=${a.id}&pageSize=1`;
    const page = await ok(await op.request('GET', path));
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: inside, employeeId: f.mgrA.id, applyStatus: 'draft' });
    expect(page.items[0]).not.toHaveProperty('finalScore');
    expect(page.items[0].effectiveDate).toBe('2026-11-01');
    const detail = await ok(await op.request('GET', `/staff-evaluations/${inside}`));
    expect(detail.effectiveDate).toBe('2026-11-01');
    expect(detail).not.toHaveProperty('finalScore');
    expect((await op.request('GET', `/staff-evaluations/${outside}`)).status).toBe(404);
    const kernel = await import('../../apps/api/src/modules/evaluation/flow-service.js');
    await withTenant(testDb().db, w.tenant.id, (tx) =>
      kernel.terminateEvaluations(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.asAdmin.user,
          timezone: 'Asia/Shanghai',
          now: EV_NOW,
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        [inside, outside],
        'activity_completed',
      ),
    );
    const audit = auditApi(testDb().db, () => EV_NOW, { authorize: undefined });
    const query = { objectType: FLOW.code, action: 'evaluation.staff-evaluation.terminate' };
    const logs = await audit.dataChanges(op.as, query);
    expect(
      logs.items.filter((row) => [String(inside), String(outside)].includes(row.objectId)).map((row) => row.objectId),
    ).toEqual([inside]);
    expect(JSON.stringify(logs)).not.toContain('finalScore');
    const logId = logs.items.find((row) => row.objectId === inside)!.id;
    const auditDetail = await audit.dataChange(op.as, logId);
    expect(auditDetail.before).not.toHaveProperty('finalScore');
    expect(auditDetail.after).not.toHaveProperty('finalScore');
    expect(auditDetail.after).toMatchObject({ terminatedReason: 'activity_completed' });
    await op.setEvOrgs([]);
    expect((await ok(await op.request('GET', path))).total).toBe(0);
    expect((await audit.dataChanges(op.as, query)).items).toHaveLength(0);
    expect((await audit.get(`/data-changes/${logId}`, op.as)).status).toBe(404);
  });
  it('取消发布保留通知登记；无报名草稿仍可删除，删除快照保留通知历史', async () => {
    const a = await fresh();
    await ok(await action(a.id, 1, 'publish'));
    await ok(await action(a.id, 2, 'unpublish'));
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT id FROM ev_notifications WHERE activity_id=${a.id}::uuid`))).toHaveLength(
        1,
      );
    });
    await ok(await w.setup.request('DELETE', `${BASE}/activities/${a.id}`, { ...w.asAdmin, ifMatch: 3 }));
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const audit = rows<{ before: { notifications: unknown[] } }>(
        await tx.execute(sql`SELECT before
        FROM audit_events WHERE object_id=${a.id} AND action='evaluation.activity.delete'`),
      )[0]!;
      expect(audit.before.notifications).toHaveLength(1);
    });
  });

  it.each(['ev_staff_evaluations', 'ev_notifications'])(
    '标准租户上下文：%s 在租户设置为空时读不到记录，不抛 UUID 转换错误',
    async (table) => {
      const activity = await fresh();
      await seed(activity.id, f.mgrA.id);
      await withTenant(testDb().db, w.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO ev_notifications (tenant_id, activity_id, kind, dedupe_key)
          VALUES (${w.tenant.id}::uuid, ${activity.id}::uuid, 'activity_published', ${randomUUID()})`),
      );
      // 连接的事务级租户设置清空后应沿用 current_tenant_id() 的 fail-closed 语义。
      const found = await testDb().db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
        await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
        return rows(await tx.execute(sql`SELECT id FROM ${sql.identifier(table)}`));
      });
      expect(found).toEqual([]);
    },
  );

  it('复合外键拒绝错误周期/跨活动通知；租户 RLS 隔离；调用方回滚时终止、审计和通知一同回滚', async () => {
    const kernel = await import('../../apps/api/src/modules/evaluation/flow-service.js');
    const a = await fresh();
    const b = await fresh();
    const id = await seed(a.id, f.mgrA.id);
    const ctx = {
      tenantId: w.tenant.id,
      userId: w.asAdmin.user,
      timezone: 'Asia/Shanghai',
      now: EV_NOW,
      commandId: randomUUID(),
      expectedRevision: 0,
    };
    const before = await read(id);
    const fail = async (work: () => Promise<unknown>, code: string) => {
      let caught: unknown;
      try {
        await work();
      } catch (error) {
        caught = error;
      }
      expect(pgErrorCode(caught)).toBe(code);
    };
    await fail(() => seed(a.id, f.mgrA.id, { cycle_id: randomUUID() }), '23503');
    await fail(() => seed(a.id, f.mgrA.id, { employee_id: f.mgrB.id }), '23503');
    for (const invalid of [
      { source: 'invalid' },
      { target_version: 0 },
      { revision: 0 },
      { current_stage: 'invalid' },
      { apply_status: 'invalid' },
      { material_status: 'invalid' },
      { defense_status: 'invalid' },
      { result_status: 'invalid' },
      { terminated_reason: 'leave' },
      { terminated_at: EV_NOW.toISOString() },
    ])
      await fail(() => seed(a.id, f.mgrA.id, invalid), '23514');
    await fail(
      () =>
        withTenant(testDb().db, w.tenant.id, (tx) =>
          kernel.registerNotification(tx, ctx, {
            activityId: b.id,
            evaluationId: id,
            employeeId: f.mgrA.id,
            kind: 'test',
            dedupeKey: randomUUID(),
          }),
        ),
      '23503',
    );
    await withTenant(testDb().db, randomUUID(), async (tx) => {
      expect(rows(await tx.execute(sql`SELECT id FROM ev_staff_evaluations WHERE id=${id}::uuid`))).toEqual([]);
      expect(rows(await tx.execute(sql`SELECT id FROM ev_notifications`))).toEqual([]);
    });
    await expect(
      withTenant(testDb().db, w.tenant.id, async (tx) => {
        await kernel.terminateEvaluations(tx, ctx, [id], 'revoked');
        throw new Error('模拟业务回滚');
      }),
    ).rejects.toThrow('模拟业务回滚');
    expect(await read(id)).toEqual(before);
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      expect(
        rows(await tx.execute(sql`SELECT id FROM ev_notifications WHERE staff_evaluation_id=${id}::uuid`)),
      ).toHaveLength(0);
      expect(rows(await tx.execute(sql`SELECT id FROM audit_events WHERE object_id=${id}`))).toHaveLength(0);
      await kernel.terminateEvaluations(tx, ctx, [id], 'revoked');
    });
    expect(await read(id)).toMatchObject({ terminated_reason: 'revoked', revision: 2 });
  });
});
