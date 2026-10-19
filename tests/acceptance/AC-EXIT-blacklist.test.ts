/**
 * R2 BE-8b1 / AC-DM-06 端到端、DM-R2、DM-R3、DEC-266②、DEC-630：离职加黑接线（离职生效写黑名单）。
 * - 离职表单加黑字段：addToBlacklist=true 另收有效截止日期（空 = 永久）、加黑原因（必填）、加黑说明（≤500）；false 时不得带这三项；
 *   本人申请 / 经理代发不出现这些字段。
 * - 离职生效订阅 exitPostEffectHooks.onEffective：手动勾选优先（source = manual，加黑日期 = 离职生效日）；否则总开关开启时按规则匹配
 *   （source = auto_rule；永久 = 截止日为空，离职当月 = 生效日所在自然月月底）；三种生效来源（approval / direct / free_direct）都执行。
 * - 本人已在有效名单：跳过并在审计留痕、不回滚离职；其他错误整笔生效回滚；同一笔离职最多写一行。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { pgErrorCode, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { addBlacklistEntry } from '../../apps/api/src/modules/employment/blacklist.js';
import { applyInitiationSubset, type ExitOptions } from '../../apps/api/src/modules/employment/exit-initiation.js';
import {
  blacklistExitWorld,
  DUE_LAST_WORK_DATE,
  FUTURE_EFFECTIVE_DATE,
  FUTURE_LAST_WORK_DATE,
  TODAY,
} from './AC-EXIT-blacklist-support.js';

const database = useTestDb();
const world = (label: string) => blacklistExitWorld(database().db, label);
const MANUAL = { addToBlacklist: true, blacklistReason: 'integrity', blacklistNote: '合成加黑说明' };

describe('离职表单加黑字段（DM-R2；R2f B68）', () => {
  it('addToBlacklist=true：原因必填；有效截止日期可空（永久）；扩展行保存三项', async () => {
    const x = await world('fields-ok');
    const missing = await x.reasonOf(
      await x.createExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', { addToBlacklist: true }),
    );
    expect(missing).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', reason: 'EXIT_BLACKLIST_REASON_REQUIRED' });
    const created = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', {
      ...MANUAL,
      blacklistExpiryDate: '2026-12-31',
    });
    expect(await x.exitColumns(created.id)).toEqual([
      { add: true, reason: 'integrity', expiry: '2026-12-31', note: '合成加黑说明' },
    ]);
  });

  it('addToBlacklist 缺省 / false 时带任一项 → 400；原因不在选项内、说明超 500 字 → 400', async () => {
    const x = await world('fields-bad');
    for (const exit of [
      { blacklistReason: 'integrity' },
      { addToBlacklist: false, blacklistExpiryDate: '2026-12-31' },
      { addToBlacklist: false, blacklistNote: '说明' },
    ]) {
      const response = await x.createExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', exit);
      expect(await x.reasonOf(response), JSON.stringify(exit)).toMatchObject({
        status: 400,
        reason: 'EXIT_BLACKLIST_FIELDS_NOT_ALLOWED',
      });
    }
    for (const exit of [
      { addToBlacklist: true, blacklistReason: 'not-a-reason' },
      { addToBlacklist: true, blacklistReason: 'integrity', blacklistNote: '字'.repeat(501) },
      { addToBlacklist: true, blacklistReason: 'integrity', blacklistExpiryDate: '2026-02-30' },
    ]) {
      const response = await x.createExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', exit);
      expect((await x.reasonOf(response)).status, JSON.stringify(exit)).toBe(400);
    }
  });

  it('有效截止日期早于离职生效日 → 400（与黑名单页同一口径）；等于生效日可保存', async () => {
    const x = await world('fields-expiry');
    const early = await x.createExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', {
      ...MANUAL,
      blacklistExpiryDate: '2026-10-10',
    });
    expect(await x.reasonOf(early)).toMatchObject({ status: 400, reason: 'BLACKLIST_EXPIRY_BEFORE_DATE' });
    const same = await x.createExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', {
      ...MANUAL,
      blacklistExpiryDate: FUTURE_EFFECTIVE_DATE,
    });
    expect(same.status, await same.clone().text()).toBe(201);
  });

  it('编辑离职（PATCH）与创建同一校验：“是”改“否”清掉三项；未勾选时单独改原因 400；“否”改“是”须带原因', async () => {
    const x = await world('fields-patch');
    const leave = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', {
      ...MANUAL,
      blacklistExpiryDate: '2026-12-31',
    });
    const patch = async (body: object) =>
      x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: (await x.business(leave.id)).revision,
        body,
      });
    const cleared = await patch({ addToBlacklist: false });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await x.exitColumns(leave.id)).toEqual([{ add: false, reason: null, expiry: null, note: null }]);
    const alone = await patch({ blacklistReason: 'resignation' });
    expect(await x.reasonOf(alone)).toMatchObject({ status: 400, reason: 'EXIT_BLACKLIST_FIELDS_NOT_ALLOWED' });
    const noReason = await patch({ addToBlacklist: true });
    expect(await x.reasonOf(noReason)).toMatchObject({ status: 400, reason: 'EXIT_BLACKLIST_REASON_REQUIRED' });
    const early = await patch({
      addToBlacklist: true,
      blacklistReason: 'resignation',
      blacklistExpiryDate: '2026-10-10',
    });
    expect(await x.reasonOf(early)).toMatchObject({ status: 400, reason: 'BLACKLIST_EXPIRY_BEFORE_DATE' });
    const set = await patch({ addToBlacklist: true, blacklistReason: 'resignation', blacklistNote: '改后说明' });
    expect(set.status, await set.clone().text()).toBe(200);
    expect(await x.exitColumns(leave.id)).toEqual([
      { add: true, reason: 'resignation', expiry: null, note: '改后说明' },
    ]);
    // 编辑后的内容就是生效时写入的内容
    await x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    expect(await x.activeRows(x.employee.id)).toEqual([
      expect.objectContaining({ reason: 'resignation', note: '改后说明', expiryDate: null }),
    ]);
  });

  it('员工自助离职 / 经理代发不出现加黑字段（规格 30 第 22 行）', () => {
    const exits: ExitOptions[] = [
      { whereaboutsCode: 'startup', blacklistReason: 'integrity' },
      { whereaboutsCode: 'startup', blacklistExpiryDate: '2026-12-31' },
      { whereaboutsCode: 'startup', blacklistNote: '说明' },
    ];
    for (const exit of exits)
      for (const initiation of ['self', 'manager'] as const)
        expect(() => applyInitiationSubset(initiation, 'application', exit)).toThrowError(
          expect.objectContaining({
            details: expect.objectContaining({ reason: 'EXIT_FIELD_NOT_ALLOWED_FOR_INITIATION' }),
          }),
        );
  });

  it('批量离职入口同样接受并校验三项，保存到每人的扩展行', async () => {
    const x = await world('fields-batch');
    const other = (await x.colleague('批量乙')).id;
    const items = await Promise.all(
      [x.employee.id, other].map(async (employeeId, index) => ({
        employeeId,
        revision: (await x.session.getEmployee(employeeId)).revision,
        lastWorkDate: '2026-10-20',
        exit: { exitTypeCode: 'voluntary', ...(index === 0 ? MANUAL : {}) },
      })),
    );
    // 加黑参数不合法是请求本身的错误：严格 400（不是业务门禁整批 409 EXIT_BATCH_REJECTED），且整批没有任何写入
    const before = await Promise.all([x.employee.id, other].map((id) => x.stateOf(id)));
    for (const [label, exit, reason] of [
      [
        '未勾选却带原因',
        { exitTypeCode: 'voluntary', blacklistReason: 'integrity' },
        'EXIT_BLACKLIST_FIELDS_NOT_ALLOWED',
      ],
      ['勾选却不带原因', { exitTypeCode: 'voluntary', addToBlacklist: true }, 'EXIT_BLACKLIST_REASON_REQUIRED'],
      [
        '截止日期早于离职生效日',
        { exitTypeCode: 'voluntary', ...MANUAL, blacklistExpiryDate: '2026-10-20' },
        'BLACKLIST_EXPIRY_BEFORE_DATE',
      ],
    ] as const) {
      const bad = await x.session.request('POST', '/exits/batch', {
        body: { items: [items[0]!, { ...items[1]!, exit }] },
      });
      expect(await x.reasonOf(bad), label).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', reason });
    }
    expect(await Promise.all([x.employee.id, other].map((id) => x.stateOf(id)))).toEqual(before);
    const response = await x.session.request('POST', '/exits/batch', { body: { items } });
    expect(response.status, await response.clone().text()).toBe(201);
    const { items: created } = (await response.json()) as { items: { id: string }[] };
    expect(await x.exitColumns(created[0]!.id)).toEqual([
      { add: true, reason: 'integrity', expiry: null, note: '合成加黑说明' },
    ]);
    expect(await x.exitColumns(created[1]!.id)).toEqual([{ add: false, reason: null, expiry: null, note: null }]);
  });
});

describe('手动勾选：离职生效后才进名单（DM-R2、DEC-630）', () => {
  it('生效前名单里没有；生效后出现一行 manual，加黑日期 = 离职生效日，记下离职请求 ID；永久', async () => {
    const x = await world('manual');
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, { ...MANUAL, exitTypeCode: 'voluntary' });
    expect(await x.activeRows(x.employee.id)).toEqual([]);
    expect((await x.page.list()).items).toEqual([]);
    await x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    expect(await x.activeRows(x.employee.id)).toEqual([
      expect.objectContaining({
        source: 'manual',
        reason: 'integrity',
        blacklistDate: FUTURE_EFFECTIVE_DATE,
        expiryDate: null,
        note: '合成加黑说明',
        exitRequestId: leave.id,
      }),
    ]);
    expect((await x.page.list()).items).toHaveLength(1);
  });

  it('带有效截止日期的手动勾选：截止日期原样写入', async () => {
    const x = await world('manual-expiry');
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, { ...MANUAL, blacklistExpiryDate: '2027-03-01' });
    await x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    expect((await x.activeRows(x.employee.id))[0]).toMatchObject({ source: 'manual', expiryDate: '2027-03-01' });
  });

  it('未勾选且总开关关闭（系统值）：不写名单', async () => {
    const x = await world('manual-off');
    await x.addRule([x.from.id]);
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, { exitTypeCode: 'voluntary' });
    await x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    expect(await x.rows(x.employee.id)).toEqual([]);
  });

  it.each([
    ['direct', async (x: Awaited<ReturnType<typeof world>>) => x.directLeave(FUTURE_LAST_WORK_DATE, MANUAL), undefined],
    [
      'free_direct',
      async (x: Awaited<ReturnType<typeof world>>) => x.directLeave(FUTURE_LAST_WORK_DATE, MANUAL),
      'free_direct' as const,
    ],
  ])('生效来源 %s：同样写名单', async (_source, leaveOf, source) => {
    const x = await world(`source-${_source}`);
    const leave = await leaveOf(x);
    await x.activate(leave.id, FUTURE_EFFECTIVE_DATE, { trigger: 'scheduler', ...(source ? { source } : {}) });
    expect(await x.activeRows(x.employee.id)).toEqual([
      expect.objectContaining({ source: 'manual', exitRequestId: leave.id }),
    ]);
  });

  it('生效来源 approval：离职申请审批通过后到期生效，同样写名单', async () => {
    const x = await world('source-approval');
    const draft = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'application', {
      ...MANUAL,
      exitTypeCode: 'voluntary',
    });
    const submitted = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const approved = await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect(approved.status).toBe('approved');
    expect(await x.activeRows(x.employee.id)).toEqual([]);
    expect(await x.runScheduler('2026-10-11T01:00:00Z')).toMatchObject({ activated: [draft.id] });
    expect(await x.activeRows(x.employee.id)).toEqual([
      expect.objectContaining({ source: 'manual', blacklistDate: FUTURE_EFFECTIVE_DATE, exitRequestId: draft.id }),
    ]);
  });

  it('批量离职逐条生效：勾选的写一行，未勾选的不写', async () => {
    const x = await world('batch-effective');
    const other = (await x.colleague('批量未勾选')).id;
    const items = await Promise.all(
      [x.employee.id, other].map(async (employeeId, index) => ({
        employeeId,
        revision: (await x.session.getEmployee(employeeId)).revision,
        lastWorkDate: '2026-10-20',
        exit: { exitTypeCode: 'voluntary', ...(index === 0 ? MANUAL : {}) },
      })),
    );
    const response = await x.session.request('POST', '/exits/batch', { body: { items } });
    expect(response.status, await response.clone().text()).toBe(201);
    const { items: created } = (await response.json()) as { items: { id: string; revision: number }[] };
    for (const draft of created) await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect(await x.runScheduler('2026-10-22T01:00:00Z')).toMatchObject({
      activated: expect.arrayContaining([created[0]!.id]),
    });
    expect(await x.activeRows(x.employee.id)).toHaveLength(1);
    expect(await x.rows(other)).toEqual([]);
  });
});

describe('自动加黑：总开关 + 规则（DM-R3、AC-DM-06）', () => {
  it('AC-DM-06 端到端：开总开关 → 建规则（离职次数 ≥1 永久）→ 经公开入口发起离职并生效 → 名单出现 auto_rule → 再入职保存被拦截', async () => {
    const x = await world('auto-e2e');
    await x.setAutoSwitch(true);
    const rule = await x.addRule([x.from.id], { reason: 'major_violation', note: '规则说明' });
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(leave.status).toBe('effective');
    expect(await x.activeRows(x.employee.id)).toEqual([
      expect.objectContaining({
        source: 'auto_rule',
        reason: 'major_violation',
        blacklistDate: TODAY,
        expiryDate: null,
        exitRequestId: leave.id,
        note: '规则说明',
      }),
    ]);
    const list = (await x.page.list()).items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'auto_rule', employeeId: x.employee.id });
    const blocked = await x.rehire(x.employee.id);
    expect(await x.reasonOf(blocked)).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'EMPLOYEE_BLACKLISTED',
      message: expect.stringContaining('此人员已被列入黑名单'),
    });
    expect(rule.id).toBeTruthy();
  });

  it('总开关关闭时命中规则也不写；手动勾选不受开关影响', async () => {
    const x = await world('auto-off');
    await x.addRule([x.from.id]);
    const other = (await x.colleague('手动不受开关影响')).id;
    const auto = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(auto.status).toBe('effective');
    expect(await x.rows(x.employee.id)).toEqual([]);
    const manual = await x.createdExit(other, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    expect(manual.status).toBe('effective');
    expect(await x.activeRows(other)).toEqual([expect.objectContaining({ source: 'manual' })]);
  });

  it('命中多条规则取优先级数字最小者；离职当月 = 生效日所在自然月月底', async () => {
    const x = await world('auto-priority');
    await x.setAutoSwitch(true);
    await x.addRule([x.from.id], { name: '优先级大', priority: 20, reason: 'other', term: 'permanent' });
    await x.addRule([x.from.id], { name: '优先级小', priority: 2, reason: 'resignation', term: 'exit_month' });
    await x.addRule([x.from.id], {
      name: '次数不够',
      priority: 1,
      reason: 'integrity',
      conditions: [{ field: 'exitCount', operator: 'gte', value: 2 }],
    });
    await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(await x.activeRows(x.employee.id)).toEqual([
      expect.objectContaining({ source: 'auto_rule', reason: 'resignation', expiryDate: '2026-10-31' }),
    ]);
  });

  it('适用组织含下级：员工在子部门，规则只配上级部门也命中', async () => {
    const x = await world('auto-child');
    await x.setAutoSwitch(true);
    const child = await x.session.org('规则子部门', {
      establishedOn: '2026-01-01',
      parents: { admin: { parentId: x.from.id } },
    });
    const person = await x.session.employee('子部门员工');
    await x.session.business(
      person.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: child.id } },
      person.revision,
    );
    await x.addRule([x.from.id]);
    await x.createdExit(person.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(await x.activeRows(person.id)).toEqual([expect.objectContaining({ source: 'auto_rule' })]);
  });

  it('规则适用组织不含员工部门 / 离职次数不够：不写', async () => {
    const x = await world('auto-miss');
    await x.setAutoSwitch(true);
    await x.addRule([x.to.id]);
    await x.addRule([x.from.id], {
      conditions: [{ field: 'exitCount', operator: 'gte', value: 2 }],
      priority: 3,
    });
    await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(await x.rows(x.employee.id)).toEqual([]);
  });

  it('手动勾选优先：不再叠加自动匹配，名单只有一行 manual', async () => {
    const x = await world('manual-first');
    await x.setAutoSwitch(true);
    await x.addRule([x.from.id], { reason: 'other' });
    await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    expect(await x.rows(x.employee.id)).toEqual([expect.objectContaining({ source: 'manual', reason: 'integrity' })]);
  });
});

describe('名单已有有效记录 / 其他错误 / 幂等', () => {
  it('本人已在有效名单：跳过并在审计留痕，离职照常生效，名单仍是原来的一行', async () => {
    const x = await world('duplicate');
    const existing = await x.page.added({ employeeId: x.employee.id, reason: 'resignation' });
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    expect(leave.status).toBe('effective');
    expect(await x.rows(x.employee.id)).toEqual([expect.objectContaining({ id: existing.id, source: 'manual' })]);
    expect((await x.rows(x.employee.id))[0]!.exitRequestId).toBeNull();
    const audits = await x.auditActions(leave.id, 'exit.blacklist.skipped');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ reason: 'BLACKLIST_DUPLICATE', blacklistId: existing.id });
  });

  it('自动规则命中但本人已在有效名单：同样跳过并留痕', async () => {
    const x = await world('duplicate-auto');
    await x.setAutoSwitch(true);
    await x.addRule([x.from.id]);
    const existing = await x.page.added({ employeeId: x.employee.id, reason: 'resignation' });
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    expect(leave.status).toBe('effective');
    expect((await x.rows(x.employee.id)).map((row) => row.id)).toEqual([existing.id]);
    expect(await x.auditActions(leave.id, 'exit.blacklist.skipped')).toHaveLength(1);
  });

  it('其他错误照常回滚整笔生效：延期顺延使生效日越过有效截止日期 → 生效失败、无名单行、离职仍待生效', async () => {
    const x = await world('rollback');
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, { ...MANUAL, blacklistExpiryDate: '2026-10-12' });
    const result = await x.activate(leave.id, '2026-10-20');
    expect(result).toMatchObject({ outcome: 'failed', reason: 'RULE_REJECTED' });
    expect(await x.rows(x.employee.id)).toEqual([]);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect((await x.attempts(leave.id)).map((row) => row.outcome)).toEqual(['failed']);
  });

  it('重复落地同一笔离职被拒绝，名单仍是一行（同一笔离职最多写一行）', async () => {
    const x = await world('idempotent');
    const leave = await x.directLeave(FUTURE_LAST_WORK_DATE, MANUAL);
    await x.activate(leave.id, FUTURE_EFFECTIVE_DATE);
    await expect(x.activate(leave.id, FUTURE_EFFECTIVE_DATE)).rejects.toMatchObject({
      details: { reason: 'NOT_PENDING' },
    });
    expect(await x.rows(x.employee.id)).toHaveLength(1);
  });

  it('同一笔离职的名单历史只有一行：生效写入、经公开接口移出后，再以同一离职 ID 写名单被拒绝，历史总行数仍为 1（索引 employment_blacklist_exit_request）', async () => {
    const x = await world('exit-history-unique');
    const leave = await x.createdExit(x.employee.id, DUE_LAST_WORK_DATE, 'direct', MANUAL);
    expect(leave.status).toBe('effective');
    const [written] = await x.page.list().then((page) => page.items);
    expect(written).toBeDefined();
    const removed = await x.page.remove([{ id: written!.id, revision: written!.revision }]);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await x.activeRows(x.employee.id)).toEqual([]);
    // 移出后本人不在有效名单，名单页查重帮不上忙：只有按离职 ID 的历史唯一能拦住第二次写入
    const again = withTenant(x.db, x.tenantId, (tx) =>
      addBlacklistEntry(
        tx,
        {
          tenantId: x.tenantId,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: new Date(`${TODAY}T02:00:00Z`),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        { employeeId: x.employee.id, reason: 'integrity' },
        { source: 'manual', blacklistDate: TODAY, exitRequestId: leave.id },
      ),
    );
    await expect(again).rejects.toSatisfy((error: unknown) => pgErrorCode(error) === '23505');
    const history = await x.rows(x.employee.id);
    expect(history.filter((row) => row.exitRequestId === leave.id)).toHaveLength(1);
    expect(history).toHaveLength(1);
  });
});
