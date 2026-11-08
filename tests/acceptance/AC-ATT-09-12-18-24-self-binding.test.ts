/**
 * F-479 S2 / AC-ATT-09 ～ 12、18、24（设计 §2.1 ～ §2.4）：本人离职草稿绑定附件、移除分流、提交封存、
 * 重放不改写附件。全部走真实 HTTP（本人申请入口 + 审批入口），文件用运行时生成的合成位图。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld, type ExitWorld } from './AC-ATT-S2-support.js';

const database = useTestDb();
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: { index?: number } } }).error;

describe('AC-ATT-09 本人草稿绑定附件', () => {
  it('2 个本人临时附件：attachmentRefs 保序、attachments 2 条、文件 bound 且 expires_at 为空', async () => {
    const x = await exitWorld(database().db, 'att09');
    const me = await x.a.person('合成本人甲');
    const [first, second] = await x.uploads(me, 2);
    expect((await x.fileState(first!.id)).expires_at).not.toBeNull();
    const draft = await x.createDraft(me, [second!.id, first!.id]);
    expect(draft.attachmentRefs).toEqual([second!.id, first!.id]);
    expect(draft.attachments?.map((item) => item.id)).toEqual([second!.id, first!.id]);
    expect(draft.attachments![0]).toMatchObject({ filename: '手写2.png', contentType: 'image/png' });
    expect(draft.attachments![0]).not.toHaveProperty('sha256');
    for (const file of [first!, second!]) {
      expect(await x.fileState(file.id)).toMatchObject({
        status: 'bound',
        expires_at: null,
        sealed_at: null,
        business_type: 'employment',
        business_id: draft.id,
      });
    }
    expect((await x.exitRow(draft.id)).attachment_refs).toEqual([second!.id, first!.id]);
    const actions = (await x.a.auditActions()).map((row) => row.action);
    expect(actions.filter((action) => action === 'attachment.file.bind')).toHaveLength(2);
    const events = (await x.a.outboxEvents()).map((row) => row.event_type);
    expect(events.filter((event) => event === 'attachment.file.bind')).toHaveLength(2);
  });

  it('暂存追加第三个：只绑定新增的，已有的不重复写', async () => {
    const x = await exitWorld(database().db, 'att09-add');
    const me = await x.a.person('合成本人甲');
    const [first, second, third] = await x.uploads(me, 3);
    const draft = await x.createDraft(me, [first!.id, second!.id]);
    const before = await x.counts();
    const saved = await x.w.json<{ revision: number; attachmentRefs: string[] }>(
      await x.patch(me, draft, { attachmentRefs: [first!.id, second!.id, third!.id] }),
    );
    expect(saved.attachmentRefs).toEqual([first!.id, second!.id, third!.id]);
    expect((await x.counts()).attachmentOutbox).toBe(before.attachmentOutbox + 1);
    expect((await x.fileState(third!.id)).status).toBe('bound');
  });
});

describe('AC-ATT-10 引用校验：不可用一律 400 且只回显下标', () => {
  async function expectInvalid(x: ExitWorld, me: Awaited<ReturnType<ExitWorld['a']['person']>>, refs: unknown[]) {
    const response = await x.createRaw(me, { attachmentRefs: refs });
    expect(response.status).toBe(400);
    return errorOf(response);
  }

  it('他人的、他租户的、随机 UUID、已绑别处的、重复的都是 ATTACHMENT_INVALID，响应不含任何文件元数据', async () => {
    const db = database().db;
    const x = await exitWorld(db, 'att10');
    const other = await exitWorld(db, 'att10-other');
    const me = await x.a.person('合成本人甲');
    const stranger = await x.a.person('合成他人乙');
    const foreign = await other.a.person('合成外租户丙');
    const [mine, used] = await x.uploads(me, 2);
    const [theirs] = await x.uploads(stranger, 1);
    const [abroad] = await other.uploads(foreign, 1);
    await x.bindElsewhere(used!.id);
    const cases: [string, unknown[], number][] = [
      ['他人', [theirs!.id], 0],
      ['他租户', [abroad!.id], 0],
      ['随机 UUID', [randomUUID()], 0],
      ['已绑别处', [used!.id], 0],
      ['重复', [mine!.id, mine!.id], 1],
    ];
    for (const [name, refs, index] of cases) {
      const error = await expectInvalid(x, me, refs);
      expect(error.code, name).toBe('ATTACHMENT_INVALID');
      expect(error.details, name).toEqual({ index });
      expect(JSON.stringify(error), name).not.toMatch(/手写|png|sha256/);
    }
    // 非 UUID 在入参校验层就是 400（不回显内容）
    const malformed = await x.createRaw(me, { attachmentRefs: ['not-a-uuid'] });
    expect(malformed.status).toBe(400);
    // 全部被拒后，本人的 mine 仍是未绑定的临时文件，别人的文件没有被动过
    expect((await x.fileState(mine!.id)).status).toBe('uploaded');
    expect((await x.fileState(theirs!.id)).status).toBe('uploaded');
  });

  it('6 个文件 → 400 ATTACHMENT_LIMIT 且一个都不绑', async () => {
    const x = await exitWorld(database().db, 'att10-limit');
    const me = await x.a.person('合成本人甲');
    const six = await x.uploads(me, 6);
    const error = await expectInvalid(
      x,
      me,
      six.map((file) => file.id),
    );
    expect(error.code).toBe('ATTACHMENT_LIMIT');
    for (const file of six) expect((await x.fileState(file.id)).status).toBe('uploaded');
    const five = await x.createDraft(
      me,
      six.slice(0, 5).map((file) => file.id),
    );
    expect(five.attachmentRefs).toHaveLength(5);
  });
});

describe('AC-ATT-11 从未提交的附件被移除 → 待清理且不可读', () => {
  it('保存时去掉附件：pending_cleanup，经临时入口与载体都 404', async () => {
    const x = await exitWorld(database().db, 'att11');
    const me = await x.a.person('合成本人甲');
    const [keep, drop] = await x.uploads(me, 2);
    const draft = await x.createDraft(me, [keep!.id, drop!.id]);
    const saved = await x.w.json<{ revision: number; attachmentRefs: string[] }>(
      await x.patch(me, draft, { attachmentRefs: [keep!.id] }),
    );
    expect(saved.attachmentRefs).toEqual([keep!.id]);
    expect(await x.fileState(drop!.id)).toMatchObject({ status: 'pending_cleanup', sealed_at: null });
    expect((await x.fileState(drop!.id)).cleanup_at).not.toBeNull();
    expect((await x.a.content(me, drop!.id)).status).toBe(404);
    expect((await x.download(me, draft.id, drop!.id)).status).toBe(404);
    expect((await x.download(me, draft.id, keep!.id)).status).toBe(200);
    expect((await x.a.auditActions()).map((row) => row.action)).toContain('attachment.file.unbind');
  });
});

describe('AC-ATT-12 提交封存；驳回后移除已封存的 → detached', () => {
  it('提交写 sealed_at；驳回后移除再提交为 detached，新一轮审批人表单不含它，任何载体都读不到', async () => {
    const x = await exitWorld(database().db, 'att12');
    const me = await x.a.person('合成本人甲');
    const [keep, drop] = await x.uploads(me, 2);
    const { draft, instance, task } = await x.submitted(me, [keep!.id, drop!.id]);
    for (const file of [keep!, drop!]) {
      const state = await x.fileState(file.id);
      expect(state.status).toBe('bound');
      expect(state.sealed_at).not.toBeNull();
    }
    expect((await x.a.auditActions()).filter((row) => row.action === 'attachment.file.seal')).toHaveLength(2);
    const rejected = await x.w.taskAction(x.approver.userId, task.id, 'reject', instance.revision, { comment: '补充' });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    const returned = await x.read(me, draft.id);
    expect(returned.status).toBe('rejected');
    const saved = await x.w.json<{ revision: number }>(await x.patch(me, returned, { attachmentRefs: [keep!.id] }));
    const dropped = await x.fileState(drop!.id);
    expect(dropped.status).toBe('detached');
    expect(dropped.sealed_at).not.toBeNull();
    expect((await x.fileState(keep!.id)).status).toBe('bound');
    const again = await x.w.json<{ status: string }>(await x.submit(me, { id: draft.id, revision: saved.revision }));
    expect(again.status).toBe('in_review');
    expect((await x.fileState(drop!.id)).status).toBe('detached');
    await x.grantFields(x.approver.userId, ['lastWorkDate', 'attachmentRefs']);
    const running = (await x.w.instanceOfAll(draft.id, me.userId)).find((item) => item.status === 'running')!;
    const view = await x.approvalDetail(x.approver, running.id);
    const body = await view.text();
    expect(view.status).toBe(200);
    const detail = JSON.parse(body) as {
      form: { values: { attachmentRefs: string[]; attachments: { id: string }[] } };
    };
    expect(detail.form.values.attachmentRefs).toEqual([keep!.id]);
    expect(detail.form.values.attachments.map((item) => item.id)).toEqual([keep!.id]);
    expect(body).not.toContain('手写2.png');
    // 任何载体、任何人都读不到 detached
    expect((await x.download(me, draft.id, drop!.id)).status).toBe(404);
    expect((await x.approvalDownload(x.approver, running.id, drop!.id)).status).toBe(404);
    expect((await x.a.content(me, drop!.id)).status).toBe(404);
    const hr = x.restrictedHr(() => true, ['id', 'attachmentRefs', 'lastWorkDate']);
    expect((await hr(`/exits/${draft.id}/attachments/${drop!.id}/content`)).status).toBe(404);
    expect((await hr(`/exits/${draft.id}/attachments/${keep!.id}/content`)).status).toBe(200);
  });
});

describe('AC-ATT-18 审批中的本人单不能改附件；撤回成草稿后按 §2.2', () => {
  it('in_review 的 PATCH 沿用既有拒绝，附件行不动；撤回后可再改', async () => {
    const x = await exitWorld(database().db, 'att18');
    const me = await x.a.person('合成本人甲');
    const [first, second] = await x.uploads(me, 2);
    const { draft, instance } = await x.submitted(me, [first!.id]);
    const before = await x.counts();
    const blocked = await x.patch(me, draft, { attachmentRefs: [first!.id, second!.id] });
    expect(blocked.status).toBe(409);
    expect(await x.counts()).toEqual(before);
    expect((await x.fileState(second!.id)).status).toBe('uploaded');
    const withdrawn = await x.w.instanceAction(me.userId, instance.id, 'withdraw', instance.revision, {});
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    const back = await x.read(me, draft.id);
    expect(back.status).toBe('draft');
    const saved = await x.w.json<{ attachmentRefs: string[] }>(
      await x.patch(me, back, { attachmentRefs: [first!.id, second!.id] }),
    );
    expect(saved.attachmentRefs).toEqual([first!.id, second!.id]);
    expect((await x.fileState(second!.id)).status).toBe('bound');
    // 撤回后移除已封存的 first → detached（不是 pending_cleanup）
    const next = await x.read(me, draft.id);
    await x.w.json(await x.patch(me, next, { attachmentRefs: [second!.id] }));
    expect((await x.fileState(first!.id)).status).toBe('detached');
  });
});

describe('AC-ATT-24 重放不改写附件，封存只发生在 execute', () => {
  it('撤回并追加附件 B 后用原 Idempotency-Key / If-Match / body 重放提交：回原回执，B 不封存，无新审计 / outbox，仍是草稿', async () => {
    const x = await exitWorld(database().db, 'att24');
    const me = await x.a.person('合成本人甲');
    const [a1, b1] = await x.uploads(me, 2);
    const draft = await x.createDraft(me, [a1!.id]);
    const key = randomUUID();
    const first = await x.w.json<{ id: string; status: string; revision: number }>(await x.submit(me, draft, key));
    expect(first.status).toBe('in_review');
    const { instance } = await x.instanceOf(first, me);
    expect((await x.w.instanceAction(me.userId, instance.id, 'withdraw', instance.revision, {})).status).toBe(200);
    const back = await x.read(me, draft.id);
    expect(back.status).toBe('draft');
    await x.w.json(await x.patch(me, back, { attachmentRefs: [a1!.id, b1!.id] }));
    const stateBefore = await x.fileState(b1!.id);
    const countsBefore = await x.counts();
    const businessBefore = await x.read(me, draft.id);
    const replay = await x.submit(me, draft, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: first.id, status: 'in_review', revision: first.revision });
    expect(await x.fileState(b1!.id)).toEqual(stateBefore);
    expect(stateBefore).toMatchObject({ status: 'bound', sealed_at: null });
    expect(await x.counts()).toEqual(countsBefore);
    const after = await x.read(me, draft.id);
    expect(after).toMatchObject({ status: 'draft', revision: businessBefore.revision });
    // 之后移除 B 仍是从未提交 → pending_cleanup
    await x.w.json(await x.patch(me, after, { attachmentRefs: [a1!.id] }));
    expect((await x.fileState(b1!.id)).status).toBe('pending_cleanup');
  });
});
