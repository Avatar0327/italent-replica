/**
 * F-268（后补-权限，#446 FE-R2d2b D2B-01，DEC-654 批 3）：GET part-time-requests/:id 逐单下发 availableActions。
 * 动作码与写入口一致：edit = PATCH、submit / withdraw / revoke = POST :id/{动作}、delete = DELETE；顺序固定
 * edit → submit → delete → withdraw → revoke。下发 = 状态机 ∩ 对象操作权 ∩ 按钮 ∩ 写入口径范围 ∩（提交 / 撤回）原发起人。
 * 一致性：下发的动作调用写入口不因权限 / 状态被拒；未下发的被拒（403 / 404 / 409）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyAction, denyButton, restricted } from './AC-PT-http-support.js';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const TODAY = '2026-10-01';
const world = (label: string) => requestWorld(database().db, `f268-${label}`);

type Action = 'edit' | 'submit' | 'delete' | 'withdraw' | 'revoke';
const ACTIONS: readonly Action[] = ['edit', 'submit', 'delete', 'withdraw', 'revoke'];

async function draft(w: RequestWorld, patch: Record<string, unknown> = {}) {
  return w.ok(await w.http().create({ endDate: '2026-12-31', ...patch }), 201);
}
async function reviewing(w: RequestWorld) {
  const created = await draft(w);
  return w.ok(await w.http().act(created.id, 'submit', created.revision));
}

/** 读详情里的 availableActions（键必须存在）。 */
async function offered(w: RequestWorld, id: string, send?: ReturnType<RequestWorld['sendWith']>): Promise<Action[]> {
  const body = await w.ok<{ availableActions?: Action[] }>(await w.http(send).one(id));
  expect(body.availableActions, '详情必须带 availableActions').toBeDefined();
  return body.availableActions!;
}

const noButton = (code: string) => restricted({ deny: denyButton(code) });

describe('F-268：状态机 × 角色（HR 发起人，全权）', () => {
  it('草稿 / 驳回中：改、提交、删除、撤销；审批中：撤回、撤销；终态与已删除：空', async () => {
    const w = await world('states');
    const a = await draft(w);
    expect(await offered(w, a.id)).toEqual(['edit', 'submit', 'delete', 'revoke']);

    const b = await reviewing(w);
    expect(await offered(w, b.id)).toEqual(['withdraw', 'revoke']);

    await w.decide(b.id, w.approvers.pHrbp, 'reject');
    expect((await w.load(b.id)).state).toBe('rejected');
    expect(await offered(w, b.id)).toEqual(['edit', 'submit', 'delete', 'revoke']);

    const voided = await w.ok(await w.http().act(a.id, 'revoke', a.revision));
    expect(voided.status).toBe('voided');
    expect(await offered(w, a.id)).toEqual([]);

    const c = await draft(w, { startDate: '2026-09-02' });
    await w.ok(await w.http().remove(c.id, c.revision));
    expect(await offered(w, c.id)).toEqual([]);
  });

  it('延长 / 结束申请按各自的申请类型按钮判定', async () => {
    const w = await world('date-kinds');
    const record = await w.seedRecord();
    const extend = await w.ok(
      await w.http().createDate({ requestType: 'extend', recordId: record, endDate: '2026-12-31' }),
      201,
    );
    expect(await offered(w, extend.id)).toEqual(['edit', 'submit', 'delete', 'revoke']);
    // 缺“延长”按钮：编辑 / 提交 / 删除 / 撤回都不下发，撤销只要 Employment.Revoke
    const denied = w.sendWith(restricted({ deny: denyButton('Employment.PartTimeExtend') }));
    expect(await offered(w, extend.id, denied)).toEqual(['revoke']);
    // 缺“新增兼职申请”按钮不影响延长申请
    const addDenied = w.sendWith(restricted({ deny: denyButton('Employment.PartTimeApproval') }));
    expect(await offered(w, extend.id, addDenied)).toEqual(['edit', 'submit', 'delete', 'revoke']);
  });
});

