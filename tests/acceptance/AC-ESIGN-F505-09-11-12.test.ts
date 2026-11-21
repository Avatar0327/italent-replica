import { sql, users, eq, grantMembership, withPlatform, withTenant, type Tx } from '@italent/db';
import * as domain from '@italent/domain';
import { testDbMode, useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';
import { runSourceSignCommand } from '../../apps/api/src/modules/esign/source-initiation.js';
import { sourceTemplateOptions } from '../../apps/api/src/modules/esign/source-templates.js';
import { runESignJobs } from '../../apps/api/src/modules/esign/scheduler.js';
import * as employmentAudit from '../../apps/api/src/modules/employment/context.js';
import * as mine from '../../apps/api/src/modules/esign/mine.js';
import { uniqueSuffix } from './support/unique.js';
import { allowAll, cmd, seedTenantWithMember } from './support/tenant-api.js';
import { rowsOf } from './AC-ESIGN-F505-support.js';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { DAY, START, SCENES, sharedWorld, type Scene, type Task } from './AC-ESIGN-F505-s2-support.js';

const db = useTestDb();
type World = Awaited<ReturnType<typeof sharedWorld>>;
type Source = { scene: Scene; sourceId: string; sourceRevision: number };

async function resolved(w: World, scene: Scene): Promise<Source> {
  const source = await w.source(scene);
  return { scene, sourceId: (source.offerId ?? source.businessId)!, sourceRevision: source.sourceRevision };
}

type InitiationOptions = {
  commandId?: string;
  authorize?: typeof allowAll;
  clock?: () => Date;
  afterSourceLock?: () => void;
};

function runInitiation(w: World, source: Source, templateIds: string[], options: InitiationOptions = {}) {
  const ctx = { ...w.ctx(), expectedRevision: source.sourceRevision, tenantName: w.session.tenant.name };
  return runSourceSignCommand(
    w.db,
    { authorize: options.authorize ?? allowAll, clock: options.clock ?? (() => ctx.now) },
    ctx,
    {
      scene: source.scene,
      sourceId: source.sourceId,
      commandId: options.commandId ?? uniqueSuffix(),
      templateIds,
      authorizeSource: async () => {},
      lockSource: async (tx) => {
        const table = sql.identifier(source.scene === 'offer' ? 'offers' : 'employment_business_objects');
        const [row] = rowsOf<{ revision: number }>(
          await tx.execute(sql`
        SELECT revision FROM ${table} WHERE tenant_id=${w.tenantId} AND id=${source.sourceId}::uuid FOR UPDATE
      `),
        );
        options.afterSourceLock?.();
        return { revision: row!.revision, employeeId: w.employeeId, ownerDepartmentId: w.from.id };
      },
    },
  );
}

async function initiate(w: World, source: Source, templateIds: string[], options?: InitiationOptions) {
  const result = await runInitiation(w, source, templateIds, options);
  expect(result.status).toBe(201);
  return result.body as { sourceId: string; taskId: string };
}

const query = (w: World, name: string) =>
  withTenant(w.db, w.tenantId, async (tx) =>
    rowsOf(await tx.execute(sql`SELECT * FROM ${sql.identifier(name)} WHERE tenant_id=${w.tenantId}`)),
  );
const detail = (w: World, id: string) => w.call('GET', `/mine/${id}`).then((r) => json<Task & { files: unknown[] }>(r));

it('AC-09 缺绑定、停用账号与仅外租户有效的账号均生成可见失败，文件和通知为空', async () => {
  const w = await sharedWorld(db().db, 'no-account');
  const offer = await resolved(w, 'offer');
  const entry = await resolved(w, 'entry');
  const template = await w.template();
  await withPlatform(w.db, (tx) => tx.update(users).set({ status: 'disabled' }).where(eq(users.id, w.employeeUser)));
  const disabled = await initiate(w, offer, [template.id]);
  await withPlatform(w.db, (tx) => tx.update(users).set({ status: 'active' }).where(eq(users.id, w.employeeUser)));
  const foreign = await seedTenantWithMember(w.db, 'ZZ_F505_FOREIGN');
  await grantMembership(
    w.db,
    {
      tenantId: foreign.tenant.id,
      userId: w.employeeUser,
      expectedRevision: 0,
    },
    cmd(),
  );
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`
    UPDATE tenant_memberships SET status='revoked' WHERE tenant_id=${w.tenantId} AND user_id=${w.employeeUser}
  `),
  );
  const otherTenant = await initiate(w, entry, [template.id]);
  await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`
    DELETE FROM permission_user_person_links WHERE tenant_id=${w.tenantId} AND employee_id=${w.employeeId}
  `),
  );
  const unbound = await initiate(w, offer, [template.id]);
  for (const { taskId } of [disabled, otherTenant, unbound]) {
    expect(await detail(w, taskId)).toMatchObject({
      status: 'failed',
      currentNode: null,
      failureReason: 'EMPLOYEE_NO_ACCOUNT',
      files: [],
    });
  }
  expect(await query(w, 'esign_task_files')).toEqual([]);
  await runESignJobs(w.db, { clock: () => new Date(START.getTime() + 40 * DAY) });
  expect((await w.taskRow(disabled.taskId)).status).toBe('failed');
  expect(await w.taskCount()).toBe(3);
  expect(await w.notices()).toEqual([]);
});

