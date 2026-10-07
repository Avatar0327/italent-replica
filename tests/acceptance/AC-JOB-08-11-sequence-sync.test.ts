import { now, worker, callAt, scenario, versions } from './AC-JOB-sequence-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { auditApi } from './AC-AUD-support.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { runEmploymentActivations } from '@italent/api';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld, resultRows } from './AC-ORG-people-support.js';
import { allowAll } from './support/tenant-api.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';

const testDb = useTestDb();
describe('AC-JOB-08～11 F-021 序列同步', () => {
  it.each(['posts', 'positions'] as const)(
    'AC-JOB-08 %s 编辑按引用异步追加当前/未来版本，历史与原始记录不变',
    async (kind) => {
      const { db } = testDb();
      const s = await scenario(db, kind);
      const before = await versions(db, s.world.tenant.id, s.employee.id);
      const key = randomUUID();
      const body = { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true };
      const response = await s.call('PATCH', `${kind}/${s.target.id}`, body, 1, key);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
      await worker(db, s.world.tenant.id);
      const records = await s.world.employmentRecords(s.employee.id, '2026-10-05');
      expect(records.map((r) => r.fields.sequenceId)).toEqual([s.oldSequence.id, s.nextSequence.id, s.nextSequence.id]);
      expect(records.map((r) => r.effectiveDate)).toEqual(['2026-10-01', '2026-10-03', '2026-10-12']);
      const after = await versions(db, s.world.tenant.id, s.employee.id);
      for (const row of after)
        expect(row.count).toBe(
          before.find((b) => b.businessId === row.businessId)!.count + (row.businessId === s.employee.recordId ? 0 : 1),
        );
      await worker(db, s.world.tenant.id);
      expect((await s.call('PATCH', `${kind}/${s.target.id}`, body, 1, key)).status).toBe(200);
      expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(after);
      await withTenant(db, s.world.tenant.id, async (tx) => {
        const originals = resultRows<{ sequence: string }>(
          await tx.execute(sql`
        SELECT sequence_id AS sequence FROM employment_records WHERE employee_id=${s.employee.id}::uuid`),
        );
        expect(originals.every((r) => r.sequence === s.oldSequence.id)).toBe(true);
        const audit = resultRows(
          await tx.execute(sql`SELECT id FROM audit_events
        WHERE action='employment.sequence-sync' AND command_id=${key}`),
        );
        expect(audit).toHaveLength(2);
        const events = resultRows(
          await tx.execute(sql`SELECT id FROM employment_outbox
        WHERE event_type='job.sequence-sync.completed' AND payload->'after'->>'recipientUserId'=${s.world.user.id}`),
        );
        expect(events).toHaveLength(1);
      });
    },
  );

  it('AC-JOB-09 清空不排队，新建不同步，非空编辑不能以 false 绕过锁定', async () => {
    const { db } = testDb();
    const s = await scenario(db);
    const before = await versions(db, s.world.tenant.id, s.employee.id);
    const cleared = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: null,
        effectiveDate: '2026-10-05',
      },
      1,
    );
    expect(cleared.status).toBe(200);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
    const changed = await s.call(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: s.nextSequence.id,
        syncSequenceToAssignments: false,
        effectiveDate: '2026-10-05',
      },
      2,
    );
    expect(changed.status).toBe(200);
    await worker(db, s.world.tenant.id);
    expect((await s.world.record(s.current.id)).fields.sequenceId).toBe(s.nextSequence.id);
  });

  it('AC-JOB-10 列表同口径、重试幂等、整单失败无部分追加', async () => {
    const { db } = testDb();
    const s = await scenario(db);
    const before = await versions(db, s.world.tenant.id, s.employee.id);
    const response = await s.call('POST', 'posts/sync-sequence', { items: [{ id: s.target.id, revision: 1 }] });
    expect(response.status, await response.clone().text()).toBe(202);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before); // 相同值不追加
    expect(
      (
        await s.call(
          'PATCH',
          `posts/${s.target.id}`,
          {
            sequenceId: s.nextSequence.id,
            effectiveDate: '2026-10-05',
          },
          1,
        )
      ).status,
    ).toBe(200);
    await worker(db, s.world.tenant.id, () => false);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
    await withTenant(db, s.world.tenant.id, async (tx) => {
      expect(
        resultRows(
          await tx.execute(sql`SELECT id FROM employment_outbox_attempts
        WHERE state='failed' AND error_reason IS NOT NULL`),
        ).length,
      ).toBeGreaterThan(0);
    });
    await worker(db, s.world.tenant.id);
    const after = await versions(db, s.world.tenant.id, s.employee.id);
    expect(after.reduce((n, r) => n + r.count, 0)).toBe(before.reduce((n, r) => n + r.count, 0) + 2);
    await worker(db, s.world.tenant.id);
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(after);
  });

  it('AC-JOB-11 范围为空整单拒绝，跨租户对象拒绝，批量上限与 revision', async () => {
    const { db } = testDb();
    const s = await scenario(db);
    const restricted = callAt(
      db,
      s.world,
      (r) => r.action !== 'data.scope.all' || r.resource !== 'TenantBase.EmploymentRecord',
    );
    const response = await restricted(
      'PATCH',
      `posts/${s.target.id}`,
      {
        sequenceId: s.nextSequence.id,
        effectiveDate: '2026-10-05',
      },
      1,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
    const other = await orgPeopleWorld(db, 'seqother');
    expect(
      (
        await callAt(db, other)('POST', 'posts/sync-sequence', {
          items: [{ id: s.target.id, revision: 1 }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await s.call('POST', 'posts/sync-sequence', {
          items: [{ id: s.target.id, revision: 99 }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await s.call('POST', 'posts/sync-sequence', {
          items: Array.from({ length: 101 }, () => ({ id: randomUUID(), revision: 1 })),
        })
      ).status,
    ).toBe(400);
  });
});

it('AC-JOB-10 第二条写入失败回滚第一条，修复后并发消费者只追加一次', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const before = await versions(db, s.world.tenant.id, s.employee.id);
  expect(
    (
      await s.call(
        'PATCH',
        `posts/${s.target.id}`,
        {
          sequenceId: s.nextSequence.id,
          effectiveDate: '2026-10-05',
        },
        1,
      )
    ).status,
  ).toBe(200);
  await db.execute(
    sql.raw(`CREATE FUNCTION f021_fail_second() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.business_id = '${s.future.id}'::uuid AND NEW.sequence_id = '${s.nextSequence.id}'::uuid
      THEN RAISE EXCEPTION 'synthetic storage failure'; END IF; RETURN NEW; END $$`),
  );
  await db.execute(sql`CREATE TRIGGER f021_fail_second BEFORE INSERT ON employment_payload_versions
    FOR EACH ROW EXECUTE FUNCTION f021_fail_second()`);
  try {
    expect(await worker(db, s.world.tenant.id)).toMatchObject({ failed: 1 });
    expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(before);
    await withTenant(db, s.world.tenant.id, async (tx) => {
      expect(
        resultRows(await tx.execute(sql`SELECT id FROM audit_events WHERE action='employment.sequence-sync'`)),
      ).toEqual([]);
    });
  } finally {
    await db.execute(sql`DROP TRIGGER f021_fail_second ON employment_payload_versions`);
    await db.execute(sql`DROP FUNCTION f021_fail_second()`);
  }
  await Promise.all([worker(db, s.world.tenant.id), worker(db, s.world.tenant.id)]);
  const after = await versions(db, s.world.tenant.id, s.employee.id);
  expect(after.reduce((n, r) => n + r.count, 0)).toBe(before.reduce((n, r) => n + r.count, 0) + 2);
});

it.each(['posts', 'positions'] as const)('AC-JOB-10 %s 列表按引用覆盖不同旧值，其他引用不变', async (kind) => {
  const { db } = testDb();
  const s = await scenario(db, kind);
  const otherPost = await s.world.job('posts', '其他职务', { sequenceId: s.oldSequence.id });
  const otherPosition = await s.world.job('positions', '其他职位', { orgId: s.org.id, postId: otherPost.id });
  const other = await s.world.hire('对照员工', {
    departmentId: s.org.id,
    postId: otherPost.id,
    positionId: otherPosition.id,
    sequenceId: s.nextSequence.id,
  });
  const mismatch = await s.world.request('PATCH', `/records/${s.future.id}`, {
    ifMatch: s.future.revision,
    body: { fields: { sequenceId: s.nextSequence.id } },
  });
  expect(mismatch.status, await mismatch.clone().text()).toBe(200);
  expect((await s.call('POST', `${kind}/sync-sequence`, { items: [{ id: s.target.id, revision: 1 }] })).status).toBe(
    202,
  );
  await worker(db, s.world.tenant.id);
  expect((await s.world.record(s.future.id)).fields.sequenceId).toBe(s.oldSequence.id);
  expect((await s.world.record(other.recordId)).fields.sequenceId).toBe(s.nextSequence.id);
  const messages = await s.call('GET', 'sequence-sync/messages');
  expect(((await messages.json()) as { items: unknown[] }).items).toHaveLength(1);
  const foreign = await orgPeopleWorld(db, 'seqnoticeforeign');
  const hidden = await callAt(db, foreign)('GET', 'sequence-sync/messages');
  expect(((await hidden.json()) as { items: unknown[] }).items).toEqual([]);
});

it('AC-JOB-08 审批中追加版本、作废不改；已批未来、同日多条及迟到调动保持排序和序列', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  await installApprovalFallbacks(db, s.world.tenant.id, s.world.user.id);
  async function action(id: string, action: 'submit' | 'approve' | 'revoke') {
    const response = await s.world.request('GET', `/businesses/${id}`);
    const record = (await response.json()) as { revision: number };
    const result = await runEmploymentTransition(
      db,
      {
        tenantId: s.world.tenant.id,
        userId: s.world.user.id,
        timezone: s.world.tenant.timezone,
        now,
        commandId: randomUUID(),
        expectedRevision: record.revision,
      },
      { id, action },
    );
    expect(result.status).toBe(200);
  }
  async function application(date: string, state: 'approved' | 'in_review' | 'voided', place: string) {
    const employee = await s.world.getEmployee(s.employee.id);
    const draft = await s.world.business(
      s.employee.id,
      {
        kind: 'transfer',
        mode: 'application',
        effectiveDate: date,
        fields: { postId: s.target.id, sequenceId: s.oldSequence.id, place },
      },
      employee.revision,
    );
    if (state === 'in_review') {
      const response = await s.world.request('POST', `/businesses/${draft.id}/submit`, {
        ifMatch: draft.revision,
        body: {},
      });
      expect(response.status, await response.clone().text()).toBe(200);
    } else await action(draft.id, 'submit');
    if (state === 'approved') await action(draft.id, 'approve');
    if (state === 'voided') await action(draft.id, 'revoke');
    return draft;
  }
  const first = await application('2026-10-06', 'approved', '前序地点');
  const second = await application('2026-10-07', 'approved', '后序地点');
  const sameDay = await application('2026-10-07', 'approved', '同日末条地点');
  const review = await application('2026-10-15', 'in_review', '审批中');
  const voided = await application('2026-10-16', 'voided', '已作废');
  const instanceSnapshot = () =>
    withTenant(db, s.world.tenant.id, async (tx) =>
      resultRows(
        await tx.execute(sql`
    SELECT to_jsonb(i) AS instance FROM approval_instances i WHERE business_id=${review.id}::uuid`),
      ),
    );
  const originalInstance = await instanceSnapshot();
  expect(originalInstance).toHaveLength(1);
  const before = await versions(db, s.world.tenant.id, s.employee.id);
  expect(
    (await s.call('PATCH', `posts/${s.target.id}`, { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' }, 1))
      .status,
  ).toBe(200);
  await worker(db, s.world.tenant.id);
  const after = await versions(db, s.world.tenant.id, s.employee.id);
  expect(after.find((r) => r.businessId === voided.id)).toEqual(before.find((r) => r.businessId === voided.id));
  expect(after.find((r) => r.businessId === review.id)?.count).toBe(
    before.find((r) => r.businessId === review.id)!.count + 1,
  );
  expect(await (await s.world.request('GET', `/businesses/${review.id}`)).json()).toMatchObject({
    status: 'in_review',
    fields: { sequenceId: s.nextSequence.id },
  });
  expect(await instanceSnapshot()).toEqual(originalInstance);
  const run = await runEmploymentActivations(
    db,
    { actorUserId: null, commandId: randomUUID() },
    { tenantId: s.world.tenant.id },
    { clock: () => new Date('2026-10-09T01:00:00Z') },
  );
  expect(run.runs[0]).toMatchObject({ failed: [], errors: [] });
  const records = await s.world.records(s.employee.id, '2026-10-09');
  expect(records.map((r) => r.id)).toEqual([
    s.employee.recordId,
    s.current.id,
    first.id,
    second.id,
    sameDay.id,
    s.future.id,
  ]);
  for (const id of [first.id, second.id, sameDay.id]) {
    expect(records.find((r) => r.id === id)).toMatchObject({
      effectiveDate: '2026-10-09',
      fields: { sequenceId: s.nextSequence.id },
    });
  }
  expect(records.find((r) => r.id === sameDay.id)?.fields.place).toBe('同日末条地点');
  await action(review.id, 'approve');
  await runEmploymentActivations(
    db,
    { actorUserId: null, commandId: randomUUID() },
    { tenantId: s.world.tenant.id },
    { clock: () => new Date('2026-10-15T01:00:00Z') },
  );
  expect((await s.world.record(review.id)).fields.sequenceId).toBe(s.nextSequence.id);
});

it('AC-JOB-11 当前部门可见时范围外未来可写，任一不可见则职务和队列整体回滚', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const outside = await s.world.org('范围外部门');
  expect(
    (
      await s.world.request('PATCH', `/records/${s.future.id}`, {
        ifMatch: s.future.revision,
        body: { fields: { departmentId: outside.id, positionId: null } },
      })
    ).status,
  ).toBe(200);
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    authorize: async () => true,
    fields: async () =>
      new Set(Object.values(MODULE_OBJECTS).flatMap((object) => object.fields.map((field) => field.code))),
    scope: async (query) =>
      query.objectCode === MODULE_OBJECTS.employmentRecord.code
        ? {
            all: false,
            hasDataPermission: true,
            orgIds: [s.org.id],
            personIds: [],
            terms: [
              {
                dimension: 'organization',
                orgIds: [s.org.id],
                personIds: [],
                personQuery: { kind: 'organization', tenantId: s.world.tenant.id, asOf: query.asOf },
              },
            ],
          }
        : { all: true, hasDataPermission: true, orgIds: [], personIds: [] },
  });
  const scoped = callAt(db, s.world, authorize);
  expect(
    (
      await scoped(
        'PATCH',
        `posts/${s.target.id}`,
        {
          sequenceId: s.nextSequence.id,
          effectiveDate: '2026-10-05',
        },
        1,
      )
    ).status,
  ).toBe(200);
  expect(await worker(db, s.world.tenant.id, authorize)).toMatchObject({ failed: 0 });
  expect((await s.world.record(s.future.id)).fields.sequenceId).toBe(s.nextSequence.id);
  const hidden = await s.world.hire('范围外员工', {
    departmentId: outside.id,
    postId: s.target.id,
    sequenceId: s.nextSequence.id,
  });
  const snapshot = await versions(db, s.world.tenant.id, s.employee.id);
  const response = await scoped(
    'PATCH',
    `posts/${s.target.id}`,
    {
      sequenceId: s.oldSequence.id,
      effectiveDate: '2026-10-05',
    },
    2,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'LINKED_RECORD_OUT_OF_SCOPE' } });
  expect(await versions(db, s.world.tenant.id, s.employee.id)).toEqual(snapshot);
  expect((await s.world.record(hidden.recordId)).fields.sequenceId).toBe(s.nextSequence.id);
  const job = await s.call('GET', `posts/${s.target.id}?asOf=2026-10-05`);
  expect(await job.json()).toMatchObject({ revision: 2, sequenceId: s.nextSequence.id });
  await withTenant(db, s.world.tenant.id, async (tx) => {
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM employment_outbox
      WHERE event_type='job.sequence-sync.requested'`),
      ),
    ).toHaveLength(1);
  });
});

it('AC-JOB-10 连续 A→B→A 入队仍按引用处理，末单不能被入队时的相同值过滤掉', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const before = await versions(db, s.world.tenant.id, s.employee.id);
  expect(
    (
      await s.call(
        'PATCH',
        `posts/${s.target.id}`,
        {
          sequenceId: s.nextSequence.id,
          effectiveDate: '2026-10-05',
        },
        1,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await s.call(
        'PATCH',
        `posts/${s.target.id}`,
        {
          sequenceId: s.oldSequence.id,
          effectiveDate: '2026-10-05',
        },
        2,
      )
    ).status,
  ).toBe(200);
  const firstPage = await worker(db, s.world.tenant.id, allowAll, { limit: 1 });
  expect(firstPage).toMatchObject({ completed: 1, failed: 0, nextCursor: expect.any(String) });
  expect(await worker(db, s.world.tenant.id, allowAll, { cursor: firstPage.nextCursor })).toMatchObject({
    completed: 1,
    failed: 0,
    nextCursor: null,
  });
  const records = await s.world.records(s.employee.id);
  expect(records.every((r) => r.fields.sequenceId === s.oldSequence.id)).toBe(true);
  const after = await versions(db, s.world.tenant.id, s.employee.id);
  expect(after.reduce((n, r) => n + r.count, 0)).toBe(before.reduce((n, r) => n + r.count, 0) + 4);
});

it('AC-JOB-08 共用编辑服务的导入映射更新透传任职授权，不回退为缺失授权 403', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const response = await s.call('POST', 'import', {
    kind: 'posts',
    rows: [
      {
        sourceCode: 'F021_IMPORT',
        objectId: s.target.id,
        expectedRevision: 1,
        code: s.target.code,
        name: s.target.name,
        startDate: '2026-10-05',
        sequenceId: s.nextSequence.id,
      },
    ],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ results: [{ status: 'updated' }] });
  expect(await worker(db, s.world.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
  expect((await s.world.record(s.current.id)).fields.sequenceId).toBe(s.nextSequence.id);
});

it('AC-JOB-09 序列 UUID 大小写等价，不把同一引用误判为换序列', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const response = await s.call(
    'PATCH',
    `posts/${s.target.id}`,
    {
      sequenceId: s.oldSequence.id.toUpperCase(),
      effectiveDate: '2026-10-05',
    },
    1,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sequenceId: s.oldSequence.id, syncSequenceToAssignments: false });
  await withTenant(db, s.world.tenant.id, async (tx) => {
    expect(
      resultRows(
        await tx.execute(sql`SELECT id FROM employment_outbox
      WHERE event_type='job.sequence-sync.requested'`),
      ),
    ).toEqual([]);
  });
});

it('AC-JOB-08 大写来源 objectId 的导入同步当前与未来，不得静默漏目标', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const before = await versions(db, s.world.tenant.id, s.employee.id);
  const response = await s.call('POST', 'import', {
    kind: 'posts',
    rows: [
      {
        sourceCode: 'UPPER_SOURCE',
        objectId: s.target.id.toUpperCase(),
        expectedRevision: 1,
        code: 'UPPER_UPDATED',
        name: s.target.name,
        startDate: '2026-10-05',
        sequenceId: s.nextSequence.id,
      },
    ],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ results: [{ status: 'updated' }] });
  expect(await worker(db, s.world.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
  const after = await versions(db, s.world.tenant.id, s.employee.id);
  for (const id of [s.current.id, s.future.id]) {
    expect((await s.world.record(id)).fields.sequenceId).toBe(s.nextSequence.id);
    expect(after.find((r) => r.businessId === id)?.count).toBe(before.find((r) => r.businessId === id)!.count + 1);
  }
});

it('AC-JOB-10 DEC-219 执行时已成历史的目标保留旧值，结果和通知列出跳过原因', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  expect(
    (await s.call('PATCH', `posts/${s.target.id}`, { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' }, 1))
      .status,
  ).toBe(200);
  await worker(db, s.world.tenant.id, allowAll, { clock: () => new Date('2026-10-13T01:00:00Z') });
  expect((await s.world.record(s.current.id)).fields.sequenceId).toBe(s.oldSequence.id);
  expect((await s.world.record(s.future.id)).fields.sequenceId).toBe(s.nextSequence.id);
  const response = await s.call('GET', 'sequence-sync/messages');
  const completion = (await response.json()) as { items: { message: { taskId: string } }[] };
  expect(completion).toMatchObject({
    items: [{ message: { count: 1, skipped: [{ recordId: s.current.id, reason: 'BECAME_HISTORICAL' }] } }],
  });
  const task = await s.call('GET', `sequence-sync/tasks/${completion.items[0]!.message.taskId}`);
  expect(await task.json()).toMatchObject({
    state: 'sent',
    result: { count: 1, skipped: [{ recordId: s.current.id, reason: 'BECAME_HISTORICAL' }] },
  });
});

it('AC-JOB-10 DEC-216 逐条审计字段差异、任务日志与失败审计可查，重试不重复', async () => {
  const { db } = testDb();
  const s = await scenario(db);
  const commandId = randomUUID();
  expect(
    (
      await s.call(
        'PATCH',
        `posts/${s.target.id}`,
        { sequenceId: s.nextSequence.id, effectiveDate: '2026-10-05' },
        1,
        commandId,
      )
    ).status,
  ).toBe(200);
  expect(await worker(db, s.world.tenant.id, () => false)).toMatchObject({ failed: 1 });
  const audit = auditApi(db, now.toISOString());
  const as = { tenant: s.world.tenant.id, user: s.world.user.id };
  expect((await audit.commandFailures(as, { commandId })).items).toEqual([
    expect.objectContaining({ outcome: 'business_failed', commandId }),
  ]);
  expect((await audit.dataChanges(as, { commandId, objectType: 'employment-record' })).items).toEqual([]);
  await worker(db, s.world.tenant.id);
  await worker(db, s.world.tenant.id);
  const rows = (await audit.dataChanges(as, { commandId, objectType: 'employment-record', field: 'sequenceId' })).items;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    sourceAction: '定时任务',
    changes: [expect.objectContaining({ field: 'sequenceId', from: s.oldSequence.id, to: s.nextSequence.id })],
  });
  const tasks = (await audit.operationLogs(as, { commandId, objectType: 'job-sequence-sync' })).items;
  expect(tasks).toEqual([expect.objectContaining({ successCount: 2, failureCount: 0, commandId })]);
});