describe('F-268：每个动作的负例（有状态但无权 → 不下发）', () => {
  it('按钮：缺 Submit 无提交；缺 Delete 无删除；缺 Revoke 无撤销；缺申请类型按钮无改 / 提交 / 删除 / 撤回', async () => {
    const w = await world('buttons');
    const d = await draft(w);
    const r = await reviewing(w);
    const as = (code: string) => w.sendWith(noButton(code));
    expect(await offered(w, d.id, as('Employment.Submit'))).toEqual(['edit', 'delete', 'revoke']);
    expect(await offered(w, d.id, as('Employment.Delete'))).toEqual(['edit', 'submit', 'revoke']);
    expect(await offered(w, d.id, as('Employment.Revoke'))).toEqual(['edit', 'submit', 'delete']);
    expect(await offered(w, d.id, as('Employment.PartTimeApproval'))).toEqual(['revoke']);
    expect(await offered(w, r.id, as('Employment.Withdraw'))).toEqual(['revoke']);
    expect(await offered(w, r.id, as('Employment.Revoke'))).toEqual(['withdraw']);
    expect(await offered(w, r.id, as('Employment.PartTimeApproval'))).toEqual(['revoke']);
  });

  it('对象操作权：无更新权只剩删除；无删除权无删除', async () => {
    const w = await world('operations');
    const d = await draft(w);
    const r = await reviewing(w);
    const noUpdate = w.sendWith(restricted({ deny: denyAction('object.update') }));
    const noDelete = w.sendWith(restricted({ deny: denyAction('object.delete') }));
    expect(await offered(w, d.id, noUpdate)).toEqual(['delete']);
    expect(await offered(w, r.id, noUpdate)).toEqual([]);
    expect(await offered(w, d.id, noDelete)).toEqual(['edit', 'submit', 'revoke']);
  });

  it('提交 / 撤回只给原发起人；改 / 删除 / 撤销不限发起人（与写入口一致）', async () => {
    const w = await world('initiator');
    const other = w.sendWith(() => true, await w.member('另一位HR'));
    const d = await draft(w);
    const r = await reviewing(w);
    expect(await offered(w, d.id, other)).toEqual(['edit', 'delete', 'revoke']);
    expect(await offered(w, r.id, other)).toEqual(['revoke']);
    expect(await offered(w, r.id)).toEqual(['withdraw', 'revoke']);
  });

  it('写入口径范围：只管主职部门时详情可读，但不下发任何写动作；主职 + 兼职部门都管才下发', async () => {
    const w = await world('scope');
    const d = await draft(w);
    const scoped = (...orgs: string[]) => w.sendWith(restricted({ scope: orgScope(w.tenant.id, TODAY, ...orgs) }));
    expect(await offered(w, d.id, scoped(w.primary))).toEqual([]);
    expect(await offered(w, d.id, scoped(w.side))).toEqual([]);
    expect(await offered(w, d.id, scoped(w.primary, w.side))).toEqual(['edit', 'submit', 'delete', 'revoke']);
  });

  it('状态字段不可见时不下发（不用动作集合泄露状态）', async () => {
    const w = await world('hidden-status');
    const d = await draft(w);
    const send = w.sendWith(restricted({ fields: ['id', 'revision', 'employeeId', 'effectiveDate'] }));
    const body = await w.ok<{ status?: string; availableActions?: string[] }>(await w.http(send).one(d.id));
    expect(body.status).toBeUndefined();
    expect(body.availableActions ?? []).toEqual([]);
  });
});

describe('F-268：一致性——下发的写入口不因权限 / 状态被拒，未下发的被拒', () => {
  type Variant = { name: string; send: () => Promise<ReturnType<RequestWorld['sendWith']>> };
  const REFUSED = [403, 404, 409];

  /** 对一个样本（每个动作各造一份新单，互不影响）核对：下发 ⇔ 写入口接受。 */
  async function check(w: RequestWorld, state: 'draft' | 'in_review', variant: Variant) {
    const send = await variant.send();
    for (const action of ACTIONS) {
      const startDate = nextStart();
      const created = state === 'draft' ? await draft(w, { startDate }) : await reviewingAt(w, startDate);
      const mine = await offered(w, created.id, send);
      const api = w.http(send);
      const response =
        action === 'edit'
          ? await api.patch(created.id, created.revision, { endDate: '2026-11-30' })
          : action === 'delete'
            ? await api.remove(created.id, created.revision)
            : await api.act(created.id, action, created.revision);
      const label = `${state} / ${variant.name} / ${action}`;
      if (mine.includes(action)) expect(response.status, `${label} 已下发却被拒`).toBe(200);
      else expect(REFUSED, `${label} 未下发却被接受`).toContain(response.status);
    }
  }
  // 同员工同期不能有重复兼职（D-5 等）：每份新单用不同的开始日，互不冲突
  let day = 1;
  const nextStart = () => `2026-09-${String(++day).padStart(2, '0')}`;
  async function reviewingAt(w: RequestWorld, startDate: string) {
    const created = await draft(w, { startDate });
    return w.ok(await w.http().act(created.id, 'submit', created.revision));
  }

  it.each(['draft', 'in_review'] as const)(
    '%s 样本 × 多种操作人',
    async (state) => {
      const w = await world(`consistency-${state}`);
      day = 1;
      const other = await w.member('另一位HR');
      const variants: Variant[] = [
        { name: '全权发起人', send: async () => w.sendWith(() => true) },
        { name: '非发起人', send: async () => w.sendWith(() => true, other) },
        { name: '缺申请按钮', send: async () => w.sendWith(noButton('Employment.PartTimeApproval')) },
        { name: '缺更新权', send: async () => w.sendWith(restricted({ deny: denyAction('object.update') })) },
        {
          name: '范围外',
          send: async () => w.sendWith(restricted({ scope: orgScope(w.tenant.id, TODAY, w.primary) })),
        },
      ];
      for (const variant of variants) await check(w, state, variant);
    },
    180_000,
  );
});