it('AC-09 纯渲染异常落失败，真实库错误回滚任务、文件、业务审计、outbox 及台账', async () => {
  const w = await sharedWorld(db().db, 'failures');
  const source = await resolved(w, 'entry');
  const template = await w.template();
  const render = vi.spyOn(domain, 'renderTemplateBody').mockImplementationOnce(() => {
    throw new Error('ZZ_F505_RENDER');
  });
  try {
    const { taskId } = await initiate(w, source, [template.id]);
    expect(await detail(w, taskId)).toMatchObject({ status: 'failed', failureReason: 'RENDER_FAILED', files: [] });
  } finally {
    render.mockRestore();
  }
  const beforeOutbox = await query(w, 'employment_outbox');
  const original = employmentAudit.auditEmployment;
  const inject = vi.spyOn(employmentAudit, 'auditEmployment').mockImplementationOnce(async (...args) => {
    await original(...args);
    await args[0].execute(sql`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '53100'; END $$`);
  });
  const commandId = uniqueSuffix();
  try {
    await expect(initiate(w, source, [template.id], { commandId })).rejects.toMatchObject({
      status: 503,
      details: { reason: 'STORAGE_UNWRITABLE' },
    });
  } finally {
    inject.mockRestore();
  }
  expect(await w.taskCount()).toBe(1);
  expect(await query(w, 'esign_task_files')).toEqual([]);
  expect(await query(w, 'employment_outbox')).toEqual(beforeOutbox);
  expect(
    await withTenant(w.db, w.tenantId, async (tx) => ({
      ledger: rowsOf(await tx.execute(sql`SELECT command_id FROM command_ledger WHERE command_id=${commandId}`)),
      audit: rowsOf(await tx.execute(sql`SELECT action FROM audit_events WHERE command_id=${commandId}`)),
    })),
  ).toEqual({ ledger: [], audit: [] });
  expect(await w.notices()).toEqual([]);
});

