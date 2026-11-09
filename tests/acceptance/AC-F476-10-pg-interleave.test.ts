/**
 * AC-F476-10（真 PostgreSQL，普通角色）：办理与并发写交错时只出现整笔 A 或整笔 B / 409。
 * 做法：测试会话先持实例行锁当闸门，两个请求都进来排队后放行，由数据库决定先后；
 * 断言不依赖先后，只核对不变量——办理份数量 = 办理成功数，办理份内容 = 办理那一刻的业务值，没有半截状态。
 * PGlite 单连接无法并发，本文件仅在设了 TEST_DATABASE_URL 时运行。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { APPROVAL, NAME_A, NAME_C, copiesOf } from './AC-F476-support.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const EDITABLE = ['subject', 'orgItems.name'];

async function scene(label: string, over: Parameters<typeof oaNodes>[0] = []) {
  const w = await flowWorld(testDb().db, label, {
    nodes: oaNodes([{ editableFields: EDITABLE, ...over[0] }, ...over.slice(1)]),
  });
  const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
  await w.submitted(id);
  const view = await w.instance(id);
  return {
    w,
    id,
    itemId,
    instanceId: view.id,
    revision: view.revision,
    task: view.tasks.find((t) => t.status === 'pending')!,
  };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** 持实例行锁当闸门：fire 里发出的请求都排在它后面，放行后交给数据库决定先后。 */
