/**
 * BE-15a 自动转正（docs/02_业务建模/29 PB-R16 / R18 / R19 / R21 / R22，§4 AC-PB-07 / 11 / 13 / 14；
 * 差距表 B57、补证结论 R2e7；DEC-533② 单条启停、DEC-539① 每日定时 + 立即执行、DEC-539② 规则名称）：
 * - 规则：名称*、优先级*、适用组织*（可取消包含下级）、业务处理规则*（自动转正 / 自动发起转正申请 + 到期前 0～999 天）、
 *   发起人类型*；行操作编辑 / 复制 / 删除 / 启停；
 * - 触发（R2e7，03 口径）：目标日 = 预计试用结束日 − N 天，目标日 ≤ 当天且仍在试用、本任职尚未由本规则发起的人都发起；
 * - 发起走 BE-3 的转正创建入口（默认转正日期 = 预计试用结束日次日，F-205），申请走同一提交入口；发起人取规则配置，
 *   审批日志与发起台账带“系统代发”标记；同一任职同一规则只发起一次（立即执行、每日批次重复执行都不重复）。
 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  draftRegularization,
  employeeRevision,
  hire,
  pbWorld,
  probationOf,
  regularizeAt,
  transition,
  type PbWorld,
} from './AC-PB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const SCHEDULER = '../../apps/api/src/modules/employment/auto-regularization-scheduler.js';
const SWITCH = 'probation.auto_regularization_enabled';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface Rule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly includeSubordinates: boolean;
  readonly mode: 'direct' | 'application';
  readonly daysBefore: number;
  readonly initiatorType: string;
  readonly probationResult: string;
  readonly enabled: boolean;
  readonly revision: number;
}

interface RunReceipt {
  readonly businessDate: string;
  readonly launched: { employeeId: string; ruleId: string; businessId: string; businessStatus: string }[];
  readonly failed: { employeeId: string; ruleId: string; reason: string }[];
}

interface SchedulerModule {
  runAutoRegularizations(
    db: Db,
    meta: { actorUserId: null; commandId: string },
    input?: { tenantId?: string },
    options?: { clock?: () => Date },
  ): Promise<{ runs: (RunReceipt & { tenantId: string; ran: boolean })[] }>;
}

async function autoWorld(label: string, options: { approval?: boolean } = {}) {
  const w = await pbWorld(testDb().db, `auto-reg-${label}`, options);
  const settings = tenantApi(w.db);
  const as = { tenant: w.session.tenant.id, user: w.session.user.id };
  const body = (extra: Record<string, unknown> = {}) => ({
    name: '到期当天自动发起转正申请',
    priority: 1,
    orgIds: [w.org.id],
    includeSubordinates: true,
    mode: 'application',
    daysBefore: 0,
    initiatorType: 'rule_operator',
    ...extra,
  });
  const create = (value: unknown, ifMatch = 0) =>
    w.session.request('POST', '/auto-regularization-rules', { ifMatch, body: value });
  async function created(value: unknown): Promise<Rule> {
    const response = await create(value);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Rule;
  }
  async function list(): Promise<Rule[]> {
    const response = await w.session.request('GET', '/auto-regularization-rules');
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Rule[] }).items;
  }
  async function enableSwitch(value = true) {
    const current = await settings.request('GET', `/api/tenant/settings/${SWITCH}`, as);
    expect(current.status, await current.clone().text()).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const put = await settings.request('PUT', `/api/tenant/settings/${SWITCH}`, {
      ...as,
      ifMatch: revision,
      body: { value },
    });
    expect(put.status, await put.clone().text()).toBe(200);
  }
  const runNow = (key?: string) =>
    w.session.request('POST', '/auto-regularization/run', { ifMatch: 0, body: {}, idempotencyKey: key });
  async function ran(key?: string): Promise<RunReceipt> {
    const response = await runNow(key);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as RunReceipt;
  }
  return { ...w, settings, as, body, create, created, list, enableSwitch, runNow, ran };
}

async function scheduler(): Promise<SchedulerModule> {
  const module = (await import(SCHEDULER).catch(() => null)) as SchedulerModule | null;
  expect(module, '缺少自动转正调度入口').not.toBeNull();
  return module!;
}

async function regularizations(w: PbWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rows<{ id: string; state: string; effective_date: string; mode: string }>(
      await tx.execute(sql`SELECT b.id, s.state, p.effective_date::text AS effective_date, p.mode
        FROM employment_business_objects b
        JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
          AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
        JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
          AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
        WHERE b.tenant_id=${w.session.tenant.id} AND b.employee_id=${employeeId}::uuid
          AND p.kind='regularization' ORDER BY b.id`),
    ),
  );
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;

describe('AC-PB-13 自动转正规则“到期前天数”', () => {
  it('0 可保存；空值、负数、小数、超过 999 拒绝，提示“请设置0至999的整数”，均不写入', async () => {
    const w = await autoWorld('days');
    expect((await w.created(w.body({ daysBefore: 0 }))).daysBefore).toBe(0);
    expect((await w.created(w.body({ name: '到期前 999 天', daysBefore: 999 }))).daysBefore).toBe(999);
    for (const daysBefore of [null, undefined, -1, 1.5, 1000, '3']) {
      const response = await w.create(w.body({ daysBefore }));
      expect(response.status, `${String(daysBefore)} → ${await response.clone().text()}`).toBe(400);
      const error = await errorOf(response);
      expect(error.message).toBe('请设置0至999的整数');
      expect(error.details?.reason).toBe('AUTO_RULE_DAYS_INVALID');
    }
    expect(await w.list()).toHaveLength(2);
  });
});

describe('AC-PB-14 规则名称与行操作（DEC-539②、DEC-533②）', () => {
  it('不填名称被拒；列表按优先级显示名称；编辑 / 复制 / 启停 / 删除各自 revision 校验并写配置审计', async () => {
    const w = await autoWorld('crud');
    for (const name of [undefined, '', '  ']) {
      const response = await w.create(w.body({ name }));
      expect(response.status, await response.clone().text()).toBe(400);
    }
    for (const extra of [
      { orgIds: [] },
      { orgIds: ['00000000-0000-4000-8000-000000000000'] },
      { mode: 'other' },
      { initiatorType: 'nobody' },
      { probationResult: 'unknown' },
      { priority: -1 },
    ]) {
      const response = await w.create(w.body(extra));
      expect(response.status, `${JSON.stringify(extra)} → ${await response.clone().text()}`).toBe(400);
    }
    expect((await w.create(w.body(), 3)).status).toBe(409);
    expect(await w.list()).toEqual([]);

    const later = await w.created(w.body({ name: '直接自动转正', priority: 5, mode: 'direct', daysBefore: 3 }));
    const first = await w.created(w.body({ priority: 1 }));
    expect(first).toMatchObject({
      name: '到期当天自动发起转正申请',
      includeSubordinates: true,
      mode: 'application',
      daysBefore: 0,
      initiatorType: 'rule_operator',
      probationResult: 'normal',
      enabled: true,
      revision: 1,
    });
    expect((await w.list()).map((rule) => rule.name)).toEqual(['到期当天自动发起转正申请', '直接自动转正']);

    const edited = await w.session.request('PUT', `/auto-regularization-rules/${later.id}`, {
      ifMatch: 1,
      body: w.body({ name: '直接自动转正（改）', priority: 0, mode: 'direct', includeSubordinates: false }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ name: '直接自动转正（改）', includeSubordinates: false, revision: 2 });
    const stale = await w.session.request('PUT', `/auto-regularization-rules/${later.id}`, {
      ifMatch: 1,
      body: w.body(),
    });
    expect(stale.status).toBe(409);

    const copied = await w.session.request('POST', `/auto-regularization-rules/${first.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const copy = (await copied.json()) as Rule;
    expect(copy.id).not.toBe(first.id);
    expect(copy).toMatchObject({ name: '到期当天自动发起转正申请（复制）', enabled: false, revision: 1, priority: 1 });

    const disabled = await w.session.request('PUT', `/auto-regularization-rules/${first.id}/enabled`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: false, revision: 2 });
    expect(
      (
        await w.session.request('PUT', `/auto-regularization-rules/${first.id}/enabled`, {
          ifMatch: 1,
          body: { enabled: true },
        })
      ).status,
    ).toBe(409);

    expect((await w.session.request('DELETE', `/auto-regularization-rules/${copy.id}`, { ifMatch: 9 })).status).toBe(
      409,
    );
    const removed = await w.session.request('DELETE', `/auto-regularization-rules/${copy.id}`, { ifMatch: 1 });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.list()).map((rule) => rule.id)).toEqual([later.id, first.id]);
    expect((await w.session.request('DELETE', `/auto-regularization-rules/${copy.id}`, { ifMatch: 1 })).status).toBe(
      404,
    );
    const audits = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events WHERE tenant_id=${w.session.tenant.id}
          AND object_type='auto_regularization_rule' ORDER BY occurred_at, action`),
      ),
    );
    expect(audits.map((a) => a.action).sort()).toEqual(
      [
        'auto_regularization_rule.create',
        'auto_regularization_rule.create',
        'auto_regularization_rule.create',
        'auto_regularization_rule.update',
        'auto_regularization_rule.disable',
        'auto_regularization_rule.delete',
      ].sort(),
    );
  });

  it('立即执行：总开关关闭 409；打开后按规则发起（系统代发、发起人 = 规则保存人），再执行与每日批次都不重复', async () => {
    const w = await autoWorld('run-now', { approval: true });
    const rule = await w.created(w.body());
    // 试用期 09-01～09-30：目标日 09-30 ≤ 今天 10-01（补发，AC-PB-07）
    const due = await hire(w, { date: '2026-09-01', months: 1, name: '到期员工' });
    // 试用期 09-01～11-30：目标日 11-30 > 今天，不发起（R2e7 负例）
    const notDue = await hire(w, { date: '2026-09-01', months: 3, name: '未到期员工' });

    const closed = await w.runNow();
    expect(closed.status).toBe(409);
    expect((await errorOf(closed)).details?.reason).toBe('AUTO_REGULARIZATION_DISABLED');
    await w.enableSwitch();

    const receipt = await w.ran();
    expect(receipt.businessDate).toBe('2026-10-01');
    expect(receipt.failed).toEqual([]);
    expect(receipt.launched).toHaveLength(1);
    expect(receipt.launched[0]).toMatchObject({
      employeeId: due.employee.id,
      ruleId: rule.id,
      businessStatus: 'in_review',
    });
    const [business] = await regularizations(w, due.employee.id);
    // 转正日期 = 预计试用结束日次日（F-205，R2e7 第 3 条）
    expect(business).toMatchObject({ state: 'in_review', mode: 'application', effective_date: '2026-10-01' });
    expect(await regularizations(w, notDue.employee.id)).toEqual([]);

    const [log] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ initiator: string; proxy: boolean | null; actor: string | null }>(
        await tx.execute(sql`SELECT i.initiator_user_id::text AS initiator,
            (l.detail->>'systemProxy')::boolean AS proxy,
            l.actor_user_id::text AS actor
          FROM approval_instances i JOIN approval_instance_logs l ON l.tenant_id=i.tenant_id AND l.instance_id=i.id
          WHERE i.tenant_id=${w.session.tenant.id} AND i.business_id=${business!.id}::uuid AND l.event='start'`),
      ),
    );
    expect(log).toEqual({ initiator: w.session.user.id, proxy: true, actor: w.session.user.id });
    const [launch] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ state: string; business_id: string; system_proxy: boolean; initiator_user_id: string }>(
        await tx.execute(sql`SELECT state, business_id::text, system_proxy, initiator_user_id::text
          FROM employment_auto_regularization_launches WHERE tenant_id=${w.session.tenant.id}
            AND employee_id=${due.employee.id}::uuid`),
      ),
    );
    expect(launch).toEqual({
      state: 'launched',
      business_id: business!.id,
      system_proxy: true,
      initiator_user_id: w.session.user.id,
    });

    // 再次立即执行（新命令）不重复；同键重放返回原回执
    expect((await w.ran()).launched).toEqual([]);
    const key = randomUUID();
    const once = await w.ran(key);
    expect(await w.ran(key)).toEqual(once);
    // 次日凌晨批次（北京 10-02 04:30）也不重复（R2e7：OF_03 次日未再生成第二条）
    const { runAutoRegularizations } = await scheduler();
    const nextDay = await runAutoRegularizations(
      w.db,
      { actorUserId: null, commandId: randomUUID() },
      { tenantId: w.session.tenant.id },
      { clock: () => new Date('2026-10-01T20:30:00.000Z') },
    );
    expect(nextDay.runs).toHaveLength(1);
    expect(nextDay.runs[0]).toMatchObject({ ran: true, businessDate: '2026-10-02', launched: [], failed: [] });
    expect(await regularizations(w, due.employee.id)).toHaveLength(1);
  });

  it('立即执行要任职设置配置写权限（与规则维护同一权限）：无权 403，不发起', async () => {
    const w = await autoWorld('run-forbidden');
    await w.created(w.body({ mode: 'direct' }));
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    await w.enableSwitch();
    const denied = tenantApi(w.db, {
      authorize: (request) => request.action !== 'tenant.employment.configuration.write',
      clock: () => new Date('2026-10-01T01:00:00.000Z'),
    });
    const response = await denied.request('POST', '/api/tenant/employment/auto-regularization/run', {
      ...w.as,
      ifMatch: 0,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await regularizations(w, due.employee.id)).toEqual([]);
  });
});

describe('PB-R18 / R19 / R21 自动转正的触发与失败条件', () => {
  it('自动转正（直接生成）：转正日期取预计结束日次日，到日生效后人员状态改正式', async () => {
    const w = await autoWorld('direct');
    const rule = await w.created(w.body({ mode: 'direct', daysBefore: 3 }));
    // 试用期 09-01～10-03：目标日 09-30 ≤ 今天，转正日期 10-04（未来生效）
    const due = await hire(w, { date: '2026-09-01', endDate: '2026-10-03' });
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt.launched).toEqual([
      expect.objectContaining({ employeeId: due.employee.id, ruleId: rule.id, businessStatus: 'effective' }),
    ]);
    const [business] = await regularizations(w, due.employee.id);
    expect(business).toMatchObject({ mode: 'direct', effective_date: '2026-10-04' });
    expect((await probationOf(w, due.employee.id, '2026-10-04')).regularizationDate).toBe('2026-10-04');
  });

  it('AC-PB-11 停用的规则不命中、不发起；重新启用后恢复', async () => {
    const w = await autoWorld('toggle');
    const rule = await w.created(w.body({ mode: 'direct' }));
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    await w.enableSwitch();
    const off = await w.session.request('PUT', `/auto-regularization-rules/${rule.id}/enabled`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(off.status, await off.clone().text()).toBe(200);
    expect((await w.ran()).launched).toEqual([]);
    expect(await regularizations(w, due.employee.id)).toEqual([]);
    const on = await w.session.request('PUT', `/auto-regularization-rules/${rule.id}/enabled`, {
      ifMatch: 2,
      body: { enabled: true },
    });
    expect(on.status, await on.clone().text()).toBe(200);
    expect((await w.ran()).launched.map((item) => item.employeeId)).toEqual([due.employee.id]);
  });

  it('适用组织：取消“包含下级”时下级部门的人不命中；多条命中取优先级数字最小的一条', async () => {
    const w = await autoWorld('scope');
    const child = await w.session.org('试用下级部门', {
      establishedOn: '2026-01-01',
      parents: { admin: { parentId: w.org.id } },
    });
    const top = await w.created(w.body({ mode: 'direct', includeSubordinates: false, priority: 1 }));
    const inChild = await hire({ ...w, org: child }, { date: '2026-09-01', months: 1, name: '下级部门员工' });
    const inTop = await hire(w, { date: '2026-09-01', months: 1, name: '本部门员工' });
    await w.enableSwitch();
    expect((await w.ran()).launched.map((item) => [item.employeeId, item.ruleId])).toEqual([
      [inTop.employee.id, top.id],
    ]);
    // 优先级 0 的规则（含下级）对下级部门的人优先于其他规则
    const wide = await w.created(w.body({ name: '含下级', mode: 'direct', priority: 0 }));
    const late = await w.created(w.body({ name: '优先级低', mode: 'direct', priority: 9 }));
    const receipt = await w.ran();
    expect(receipt.launched.map((item) => [item.employeeId, item.ruleId])).toEqual([[inChild.employee.id, wide.id]]);
    expect(receipt.launched.some((item) => item.ruleId === late.id)).toBe(false);
  });

  it('已转正、已离职、不在试用期、预计结束日缺失的人不发起', async () => {
    const w = await autoWorld('negatives');
    await w.created(w.body({ mode: 'direct' }));
    const regularized = await hire(w, { date: '2026-09-01', months: 1, name: '已转正' });
    await regularizeAt(w, regularized.employee.id, '2026-09-20');
    const left = await hire(w, { date: '2026-09-01', months: 1, name: '已离职' });
    await w.session.business(
      left.employee.id,
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-09-25', lastWorkDate: '2026-09-24' },
      await employeeRevision(w, left.employee.id),
    );
    const regular = await hire(w, { date: '2026-09-01', probation: false, name: '无试用期' });
    const noEnd = await hire(w, { date: '2026-09-01', name: '无预计结束日' });
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt).toMatchObject({ launched: [], failed: [] });
    expect(await regularizations(w, regularized.employee.id)).toHaveLength(1);
    for (const person of [left, regular, noEnd]) expect(await regularizations(w, person.employee.id)).toEqual([]);
  });

  it('PB-R21：本周期已有审批中的转正申请时自动转正失败，记录原因、不新建业务；失败可在下一次执行重试', async () => {
    const w = await autoWorld('blocked', { approval: true });
    const rule = await w.created(w.body({ mode: 'direct' }));
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    const draft = await draftRegularization(w, due.employee.id, '2026-10-01');
    expect((await transition(w, draft, 'submit')).status).toBe(200);
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt.launched).toEqual([]);
    expect(receipt.failed).toEqual([{ employeeId: due.employee.id, ruleId: rule.id, reason: 'REGULARIZATION_EXISTS' }]);
    expect((await w.ran()).failed).toHaveLength(1);
    const [launch] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ state: string; attempts: number; last_reason: string; business_id: string | null }>(
        await tx.execute(sql`SELECT state, attempts, last_reason, business_id
          FROM employment_auto_regularization_launches
          WHERE tenant_id=${w.session.tenant.id} AND employee_id=${due.employee.id}::uuid`),
      ),
    );
    expect(launch).toEqual({ state: 'failed', attempts: 2, last_reason: 'REGULARIZATION_EXISTS', business_id: null });
    expect(await regularizations(w, due.employee.id)).toHaveLength(1);
  });

  it('发起人按主职部门 HRBP：部门没有 HRBP 时失败（INITIATOR_NOT_FOUND），不发起', async () => {
    const w = await autoWorld('hrbp-missing');
    await w.created(w.body({ mode: 'direct', initiatorType: 'department_hrbp' }));
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt.failed.map((item) => item.reason)).toEqual(['INITIATOR_NOT_FOUND']);
    expect(await regularizations(w, due.employee.id)).toEqual([]);
  });

  it('发起人按主职部门 HRBP（R2e7 B2 样本按身份 HRBP）：发起人为该 HRBP 的账号，台账带系统代发', async () => {
    const w = await autoWorld('hrbp');
    await w.created(w.body({ mode: 'direct', initiatorType: 'department_hrbp' }));
    const hrbp = await hire(w, { date: '2026-01-05', probation: false, name: '部门 HRBP' });
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    // 可信夹具：追加一条组织版本写入 HRBP（人员 ID），同 AC-APV-support setOrgRoles
    const hrbpUser = await withTenant(w.db, w.session.tenant.id, async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, w.org.id))
        .orderBy(sql`version_no DESC`)
        .limit(1);
      const versionId = randomUUID();
      await tx.insert(orgVersions).values({
        ...old!,
        id: versionId,
        versionNo: old!.versionNo + 1,
        previousVersionId: old!.id,
        hrbpId: hrbp.employee.id,
      });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
      const [link] = rows<{ user_id: string }>(
        await tx.execute(sql`SELECT user_id::text FROM permission_user_person_links
          WHERE tenant_id=${w.session.tenant.id} AND employee_id=${hrbp.employee.id}::uuid`),
      );
      return link!.user_id;
    });
    await w.enableSwitch();
    const receipt = await w.ran();
    expect(receipt.failed).toEqual([]);
    expect(receipt.launched).toEqual([
      expect.objectContaining({ employeeId: due.employee.id, initiatorUserId: hrbpUser }),
    ]);
    const [launch] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ initiator_user_id: string; system_proxy: boolean }>(
        await tx.execute(sql`SELECT initiator_user_id::text, system_proxy FROM employment_auto_regularization_launches
          WHERE tenant_id=${w.session.tenant.id} AND employee_id=${due.employee.id}::uuid`),
      ),
    );
    expect(launch).toEqual({ initiator_user_id: hrbpUser, system_proxy: true });
  });

  it('每日批次：租户本地 04:00 前不执行；总开关关闭时不执行也不占用当天批次', async () => {
    const w = await autoWorld('daily');
    await w.created(w.body({ mode: 'direct' }));
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    const { runAutoRegularizations } = await scheduler();
    const run = (iso: string) =>
      runAutoRegularizations(
        w.db,
        { actorUserId: null, commandId: randomUUID() },
        { tenantId: w.session.tenant.id },
        { clock: () => new Date(iso) },
      );
    // 北京 10-02 06:00，开关关闭
    expect((await run('2026-10-01T22:00:00.000Z')).runs[0]).toMatchObject({ ran: false });
    await w.enableSwitch();
    // 北京 10-02 03:00：未到批次时点
    expect((await run('2026-10-01T19:00:00.000Z')).runs[0]).toMatchObject({ ran: false });
    const morning = await run('2026-10-01T22:00:00.000Z');
    expect(morning.runs[0]).toMatchObject({ ran: true, businessDate: '2026-10-02' });
    expect(morning.runs[0]!.launched.map((item) => item.employeeId)).toEqual([due.employee.id]);
    // 同一天再触发：批次已执行，不再扫描
    expect((await run('2026-10-02T03:00:00.000Z')).runs[0]).toMatchObject({ ran: false });
    expect(await regularizations(w, due.employee.id)).toHaveLength(1);
  });
});
