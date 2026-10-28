/**
 * F-283（后补-权限，#458 FE-R2d3 R1，DEC-654 批 3）：GET interns 逐行下发 availableActions。
 * 动作码：regularize = POST interns/:id/regularize、terminate = POST interns/:id/terminate、
 * withdraw / revoke = POST businesses/:id/{withdraw|revoke}（实习转正申请单，行 id 即申请单 id）；顺序固定
 * regularize → terminate → withdraw → revoke。下发 = 视图归属 ∩ 单据状态 ∩ 对象操作权 ∩ 按钮 ∩ 字段写权 ∩ 写入口径范围。
 * 一致性：下发的动作调用写入口不因权限 / 状态被拒；未下发的被拒（403 / 404 / 409）。
 */
import { EXIT_BUTTONS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyAction, denyButton, denyFieldWrite, restricted, type Restriction } from './AC-PT-http-support.js';
import { internWorld, type InternViewItem, type InternWorld } from './AC-IN-BE6a-support.js';
import { orgScope } from './support/revocable-rights.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';
type Action = 'regularize' | 'terminate' | 'withdraw' | 'revoke';
const ACTIONS: readonly Action[] = ['regularize', 'terminate', 'withdraw', 'revoke'];
type Row = InternViewItem & { availableActions?: Action[] };

/** 按给定限制发请求（同一租户 / 用户换授权器）。 */
function sender(w: InternWorld, restriction: Restriction = {}) {
  const api = tenantApi(w.db, { authorize: restricted(restriction), clock: () => new Date(`${TODAY}T01:00:00.000Z`) });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  return (method: string, path: string, options: { body?: object; ifMatch?: number } = {}) =>
    api.request(method, `/api/tenant/employment${path}`, { ...as, ...options });
}
type Send = ReturnType<typeof sender>;