async function raced(f: Scene, fire: () => Promise<Response>[]) {
  let responses: Promise<Response>[] = [];
  await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT id FROM approval_instances
      WHERE tenant_id = ${f.w.tenant.id} AND id = ${f.instanceId}::uuid FOR UPDATE`);
    responses = fire();
    await waitForBlocked(f.w.db, responses.length);
  });
  return Promise.all(responses);
}

const statuses = (rs: Response[]) => rs.map((r) => r.status);
const OK_OR_CONFLICT = [200, 403, 409];

describe.runIf(realPostgres)('AC-F476-10 办理与并发写的交错', () => {
  it('同一待办上“编辑”与“同意”同时到达：恰一方成功，办理份数 = 同意成功数，内容 = 办理那一刻的值', async () => {
    const f = await scene('f476-10-edit-vs-approve');
    const edit = () =>
      f.w.call(
        'POST',
        `${APPROVAL}/tasks/${f.task.id}/edit`,
        { ifMatch: f.revision, body: { fields: { 'orgItems.name': [{ itemId: f.itemId, value: NAME_C }] } } },
        f.w.hrbp.userId,
      );
    const approve = () =>
      f.w.call(
        'POST',
        `${APPROVAL}/tasks/${f.task.id}/approve`,
        { ifMatch: f.revision, body: { comment: '合成意见' } },
        f.w.hrbp.userId,
      );
    const [edited, approved] = await raced(f, () => [edit(), approve()]);
    expect(statuses([edited!, approved!]).filter((s) => s === 200)).toHaveLength(1);
    expect(statuses([edited!, approved!]).every((s) => OK_OR_CONFLICT.includes(s))).toBe(true);
    const copies = await copiesOf(f.w, f.instanceId);
    expect(copies).toHaveLength(approved!.status === 200 ? 1 : 0);
    if (approved!.status === 200) expect(copies[0]!.text).toContain(NAME_A);
    // 业务值与编辑结果一致：编辑成功才是 C
    const view = await f.w.detail(f.instanceId, f.w.hrbp.userId);
    const names = (view.form.values['orgItems.name'] as { value: unknown }[]).map((e) => e.value);
    expect(names).toEqual([edited!.status === 200 ? NAME_C : NAME_A]);
  });

  it('编辑并同意与另一个“编辑”交错：办理份内容是办理事务看到的候选值，且只有一份或没有', async () => {
    const f = await scene('f476-10-edit-approve');
    const mix = (value: string) =>
      f.w.call(
        'POST',
        `${APPROVAL}/tasks/${f.task.id}/approve`,
        {
          ifMatch: f.revision,
          body: { comment: '合成意见', fields: { 'orgItems.name': [{ itemId: f.itemId, value }] } },
        },
        f.w.hrbp.userId,
      );
    const edit = () =>
      f.w.call(
        'POST',
        `${APPROVAL}/tasks/${f.task.id}/edit`,
        { ifMatch: f.revision, body: { fields: { 'orgItems.name': [{ itemId: f.itemId, value: NAME_C }] } } },
        f.w.hrbp.userId,
      );
    const [approved, edited] = await raced(f, () => [mix('ZZ_编辑并同意值'), edit()]);
    expect(statuses([approved!, edited!]).filter((s) => s === 200)).toHaveLength(1);
    const copies = await copiesOf(f.w, f.instanceId);
    expect(copies).toHaveLength(approved!.status === 200 ? 1 : 0);
    if (approved!.status === 200) expect(copies[0]!.text).toContain('ZZ_编辑并同意值');
  });

  it('申请人撤回与审批人同意交错：办理份数 = 同意成功数；撤回成功则实例已撤回，不出现“已撤回却有半份”', async () => {
    const f = await scene('f476-10-withdraw-vs-approve');
    const approve = () =>
      f.w.call(
        'POST',
        `${APPROVAL}/tasks/${f.task.id}/approve`,
        { ifMatch: f.revision, body: { comment: '合成意见' } },
        f.w.hrbp.userId,
      );
    const withdraw = () =>
      f.w.call('POST', `${APPROVAL}/instances/${f.instanceId}/withdraw`, { ifMatch: f.revision, body: {} }, f.w.hr.id);
    const [approved, withdrawn] = await raced(f, () => [approve(), withdraw()]);
    expect(statuses([approved!, withdrawn!]).every((s) => OK_OR_CONFLICT.includes(s))).toBe(true);
    expect(statuses([approved!, withdrawn!]).filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(await copiesOf(f.w, f.instanceId)).toHaveLength(approved!.status === 200 ? 1 : 0);
    const [row] = await withTenant(f.w.db, f.w.tenant.id, async (tx) =>
      resultRows<{ status: string; pending: number }>(
        await tx.execute(sql`SELECT status, (SELECT count(*) FROM approval_tasks WHERE instance_id = i.id
          AND status = 'pending')::int AS pending FROM approval_instances i WHERE i.id = ${f.instanceId}::uuid`),
      ),
    );
    if (withdrawn!.status === 200) expect(row).toEqual({ status: 'withdrawn', pending: 0 });
  });

  it('管理员转交（接管）与原审批人同意交错：转交成功则没有原人的份，同意成功则转交 409，二者不同时成功', async () => {
    const f = await scene('f476-10-takeover-vs-approve');
    const taker = await f.w.person('接管人', f.w.subject);
    const admin = await f.w.person('流程管理员', f.w.subject);
    const approve = () =>
      f.w.call(
        'POST',
        `${APPROVAL}/tasks/${f.task.id}/approve`,
        { ifMatch: f.revision, body: { comment: '合成意见' } },
        f.w.hrbp.userId,
      );
    const takeover = () =>
      f.w.call(
        'POST',
        `${APPROVAL}/instances/${f.instanceId}/admin-transfer`,
        { ifMatch: f.revision, body: { taskId: f.task.id, toUserId: taker.userId, reason: '合成原因' } },
        admin.userId,
      );
    const [approved, moved] = await raced(f, () => [approve(), takeover()]);
    expect(statuses([approved!, moved!]).filter((s) => s === 200)).toHaveLength(1);
    const copies = await copiesOf(f.w, f.instanceId);
    expect(copies).toHaveLength(approved!.status === 200 ? 1 : 0);
    if (moved!.status === 200) expect(copies.filter((c) => c.actor_user_id === f.w.hrbp.userId)).toHaveLength(0);
  });
});
