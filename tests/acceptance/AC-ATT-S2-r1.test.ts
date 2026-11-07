/**
 * F-479 S2 第 1 轮返工（审查 #614）：
 * P1 本人提交按当前字段写权复核 attachmentRefs（设计 §2.4）；
 * P2 改期生成后继单时附件继承（后继单可见可下载，前单照常）；
 * P2 审批编辑原样回传同值附件列表照常成功（独立编辑 / 同意时带编辑两种模式）；
 * P3 审批下载路由的 F-039 声明（见 AC-PRM-FW-*，不在本文件）。
 * 全部走真实 HTTP，普通角色可过。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png } from './AC-ATT-support.js';
import { exitWorld, type ExitWorld } from './AC-ATT-S2-support.js';

const database = useTestDb();
const allowAll: Authorizer = () => true;
const FIELDS = ['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'lastWorkDate', 'name', 'code'];
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

describe('R1-P1 收回附件编辑权后本人不能提交（整单载荷含非空 attachmentRefs）', () => {
  it('首次提交：撤权后 403，单据仍是草稿，附件未封存，无审计 / outbox 新增；恢复编辑权后可提交', async () => {
    const x = await exitWorld(database().db, 'r1p1-first');
    const me = await x.a.person('合成本人甲');
    const files = await x.uploads(me, 2);
    const draft = await x.createDraft(
      me,
      files.map((file) => file.id),
    );
    const profile = await x.a.selfServiceProfile();
    expect((await profile.setAttachmentField(true, false)).status).toBe(200);
    const before = await x.counts();
    const refused = await x.submit(me, draft);
    expect(refused.status, await refused.clone().text()).toBe(403);
    expect(await x.counts()).toEqual(before);
    expect(await x.read(me, draft.id)).toMatchObject({ status: 'draft', revision: draft.revision });
    for (const file of files) expect((await x.fileState(file.id)).sealed_at).toBeNull();

    expect((await profile.setAttachmentField(true, true)).status).toBe(200);
    const sent = await x.w.json<{ status: string }>(await x.submit(me, draft));
    expect(sent.status).toBe('in_review');
    for (const file of files) expect((await x.fileState(file.id)).sealed_at).not.toBeNull();
  });

  it('原键重放：已提交→撤回→撤权后用原 Idempotency-Key 重放也拒绝，单据仍为草稿，无新增审计 / outbox', async () => {
    const x = await exitWorld(database().db, 'r1p1-replay');
    const me = await x.a.person('合成本人甲');
    const [file] = await x.uploads(me, 1);
    const draft = await x.createDraft(me, [file!.id]);
    const key = randomUUID();
    const first = await x.w.json<{ id: string }>(await x.submit(me, draft, key));
    const { instance } = await x.instanceOf(first, me);
    expect((await x.w.instanceAction(me.userId, instance.id, 'withdraw', instance.revision, {})).status).toBe(200);
    const profile = await x.a.selfServiceProfile();
    expect((await profile.setAttachmentField(true, false)).status).toBe(200);
    const before = await x.counts();
    const stateBefore = await x.fileState(file!.id);
    const replay = await x.submit(me, draft, key);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await x.counts()).toEqual(before);
    expect(await x.fileState(file!.id)).toEqual(stateBefore);
    expect((await x.read(me, draft.id)).status).toBe('draft');
  });
});

describe('R1-P2 改期生成后继单：附件继承', () => {
  const READ = [...FIELDS, 'attachmentRefs', 'mode', 'exit'];

  /** 本人带附件提交 → 审批通过 → 到生效日定时生效；返回已生效的离职单。 */
  async function effectiveExit(x: ExitWorld, files: number) {
    const me = await x.a.person('合成本人甲');
    const uploaded = await x.uploads(me, files);
    const { draft, instance, task } = await x.submitted(
      me,
      uploaded.map((file) => file.id),
    );
    await x.grantFields(x.approver.userId, ['lastWorkDate', 'attachmentRefs']);
    await x.fillExitType(draft.id);
    const { revision } = await x.w.detail(instance.id, me.userId);
    const approved = await x.w.taskAction(x.approver.userId, task.id, 'approve', revision, {});
    expect(approved.status, await approved.clone().text()).toBe(200);
    x.w.setNow('2026-12-03T02:00:00.000Z');
    expect(await x.activateAt('2026-12-03T02:00:00.000Z')).toMatchObject({ activated: [draft.id] });
    return { me, uploaded, exitId: draft.id };
  }

  async function reschedule(x: ExitWorld, exitId: string) {
    const detail = await x.w.json<{ revision: number }>(await x.restrictedHr(allowAll, READ)(`/exits/${exitId}`));
    const response = await x.restrictedHr(allowAll, READ)(`/exits/${exitId}`, 'PATCH', {
      ifMatch: detail.revision,
      body: { lastWorkDate: '2026-12-20' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await x.w.json<{ successor: { id: string } }>(response);
    expect(result.successor.id).not.toBe(exitId);
    return result.successor.id;
  }

  const view = async (x: ExitWorld, fields: readonly string[], id: string) =>
    x.w.json<{ attachmentRefs?: string[]; attachments?: { id: string; filename: string }[] }>(
      await x.restrictedHr(allowAll, fields)(`/exits/${id}`),
    );

  it('有字段权：后继详情展开 attachments、下载 200 且是原字节；前单详情与下载仍正常；两单文件各有归属', async () => {
    const x = await exitWorld(database().db, 'r1p2-ok');
    const { uploaded, exitId } = await effectiveExit(x, 2);
    const successorId = await reschedule(x, exitId);
    const api = x.restrictedHr(allowAll, READ);

    const next = await view(x, READ, successorId);
    expect(next.attachments).toEqual([
      expect.objectContaining({ filename: '手写1.png' }),
      expect.objectContaining({ filename: '手写2.png' }),
    ]);
    expect(next.attachmentRefs).toHaveLength(2);
    for (const [index, id] of next.attachmentRefs!.entries()) {
      const response = await api(`/exits/${successorId}/attachments/${id}/content`);
      expect(response.status, id).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(png(2 + index, 2))).toBe(true);
      const state = await x.fileState(id);
      expect(state).toMatchObject({ status: 'bound', business_id: successorId });
      expect(state.sealed_at).not.toBeNull();
    }
    // 前单仍引用自己的文件，原下载地址不变
    const old = await view(x, READ, exitId);
    expect(old.attachmentRefs).toEqual(uploaded.map((file) => file.id));
    for (const file of uploaded) {
      expect((await api(`/exits/${exitId}/attachments/${file.id}/content`)).status).toBe(200);
      // 前单的文件地址不能拿来读后继单（归属校验不放宽）
      expect((await api(`/exits/${successorId}/attachments/${file.id}/content`)).status).toBe(404);
    }
    for (const id of next.attachmentRefs!)
      expect((await api(`/exits/${exitId}/attachments/${id}/content`)).status).toBe(404);
  });

  it('无 attachmentRefs 字段权：后继单整键缺席、下载 404；本人看后继单同样可读（本人入口）', async () => {
    const x = await exitWorld(database().db, 'r1p2-nofield');
    const { me, exitId } = await effectiveExit(x, 1);
    const successorId = await reschedule(x, exitId);
    const withRight = await view(x, READ, successorId);
    const noRight = await view(x, FIELDS, successorId);
    expect(noRight).not.toHaveProperty('attachmentRefs');
    expect(noRight).not.toHaveProperty('attachments');
    const denied = await x.restrictedHr(
      allowAll,
      FIELDS,
    )(`/exits/${successorId}/attachments/${withRight.attachmentRefs![0]}/content`);
    expect(denied.status).toBe(404);
    expect((await errorOf(denied)).message).toBe('附件不存在');
    const own = await x.w.json<{ attachments?: unknown[] }>(await x.ess(me, `/exit-requests/${successorId}`));
    expect(own.attachments).toHaveLength(1);
    const download = await x.download(me, successorId, withRight.attachmentRefs![0]!);
    expect(download.status).toBe(200);
  });
});

