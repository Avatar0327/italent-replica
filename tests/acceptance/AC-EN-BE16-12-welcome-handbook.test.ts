import { randomUUID } from 'node:crypto';
import {
  auditCommandFailures,
  auditEvents,
  commandLedger,
  eq,
  grantMembership,
  onboardingEntryCases,
  onboardingWelcomeJobs,
  onboardingWelcomeLetters,
  sql,
  withTenant,
  type Db,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { startEmploymentActivationScheduler } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { entryLifecyclePort } from '../../apps/api/src/modules/employment/onboarding-entry-port.js';
import { grantStandardProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { provisionTenant } from '../../apps/api/src/modules/platform/provisioning.js';
import { addPending, entryAction, entryWorld, portContext } from './AC-EN-BE2a-support.js';
import { newUser, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const testDb = useTestDb();
const now = new Date('2026-11-21T08:00:00Z');
const base = '/api/tenant/onboarding';
const WELCOME = `${base}/welcome-letters`;
const HANDBOOK = `${base}/handbooks`;

async function fixture() {
  const { db } = testDb();
  const ops = await seedOperator(db, `ZZ_BE16_WEL_OPS_${uniqueSuffix()}`);
  const admin = await newUser(db, `ZZ_BE16_WEL_ADMIN_${uniqueSuffix()}`);
  const hr = await newUser(db, `ZZ_BE16_WEL_HR_${uniqueSuffix()}`);
  const home = await provisionTenant(
    db,
    {
      code: `ZZ_BE16_${uniqueSuffix()}`,
      name: 'ZZ_BE16_WELCOME',
      firstAdminUserId: admin.id,
      exceptionAdminUserId: admin.id,
    },
    cmd(ops.id),
    now,
  );
  const tenantId = home.tenant.id;
  await grantMembership(db, { tenantId, userId: hr.id, expectedRevision: 0 }, cmd(ops.id));
  await withTenant(db, tenantId, (tx) =>
    grantStandardProfile(
      tx,
      { tenantId, actorUserId: ops.id, now, commandId: randomUUID() },
      { userId: hr.id, profile: home.profiles.find(({ code }) => code === 'standard_hr_specialist')! },
    ),
  );
  const api = tenantApi(db, { authorize: undefined, clock: () => now });
  const as =
    (user: string) =>
    (method: string, path: string, options: RequestOptions = {}) =>
      api.request(method, path, { user, tenant: tenantId, ...options });
  return { db, tenantId, admin: as(admin.id), hr: as(hr.id) };
}

const letter = (extra: Record<string, unknown> = {}) => ({
  name: `ZZ_BE16_欢迎信_${uniqueSuffix()}`,
  title: '欢迎加入{{companyName}}',
  body: '{{employeeName}}你好，请于{{hiredOn}}到{{departmentName}}报到。',
  ...extra,
});
const samples = {
  employeeName: 'ZZ_BE16_<b>张三</b>',
  companyName: 'ZZ_BE16_公司',
  departmentName: 'ZZ_BE16_部门',
  positionName: 'ZZ_BE16_岗位',
  hiredOn: '2026-12-01',
};
const handbook = (extra: Record<string, unknown> = {}) => ({
  name: `ZZ_BE16_手册_${uniqueSuffix()}`,
  title: '{{companyName}}入职手册',
  blocks: [
    { type: 'heading', text: '第一天' },
    { type: 'paragraph', text: '{{employeeName}}，欢迎。' },
    { type: 'list', items: ['带身份证件', '{{departmentName}}集合'] },
  ],
  ...extra,
});

async function counts(db: Db, tenantId: string) {
  return withTenant(db, tenantId, async (tx) => ({
    ledger: (await tx.select().from(commandLedger)).length,
    audit: (await tx.select().from(auditEvents)).length,
    failures: (await tx.select().from(auditCommandFailures)).length,
    letters: (await tx.select().from(onboardingWelcomeLetters)).length,
  }));
}

describe('AC-EN-BE16-12 欢迎信模板与预览', () => {
  it('创建后默认停用；预览用合成样例转义渲染，不写台账、审计或数据', async () => {
    const { db, tenantId, admin } = await fixture();
    const created = await admin('POST', WELCOME, { ifMatch: 0, body: letter() });
    expect(created.status, await created.clone().text()).toBe(201);
    const receipt = await created.json();
    expect(receipt).toEqual({ id: expect.any(String), revision: 1, status: 'disabled' });
    const detail = await (await admin('GET', `${WELCOME}/${receipt.id}`)).json();
    expect(new Set(detail.variables)).toEqual(new Set(['companyName', 'employeeName', 'hiredOn', 'departmentName']));
    expect(detail.availableActions).toEqual(['edit', 'preview', 'delete']);

    const before = await counts(db, tenantId);
    const preview = await admin('POST', `${WELCOME}/${receipt.id}/preview`, { body: { samples } });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const rendered = await preview.json();
    expect(rendered.title).toBe('欢迎加入ZZ_BE16_公司');
    expect(rendered.bodyHtml).toMatch(/&(?:lt|#60);b&(?:gt|#62);张三/);
    expect(rendered.bodyHtml).not.toContain('<b>');
    expect(await counts(db, tenantId)).toEqual(before);
  });

  it('变量只能取白名单；预览缺样例报错', async () => {
    const { admin } = await fixture();
    const unknown = await admin('POST', WELCOME, { ifMatch: 0, body: letter({ body: '{{salary}}' }) });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { details: { reason: 'WELCOME_VARIABLE_UNKNOWN' } } });
    const ok = await (await admin('POST', WELCOME, { ifMatch: 0, body: letter() })).json();
    const { companyName: _omitted, ...partial } = samples;
    const missing = await admin('POST', `${WELCOME}/${ok.id}/preview`, { body: { samples: partial } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { details: { reason: 'PREVIEW_SAMPLE_MISSING' } } });
  });

  it('每租户至多一份启用；DELETE 归档返回 204，归档后不可再改', async () => {
    const { admin } = await fixture();
    const first = await (await admin('POST', WELCOME, { ifMatch: 0, body: letter({ enabled: true }) })).json();
    expect(first.status).toBe('enabled');
    const second = await admin('POST', WELCOME, { ifMatch: 0, body: letter({ enabled: true }) });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { details: { reason: 'WELCOME_ENABLED_EXISTS' } } });

    const stale = await admin('PATCH', `${WELCOME}/${first.id}`, { ifMatch: 9, body: { title: '过期{{hiredOn}}' } });
    expect(stale.status).toBe(409);
    const archived = await admin('DELETE', `${WELCOME}/${first.id}`, { ifMatch: first.revision });
    expect(archived.status).toBe(204);
    const list = await (await admin('GET', WELCOME)).json();
    expect(list.items).toEqual([]);
    const withArchived = await (await admin('GET', `${WELCOME}?archived=true`)).json();
    expect(withArchived.items).toMatchObject([{ id: first.id, status: 'archived', enabled: false }]);
    const edit = await admin('PATCH', `${WELCOME}/${first.id}`, { ifMatch: first.revision + 1, body: { name: 'x' } });
    expect(edit.status).toBe(409);
    const next = await admin('POST', WELCOME, { ifMatch: 0, body: letter({ enabled: true }) });
    expect(next.status).toBe(201);
  });

  it('完整双花括号占位先识别再按白名单拒绝：{{employee_name}} 等未知名称不能保存', async () => {
    const { admin } = await fixture();
    for (const body of ['{{employee_name}}你好', '{{ 员工 }}', '{{}}', '{{employeeName id}}']) {
      const response = await admin('POST', WELCOME, { ifMatch: 0, body: letter({ body }) });
      expect(response.status, body).toBe(400);
      expect(await response.json(), body).toMatchObject({
        error: { details: { reason: 'WELCOME_VARIABLE_UNKNOWN' } },
      });
    }
    const title = await admin('POST', WELCOME, { ifMatch: 0, body: letter({ title: '欢迎{{company_name}}' }) });
    expect(title.status).toBe(400);
    const spaced = await admin('POST', WELCOME, { ifMatch: 0, body: letter({ body: '{{ employeeName }}你好' }) });
    expect(spaced.status).toBe(201);
  });

  it('预览是只读路由：带命令键校验失败时，台账、业务审计、失败审计均无新增', async () => {
    const { db, tenantId, admin } = await fixture();
    const { id } = await (await admin('POST', WELCOME, { ifMatch: 0, body: letter() })).json();
    const before = await counts(db, tenantId);
    const { companyName: _omitted, ...partial } = samples;
    const key = `ZZ_BE16_PREVIEW_${uniqueSuffix()}`;
    const missing = await admin('POST', `${WELCOME}/${id}/preview`, {
      idempotencyKey: key,
      body: { samples: partial },
    });
    expect(missing.status).toBe(400);
    const invalid = await admin('POST', `${WELCOME}/${id}/preview`, { idempotencyKey: key, body: { nope: 1 } });
    expect(invalid.status).toBe(400);
    expect(await counts(db, tenantId)).toEqual(before);
  });

  it('归档后详情按当前行状态过滤动作：不含 edit、delete', async () => {
    const { admin } = await fixture();
    const made = await (await admin('POST', WELCOME, { ifMatch: 0, body: letter() })).json();
    expect((await (await admin('GET', `${WELCOME}/${made.id}`)).json()).availableActions).toEqual([
      'edit',
      'preview',
      'delete',
    ]);
    expect((await admin('DELETE', `${WELCOME}/${made.id}`, { ifMatch: made.revision })).status).toBe(204);
    const detail = await (await admin('GET', `${WELCOME}/${made.id}`)).json();
    expect(detail.status).toBe('archived');
    expect(detail.availableActions).not.toContain('edit');
    expect(detail.availableActions).not.toContain('delete');
  });

  it('非租户管理员无权读写配置，也不能预览', async () => {
    const { admin, hr } = await fixture();
    const made = await (await admin('POST', WELCOME, { ifMatch: 0, body: letter() })).json();
    expect((await hr('GET', WELCOME)).status).toBe(403);
    expect((await hr('POST', WELCOME, { ifMatch: 0, body: letter() })).status).toBe(403);
    expect((await hr('POST', `${WELCOME}/${made.id}/preview`, { body: { samples } })).status).toBe(403);
    expect((await hr('DELETE', `${WELCOME}/${made.id}`, { ifMatch: 1 })).status).toBe(403);
  });
});

describe('AC-EN-BE16-12 入职手册', () => {
  it('手册只含标题、段落与列表，预览转义；链接类块与未知变量被拒', async () => {
    const { admin } = await fixture();
    const created = await admin('POST', HANDBOOK, { ifMatch: 0, body: handbook() });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await created.json();
    const rendered = await (await admin('POST', `${HANDBOOK}/${id}/preview`, { body: { samples } })).json();
    expect(rendered.title).toBe('ZZ_BE16_公司入职手册');
    expect(rendered.blocks[1]).toMatchObject({ type: 'paragraph', html: expect.stringMatching(/&(?:lt|#60);b/) });
    const link = await admin('POST', HANDBOOK, {
      ifMatch: 0,
      body: handbook({ blocks: [{ type: 'link', url: 'https://example.com' }] }),
    });
    expect(link.status).toBe(400);
    const unknown = await admin('POST', HANDBOOK, {
      ifMatch: 0,
      body: handbook({ blocks: [{ type: 'paragraph', text: '{{idNumber}}' }] }),
    });
    expect(unknown.status).toBe(400);
  });

  it('完整双花括号占位先识别再按白名单拒绝：{{employee_name}} 等未知名称不能保存', async () => {
    const { admin } = await fixture();
    for (const text of ['{{employee_name}}', '{{ 员工 }}', '{{}}']) {
      const response = await admin('POST', HANDBOOK, {
        ifMatch: 0,
        body: handbook({ blocks: [{ type: 'list', items: ['正常', text] }] }),
      });
      expect(response.status, text).toBe(400);
      expect(await response.json(), text).toMatchObject({ error: { details: { reason: 'WELCOME_VARIABLE_UNKNOWN' } } });
    }
  });

  it('预览是只读路由：带命令键校验失败时，台账、业务审计、失败审计均无新增', async () => {
    const { db, tenantId, admin } = await fixture();
    const { id } = await (await admin('POST', HANDBOOK, { ifMatch: 0, body: handbook() })).json();
    const before = await counts(db, tenantId);
    const { departmentName: _omitted, ...partial } = samples;
    const key = `ZZ_BE16_HB_PREVIEW_${uniqueSuffix()}`;
    const missing = await admin('POST', `${HANDBOOK}/${id}/preview`, {
      idempotencyKey: key,
      body: { samples: partial },
    });
    expect(missing.status).toBe(400);
    const invalid = await admin('POST', `${HANDBOOK}/${id}/preview`, { idempotencyKey: key, body: {} });
    expect(invalid.status).toBe(400);
    expect(await counts(db, tenantId)).toEqual(before);
  });

  it('归档后详情按当前行状态过滤动作：不含 edit、delete', async () => {
    const { admin } = await fixture();
    const made = await (await admin('POST', HANDBOOK, { ifMatch: 0, body: handbook() })).json();
    expect((await (await admin('GET', `${HANDBOOK}/${made.id}`)).json()).availableActions).toEqual([
      'edit',
      'preview',
      'delete',
    ]);
    expect((await admin('DELETE', `${HANDBOOK}/${made.id}`, { ifMatch: made.revision })).status).toBe(204);
    const detail = await (await admin('GET', `${HANDBOOK}/${made.id}`)).json();
    expect(detail.status).toBe('archived');
    expect(detail.availableActions).not.toContain('edit');
    expect(detail.availableActions).not.toContain('delete');
  });

  it('手册没有扫码报到：无报到路由，库里没有报到事件或表', async () => {
    const { db, admin } = await fixture();
    const { id } = await (await admin('POST', HANDBOOK, { ifMatch: 0, body: handbook() })).json();
    for (const suffix of ['/check-in', '/checkin', '/scan']) {
      expect((await admin('POST', `${HANDBOOK}/${id}${suffix}`, { body: {} })).status).toBe(404);
    }
    const tables = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND (table_name ILIKE '%check_in%' OR table_name ILIKE '%checkin%')`);
    expect(Array.isArray(tables) ? tables : (tables as { rows: unknown[] }).rows).toEqual([]);
  });
});

async function jobsOf(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) => tx.select().from(onboardingWelcomeJobs));
}

async function poll(db: Db, at: string) {
  const errors: unknown[] = [];
  await startEmploymentActivationScheduler(db, { clock: () => new Date(at), onError: (e) => errors.push(e) }).stop();
  expect(errors).toEqual([]);
}

async function enableLetter(db: Db, tenantId: string, userId: string) {
  await withTenant(db, tenantId, (tx) =>
    tx.insert(onboardingWelcomeLetters).values({
      tenantId,
      name: `ZZ_BE16_JOB_${uniqueSuffix()}`,
      title: '欢迎',
      body: '{{employeeName}}',
      variables: ['employeeName'],
      enabled: true,
      createdBy: userId,
      updatedBy: userId,
    }),
  );
}

describe('AC-EN-BE16-12 欢迎信作业', () => {
  it('入职生效后恰好一条作业；重复轮询不重复，没有模板时跳过', async () => {
    const { db } = testDb();
    const w = await entryWorld(db, 'ZZ_BE16_JOB_NONE');
    const tenantId = w.session.tenant.id;
    const entry = await addPending(w, '2026-09-29', 'ZZ_BE16_JOB_NONE');
    expect(await jobsOf(db, tenantId)).toEqual([]);
    expect((await entryAction(w, entry.recordId, 'complete', { probation: false })).status).toBe(200);
    expect(await jobsOf(db, tenantId)).toMatchObject([{ status: 'pending', attempts: 0 }]);
    await poll(db, '2026-10-01T12:00:00Z');
    await poll(db, '2026-10-01T12:00:00Z');
    expect(await jobsOf(db, tenantId)).toMatchObject([
      { status: 'skipped', reason: 'WELCOME_NOT_CONFIGURED', attempts: 1 },
    ]);
  });

  it('有启用模板但投递能力未接入：作业转内部待投递，不再被扫描，也不会变成已发送', async () => {
    const { db } = testDb();
    const w = await entryWorld(db, 'ZZ_BE16_JOB_PENDING');
    const tenantId = w.session.tenant.id;
    await enableLetter(db, tenantId, w.session.user.id);
    const entry = await addPending(w, '2026-09-29', 'ZZ_BE16_JOB_PENDING');
    expect((await entryAction(w, entry.recordId, 'complete', { probation: false })).status).toBe(200);
    await poll(db, '2026-10-01T12:00:00Z');
    const [first] = await jobsOf(db, tenantId);
    expect(first).toMatchObject({ status: 'awaiting_delivery', reason: 'DELIVERY_ADAPTER_UNAVAILABLE', attempts: 1 });
    await poll(db, '2026-10-01T12:00:00Z');
    await poll(db, '2026-10-01T14:00:00Z');
    await poll(db, '2026-10-02T14:00:00Z');
    // 适配器就绪前不进入扫描：不再取锁、不再改行，attempts 与 updatedAt 都不变
    expect(await jobsOf(db, tenantId)).toEqual([first]);
    expect((await jobsOf(db, tenantId)).some((row) => row.status === 'done')).toBe(false);
  });

  it('离职先于首次消费：旧周期的欢迎信作业进入 skipped', async () => {
    const { db } = testDb();
    const w = await entryWorld(db, 'ZZ_BE16_JOB_LEFT');
    const tenantId = w.session.tenant.id;
    await enableLetter(db, tenantId, w.session.user.id);
    const entry = await addPending(w, '2026-09-29', 'ZZ_BE16_JOB_LEFT');
    expect((await entryAction(w, entry.recordId, 'complete', { probation: false })).status).toBe(200);
    const employee = await w.session.getEmployee(entry.employee.id);
    // 最后工作日 09-30，离职自 10-01 生效；入职那条历史记录本身仍是正式，只有当前任职变成离职
    await w.session.business(
      entry.employee.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      employee.revision,
    );
    await poll(db, '2026-10-01T12:00:00Z');
    expect(await jobsOf(db, tenantId)).toMatchObject([{ status: 'skipped', reason: 'EMPLOYMENT_ENDED', attempts: 1 }]);
  });

  it('未来入职日不提前入队，到日落地后才有一条作业', async () => {
    const { db } = testDb();
    const w = await entryWorld(db, 'ZZ_BE16_JOB_FUTURE');
    const tenantId = w.session.tenant.id;
    const { recordId } = await addPending(w, '2026-10-03', 'ZZ_BE16_JOB_FUTURE');
    // 提前办理：审批通过但未到入职日，阶段仍是待入职，不能提前发欢迎信
    expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
    expect(await jobsOf(db, tenantId)).toEqual([]);
    const sweep = (iso: string) =>
      runEmploymentActivations(
        db,
        { actorUserId: null, commandId: randomUUID() },
        { tenantId },
        { clock: () => new Date(iso) },
      );
    expect((await sweep('2026-10-02T15:59:00Z')).runs[0]?.errors).toEqual([]);
    expect(await jobsOf(db, tenantId)).toEqual([]);
    // 租户时区 2026-10-03 00:00 才算到日
    expect((await sweep('2026-10-02T16:00:00Z')).runs[0]?.errors).toEqual([]);
    expect(await jobsOf(db, tenantId)).toHaveLength(1);
    expect((await sweep('2026-10-03T17:00:00Z')).runs[0]?.errors).toEqual([]);
    expect(await jobsOf(db, tenantId)).toHaveLength(1);
    expect((await sweep('2026-10-03T18:00:00Z')).runs[0]?.errors).toEqual([]);
    expect(await jobsOf(db, tenantId)).toHaveLength(1);
  });

  it('入职事务回滚不遗留作业', async () => {
    const { db } = testDb();
    const w = await entryWorld(db, 'ZZ_BE16_JOB_ROLLBACK');
    const tenantId = w.session.tenant.id;
    const entry = await addPending(w, '2026-09-29', 'ZZ_BE16_JOB_ROLLBACK');
    const [stage] = await withTenant(db, tenantId, (tx) =>
      tx.select().from(onboardingEntryCases).where(eq(onboardingEntryCases.currentBusinessId, entry.recordId)),
    );
    const ctx = portContext(w, 0);
    await expect(
      withTenant(db, tenantId, async (tx) => {
        await entryLifecyclePort().apply(tx, ctx, {
          kind: 'hire',
          employeeId: entry.employee.id,
          businessId: entry.recordId,
          hiredRecordId: entry.recordId,
          hiredOn: '2026-09-29',
        });
        // 先证明事务内确实入了队，再抛错；事务外为零才说明是回滚而不是根本没入队
        expect(await tx.select().from(onboardingWelcomeJobs)).toHaveLength(1);
        throw new Error('ZZ_BE16_ROLLBACK');
      }),
    ).rejects.toThrow('ZZ_BE16_ROLLBACK');
    expect(await jobsOf(db, tenantId)).toEqual([]);
    const [after] = await withTenant(db, tenantId, (tx) =>
      tx.select().from(onboardingEntryCases).where(eq(onboardingEntryCases.id, stage!.id)),
    );
    expect(after).toMatchObject({ state: 'pending' });
  });
});

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!realPostgres)('AC-EN-BE16-12 欢迎信作业遇忙锁（真 PG）', () => {
  it('某作业的员工锁被持有时：消费者跳过它，后续候选与下一轮任职调度照常推进', async () => {
    const { db } = testDb();
    const w = await entryWorld(db, 'ZZ_BE16_JOB_LOCK');
    const tenantId = w.session.tenant.id;
    await enableLetter(db, tenantId, w.session.user.id);
    const held = await addPending(w, '2026-09-29', 'ZZ_BE16_LOCK_HELD');
    const free = await addPending(w, '2026-09-29', 'ZZ_BE16_LOCK_FREE');
    const later = await addPending(w, '2026-10-03', 'ZZ_BE16_LOCK_LATER');
    for (const entry of [held, free, later]) {
      expect((await entryAction(w, entry.recordId, 'complete', { probation: false })).status).toBe(200);
    }
    expect(await jobsOf(db, tenantId)).toHaveLength(2);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked = false;
    const holder = withTenant(db, tenantId, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM employment_employees
        WHERE tenant_id = ${tenantId} AND id = ${held.employee.id}::uuid FOR NO KEY UPDATE`);
      locked = true;
      await gate;
    });
    try {
      while (!locked) await pause(5);
      const errors: unknown[] = [];
      const at = '2026-10-03T12:00:00Z';
      const finished = startEmploymentActivationScheduler(db, {
        clock: () => new Date(at),
        onError: (e) => errors.push(e),
      })
        .stop()
        .then(() => 'finished' as const);
      const outcome = await Promise.race([finished, pause(15_000).then(() => 'blocked' as const)]);
      expect(outcome).toBe('finished');
      expect(errors).toEqual([]);
      const rows = await jobsOf(db, tenantId);
      // 下一轮任职调度照常推进：第三个未来入职日的员工已落地并入队
      expect(rows).toHaveLength(3);
      const byCase = new Map(rows.map((row) => [row.caseId, row]));
      const cases = await withTenant(db, tenantId, (tx) => tx.select().from(onboardingEntryCases));
      const caseOf = (employeeId: string) => cases.find((row) => row.employeeId === employeeId)!.id;
      expect(byCase.get(caseOf(held.employee.id))).toMatchObject({ status: 'pending', attempts: 0 });
      expect(byCase.get(caseOf(free.employee.id))).toMatchObject({ status: 'awaiting_delivery', attempts: 1 });
      expect(byCase.get(caseOf(later.employee.id))).toMatchObject({ status: 'awaiting_delivery', attempts: 1 });
    } finally {
      release();
      await holder;
    }
    await poll(db, '2026-10-03T13:00:00Z');
    expect((await jobsOf(db, tenantId)).map((row) => row.status)).toEqual([
      'awaiting_delivery',
      'awaiting_delivery',
      'awaiting_delivery',
    ]);
  });
});