it.each(SCENES)('AC-12 %s 同键并发同 taskId、异请求冲突，重放使用已保存人员字段', async (scene) => {
  const w = await sharedWorld(db().db, `same-key-${scene}`);
  const source = await resolved(w, scene);
  const plain = await w.template('ZZ_F505_常量', 'ZZ_F505_A');
  const named = await w.template('{员工姓名}|{工号}|{发起日期}|{企业名称}', 'ZZ_F505_B');
  const incompatible = await w.template('{调入部门}', 'ZZ_F505_C');
  const values = [plain, named].map(({ id, name }) => ({ id, name }));
  expect(await withTenant(w.db, w.tenantId, (tx) => sourceTemplateOptions(tx, w.tenantId))).toEqual({ items: values });
  await expect(initiate(w, source, [incompatible.id])).rejects.toMatchObject({
    status: 400,
    details: { reason: 'ESIGN_TEMPLATE_INCOMPATIBLE' },
  });
  const noEmployee: typeof allowAll = (q) => q.resource !== 'TenantBase.Employee';
  await expect(initiate(w, source, [named.id], { authorize: noEmployee })).rejects.toMatchObject({
    status: 403,
    code: 'FIELD_FORBIDDEN',
  });
  const commandId = uniqueSuffix();
  const [a, b] = await Promise.all([
    initiate(w, source, [named.id, plain.id], { commandId }),
    initiate(w, source, [plain.id, named.id], { commandId }),
  ]);
  expect(a).toEqual(b);
  expect(await w.taskCount()).toBe(1);
  expect(await w.notices()).toEqual([]);
  const task = await w.taskRow(a.taskId);
  expect(task).toMatchObject({ scene, variableReadFields: ['name', 'code'], status: 'signing' });
  expect((await detail(w, task.id)).files).toEqual([
    expect.objectContaining({ templateId: plain.id, seq: 1, content: plain.body }),
    expect.objectContaining({ templateId: named.id, seq: 2, content: expect.stringContaining('ZZ_F505_EMP_same-key') }),
  ]);
  await expect(initiate(w, source, [plain.id], { commandId })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(initiate(w, source, [plain.id])).rejects.toMatchObject({
    details: { reason: 'ESIGN_TASK_IN_PROGRESS' },
  });
  const ready = await json<Task>(await w.sign(w.employeeUser, task));
  await json(await w.sign(w.userId, ready));
  const edited = await w.call('PATCH', `/templates/${named.id}`, { ifMatch: 1, body: { status: 'disabled' } });
  expect(edited.status).toBe(200);
  await expect(initiate(w, source, [plain.id, named.id], { commandId })).resolves.toEqual(a);
  await expect(initiate(w, source, [plain.id, named.id], { commandId, authorize: noEmployee })).rejects.toMatchObject({
    code: 'FIELD_FORBIDDEN',
  });
  await expect(initiate(w, source, [plain.id], { authorize: noEmployee })).resolves.toMatchObject({
    sourceId: a.sourceId,
  });
});

it.each(SCENES)('AC-11 %s 期限精确、企业免自动提醒、锁后到期提交 409、显式发新任务', async (scene) => {
  const w = await sharedWorld(db().db, `expiry-${scene}`);
  const source = await resolved(w, scene);
  const template = await w.template();
  await json(
    await w.call('PUT', `/scenes/${scene}`, {
      ifMatch: 0,
      body: { validityDays: 3, remindBeforeExpiry: true },
    }),
  );
  const { taskId } = await initiate(w, source, [template.id]);
  const task = await w.taskRow(taskId);
  const deadline = new Date(START.getTime() + 3 * DAY);
  expect(task.expiresAt).toEqual(deadline);
  expect(task.remindBeforeExpiry).toBe(true);
  const ready = await json<Task>(await w.sign(w.employeeUser, task));
  const before = new Date(deadline.getTime() - 1);
  await runESignJobs(w.db, { clock: () => before });
  expect(await w.taskRow(taskId)).toMatchObject({
    status: 'signing',
    currentNode: 'enterprise',
    expiryRemindedAt: null,
  });
  expect(await w.notices()).toEqual([]);
  w.setNow(before);
  const key = uniqueSuffix();
  if (testDbMode() === 'pg') {
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const unlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locking = withTenant(w.db, w.tenantId, async (tx) => {
      await tx.execute(sql`SELECT id FROM esign_tasks WHERE tenant_id=${w.tenantId} AND id=${taskId} FOR UPDATE`);
      signalLocked();
      await unlocked;
    });
    await locked;
    const response = w.sign(w.userId, ready, key);
    try {
      await vi.waitFor(
        async () => {
          const waiting = await w.db.execute(sql`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE 'select%esign_tasks%for update%'`);
          expect(rowsOf(waiting)).toHaveLength(1);
        },
        { timeout: 5000 },
      );
      w.setNow(deadline);
    } finally {
      release();
      await locking;
    }
    await reason(await response, 'ESIGN_TASK_EXPIRED');
  } else {
    const original = mine.ownSignTask;
    const advance = vi.spyOn(mine, 'ownSignTask').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      w.setNow(deadline);
      return result;
    });
    try {
      await reason(await w.sign(w.userId, ready, key), 'ESIGN_TASK_EXPIRED');
    } finally {
      advance.mockRestore();
    }
  }
  await reason(await w.sign(w.userId, ready, key), 'ESIGN_TASK_EXPIRED');
  expect(await w.taskRow(taskId)).toMatchObject({ status: 'expired', currentNode: null, revision: 3 });
  expect(await w.notices()).toEqual([]);
  w.setNow(deadline);
  const next = await initiate(w, source, [template.id]);
  expect(next.taskId).not.toBe(taskId);
  expect(await w.taskRow(next.taskId)).toMatchObject({ status: 'signing', revision: 1 });
});