describe('R1-P2 审批编辑原样回传附件列表', () => {
  async function approvalScene(label: string, editMode: 'separate' | 'with_approve') {
    const x = await exitWorld(database().db, label, { editMode, editableFields: ['attachmentRefs', 'lastWorkDate'] });
    const me = await x.a.person('合成本人甲');
    const [first, second] = await x.uploads(me, 2);
    const { draft, instance, task } = await x.submitted(me, [first!.id]);
    await x.grantFields(x.approver.userId, ['lastWorkDate', 'attachmentRefs']);
    await x.fillExitType(draft.id);
    const act = async (fields: object) =>
      x.w.taskAction(
        x.approver.userId,
        task.id,
        editMode === 'separate' ? 'edit' : 'approve',
        (await x.w.detail(instance.id, me.userId)).revision,
        { fields },
      );
    return { x, me, first: first!, second: second!, draft, instance, act };
  }
  const expectOk = async (response: Response) => expect(response.status, await response.clone().text()).toBe(200);

  it('独立编辑：异值 400 且不写；同值成功（附件与引用不动）；同值 + 正常字段、仅正常字段都成功', async () => {
    const { x, first, second, draft, act } = await approvalScene('r1p3-separate', 'separate');
    const before = await x.counts();
    const refused = await act({ attachmentRefs: [first.id, second.id] });
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect((await errorOf(refused)).code).toBe('ATTACHMENT_REFS_READONLY');
    expect(await x.counts()).toEqual(before);

    await expectOk(await act({ attachmentRefs: [first.id] }));
    expect((await x.exitRow(draft.id)).attachment_refs).toEqual([first.id]);
    await expectOk(await act({ attachmentRefs: [first.id], lastWorkDate: '2026-12-05' }));
    await expectOk(await act({ lastWorkDate: '2026-12-06' }));
    expect((await x.fileState(first.id)).status).toBe('bound');
    expect((await x.fileState(second.id)).status).toBe('uploaded');
  });

  it('同意时带编辑：异值 400 且实例仍在审批；同值 + 正常字段的同意成功', async () => {
    const { x, me, first, second, instance, act } = await approvalScene('r1p3-with-approve', 'with_approve');
    const refused = await act({ attachmentRefs: [first.id, second.id] });
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect((await errorOf(refused)).code).toBe('ATTACHMENT_REFS_READONLY');
    expect((await x.w.detail(instance.id, me.userId)).status).toBe('running');

    await expectOk(await act({ attachmentRefs: [first.id], lastWorkDate: '2026-12-05' }));
    expect((await x.w.detail(instance.id, me.userId)).status).toBe('approved');
    expect((await x.fileState(first.id)).status).toBe('bound');
  });

  it('同意时带编辑：只回传同值附件列表（没有别的字段变化）也成功', async () => {
    const { x, me, first, instance, act } = await approvalScene('r1p3-same-only', 'with_approve');
    await expectOk(await act({ attachmentRefs: [first.id] }));
    expect((await x.w.detail(instance.id, me.userId)).status).toBe('approved');
  });
});