async function rows(send: Send, view: string): Promise<Row[]> {
  const response = await send('GET', `/interns?view=${view}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: Row[] }).items;
}
async function rowOf(send: Send, view: string, name: string): Promise<Row | undefined> {
  return (await rows(send, view)).find((row) => row.name === name);
}
async function actionsOf(send: Send, view: string, name: string): Promise<Action[]> {
  const row = await rowOf(send, view, name);
  expect(row, `${view} 视图里找不到 ${name}`).toBeDefined();
  expect(row!.availableActions, '行必须带 availableActions').toBeDefined();
  return row!.availableActions!;
}

describe('F-283：视图 × 状态（全权）', () => {
  it('实习中：转正 + 结束；实习转正中（审批中）：另有撤回 / 撤销；审批通过未生效：只有转正 + 结束；已转正 / 已离职：空', async () => {
    const w = await internWorld(testDb().db, 'f283-states');
    const full = sender(w);
    const interning = await w.hire('F283实习中', 'intern');
    const reviewing = await w.hire('F283转正审批中', 'intern');
    const approved = await w.hire('F283转正已通过', 'intern');
    const direct = await w.hire('F283已转正', 'intern');
    const left = await w.hire('F283已离职', 'intern');
    await w.applyRegularization(reviewing.employee.id);
    await w.approve(await w.applyRegularization(approved.employee.id, '2026-10-25'));
    await w.regularizeOk(direct.employee.id, '2026-09-20', w.other.id);
    await w.leave(left.employee.id);

    expect(await actionsOf(full, 'interning', interning.name)).toEqual(['regularize', 'terminate']);
    expect(await actionsOf(full, 'interning', reviewing.name)).toEqual(['regularize', 'terminate']);
    expect(await actionsOf(full, 'converting', reviewing.name)).toEqual([
      'regularize',
      'terminate',
      'withdraw',
      'revoke',
    ]);
    expect(await actionsOf(full, 'converting', approved.name)).toEqual(['regularize', 'terminate']);
    expect(await actionsOf(full, 'converted', direct.name)).toEqual([]);
    expect(await actionsOf(full, 'left', left.name)).toEqual([]);
  });
});

describe('F-283：每个动作的负例（有视图 / 状态但无权 → 不下发）', () => {
  it('按钮：缺 Employment.Create 无转正；缺直接离职按钮无结束；缺 Withdraw / Revoke 各缺各的', async () => {
    const w = await internWorld(testDb().db, 'f283-buttons');
    const person = await w.hire('F283按钮', 'intern');
    await w.applyRegularization(person.employee.id);
    const as = (code: string) => sender(w, { deny: denyButton(code) });
    const seen = (code: string) => actionsOf(as(code), 'converting', person.name);
    expect(await seen('Employment.Create')).toEqual(['terminate', 'withdraw', 'revoke']);
    expect(await seen(EXIT_BUTTONS.direct)).toEqual(['regularize', 'withdraw', 'revoke']);
    expect(await seen('Employment.Withdraw')).toEqual(['regularize', 'terminate', 'revoke']);
    expect(await seen('Employment.Revoke')).toEqual(['regularize', 'terminate', 'withdraw']);
  });

  it('对象操作：无新增权无转正 / 结束；无更新权无撤回 / 撤销', async () => {
    const w = await internWorld(testDb().db, 'f283-operations');
    const person = await w.hire('F283对象操作', 'intern');
    await w.applyRegularization(person.employee.id);
    const noCreate = sender(w, { deny: denyAction('object.create') });
    const noUpdate = sender(w, { deny: denyAction('object.update') });
    expect(await actionsOf(noCreate, 'converting', person.name)).toEqual(['withdraw', 'revoke']);
    expect(await actionsOf(noUpdate, 'converting', person.name)).toEqual(['regularize', 'terminate']);
  });

  it('字段写权：转正必填的部门 / 转正日期无写权则不下发转正（结束实习不受影响）', async () => {
    const w = await internWorld(testDb().db, 'f283-fields');
    const person = await w.hire('F283字段', 'intern');
    for (const field of ['departmentId', 'effectiveDate'])
      expect(await actionsOf(sender(w, { deny: denyFieldWrite(field) }), 'interning', person.name), field).toEqual([
        'terminate',
      ]);
  });

  it('状态字段不可见时不下发撤回 / 撤销（不用动作集合泄露单据状态）', async () => {
    const w = await internWorld(testDb().db, 'f283-hidden-status');
    const person = await w.hire('F283状态隐藏', 'intern');
    await w.applyRegularization(person.employee.id);
    const send = sender(w, { fields: ['id', 'revision', 'employeeId', 'departmentId', 'effectiveDate', 'kind'] });
    const visible = (await rows(send, 'converting')).find((item) => item.employeeId === person.employee.id);
    expect(visible?.state).toBeUndefined();
    expect(visible?.availableActions ?? []).not.toContain('withdraw');
    expect(visible?.availableActions ?? []).not.toContain('revoke');
  });

  it('列表不越权披露：范围外的行不出现，也就没有动作', async () => {
    const w = await internWorld(testDb().db, 'f283-scope');
    const person = await w.hire('F283范围', 'intern');
    const outside = sender(w, { scope: orgScope(w.session.tenant.id, TODAY, w.other.id) });
    expect(await rowOf(outside, 'interning', person.name)).toBeUndefined();
    const inside = sender(w, { scope: orgScope(w.session.tenant.id, TODAY, w.org.id) });
    expect(await actionsOf(inside, 'interning', person.name)).toEqual(['regularize', 'terminate']);
  });
});

describe('F-283：一致性——下发的写入口不因权限 / 状态被拒，未下发的被拒', () => {
  const REFUSED = [403, 404, 409];
  const variants: [string, Restriction][] = [
    ['全权', {}],
    ['缺转正按钮', { deny: denyButton('Employment.Create') }],
    ['缺直接离职按钮', { deny: denyButton(EXIT_BUTTONS.direct) }],
    ['缺撤回按钮', { deny: denyButton('Employment.Withdraw') }],
    ['缺撤销按钮', { deny: denyButton('Employment.Revoke') }],
    ['缺新增权', { deny: denyAction('object.create') }],
    ['缺更新权', { deny: denyAction('object.update') }],
    ['缺部门字段写权', { deny: denyFieldWrite('departmentId') }],
  ];

  /** 调写入口（每次都是一份新造的实习转正审批中的人，互不影响）。 */
  async function write(w: InternWorld, send: Send, action: Action, row: Row) {
    const employeeId = row.employeeId as string;
    switch (action) {
      case 'regularize':
        return send('POST', `/interns/${employeeId}/regularize`, {
          ifMatch: await w.revision(employeeId),
          body: { effectiveDate: '2026-10-05', departmentId: w.other.id, probation: false },
        });
      case 'terminate':
        return send('POST', `/interns/${employeeId}/terminate`, {
          ifMatch: await w.revision(employeeId),
          body: { endDate: '2026-10-05', confirmed: true },
        });
      case 'withdraw':
      case 'revoke':
        return send('POST', `/businesses/${row.id}/${action}`, { ifMatch: row.revision as number });
    }
  }

  it.each(variants)(
    '审批中的实习转正 × %s',
    async (name, restriction) => {
      const w = await internWorld(testDb().db, `f283-consistency-${name}`);
      const send = sender(w, restriction);
      for (const action of ACTIONS) {
        const person = await w.hire(`F283一致-${action}`, 'intern');
        await w.applyRegularization(person.employee.id);
        const row = await rowOf(send, 'converting', person.name);
        // 没有读权的变体不会出现（本组限制都不影响读）；行缺失即用例设计错误
        expect(row, `${name} / ${action}：converting 行缺失`).toBeDefined();
        const response = await write(w, send, action, row!);
        const label = `${name} / ${action}`;
        if (row!.availableActions?.includes(action)) expect(response.status, `${label} 已下发却被拒`).toBeLessThan(300);
        else expect(REFUSED, `${label} 未下发却被接受`).toContain(response.status);
      }
    },
    180_000,
  );

  it('审批通过未生效的转正：撤回 / 撤销未下发，写入口也拒绝（409）', async () => {
    const w = await internWorld(testDb().db, 'f283-consistency-approved');
    const person = await w.hire('F283一致-已通过', 'intern');
    const businessId = await w.applyRegularization(person.employee.id, '2026-10-25');
    await w.approve(businessId);
    const send = sender(w);
    const row = (await rowOf(send, 'converting', person.name))!;
    expect(row.availableActions).not.toContain('withdraw');
    for (const action of ['withdraw', 'revoke'] as const)
      expect((await write(w, send, action, row)).status, action).toBe(409);
  });
});