async function crossDeadlineWhileBlocked<T>(
  w: World,
  lockRow: (tx: Tx) => Promise<unknown>,
  table: string,
  run: () => Promise<T>,
  crossDeadline: () => void,
) {
  let signalLocked!: (pid: number) => void;
  let release!: () => void;
  const locked = new Promise<number>((resolve) => {
    signalLocked = resolve;
  });
  const unlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holding = withTenant(w.db, w.tenantId, async (tx) => {
    await lockRow(tx);
    const [row] = rowsOf<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`));
    signalLocked(row!.pid);
    await unlocked;
  });
  const blocker = await Promise.race([
    locked,
    holding.then(() => {
      throw new Error('持锁事务提前退出');
    }),
  ]);
  const pending = Promise.resolve().then(run);
  try {
    await vi.waitFor(
      async () => {
        const waiting = await w.db.execute(sql`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND ${blocker}::int=ANY(pg_blocking_pids(pid))
          AND query ILIKE ${`%FROM%${table}%FOR UPDATE%`}`);
        expect(rowsOf(waiting)).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    crossDeadline();
  } finally {
    release();
    await Promise.allSettled([holding, pending]);
  }
  await holding;
  return pending;
}

it.each(SCENES)('AC-11 %s 等锁跨截止时间，结束旧任务并成功发起新任务', async (scene) => {
  const w = await sharedWorld(db().db, `reissue-after-lock-${scene}`);
  const source = await resolved(w, scene);
  const template = await w.template();
  const original = await initiate(w, source, [template.id]);
  const old = await w.taskRow(original.taskId);
  const deadline = old.expiresAt;
  let now = new Date(deadline.getTime() - 1);
  w.setNow(now);
  const advance = () => {
    now = deadline;
  };
  const run = (options?: InitiationOptions) =>
    runInitiation(w, source, [template.id], { clock: () => now, ...options });

  // 真 PG 分别证实来源锁和在途任务锁的等待。PGlite 单连接，在来源锁返回时推进注入时钟。
  const waitTable = scene === 'offer' ? 'offers' : 'esign_tasks';
  const waitId = scene === 'offer' ? source.sourceId : old.id;
  const attempt =
    testDbMode() === 'pg'
      ? crossDeadlineWhileBlocked(
          w,
          (tx) =>
            tx.execute(sql`
        SELECT id FROM ${sql.identifier(waitTable)} WHERE tenant_id=${w.tenantId} AND id=${waitId} FOR UPDATE
      `),
          waitTable,
          run,
          advance,
        )
      : run({ afterSourceLock: advance });
  const outcome = await attempt.catch((error: unknown) => error);
  expect.soft(await w.taskRow(old.id), '旧任务在同一发起事务到期').toMatchObject({
    status: 'expired',
    currentNode: null,
    expiredAt: deadline,
    revision: 2,
  });
  expect(outcome, '新任务发起应返回 201').toMatchObject({ status: 201, body: { sourceId: source.sourceId } });
  const { taskId } = (outcome as { body: { taskId: string } }).body;
  expect(taskId).not.toBe(old.id);
  expect(await w.taskRow(taskId)).toMatchObject({
    scene,
    status: 'signing',
    revision: 1,
    initiatedAt: deadline,
    expiresAt: new Date(deadline.getTime() + 2 * DAY),
  });
  expect(await w.notices()).toEqual([]);
});

it('AC-11 定时提醒候选等锁跨截止时间，不再发送到期前提醒', async () => {
  const w = await sharedWorld(db().db, 'reminder-after-lock');
  const task = await w.fixture('entry', await w.template(), true);
  const before = new Date(task.expiresAt.getTime() - 1);
  let now = before;
  const advance = () => {
    now = task.expiresAt;
  };
  const run = (clock: () => Date) => runESignJobs(w.db, { clock });
  if (testDbMode() === 'pg') {
    await crossDeadlineWhileBlocked(
      w,
      (tx) =>
        tx.execute(sql`
      SELECT id FROM esign_tasks WHERE tenant_id=${w.tenantId} AND id=${task.id} FOR UPDATE
    `),
      'esign_tasks',
      () => run(() => now),
      advance,
    );
  } else {
    await run(vi.fn(() => task.expiresAt).mockReturnValueOnce(before));
  }
  expect.soft(await w.taskRow(task.id)).toMatchObject({ expiryRemindedAt: null, revision: 1 });
  expect(await w.notices()).toEqual([]);
  await run(() => task.expiresAt);
  expect(await w.taskRow(task.id)).toMatchObject({ status: 'expired', expiredAt: task.expiresAt, revision: 2 });
});
