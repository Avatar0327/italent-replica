/**
 * F-479 S2 / AC-ATT-15、16、17（设计 §2.4、§3.2、§3.3）：HR 载体、非本人出口对附件只读、撤权后的本人入口。
 * 15：HR 有字段权读到 attachments 与字节；无字段权整键缺席且下载 404；范围外 404；无详情查看权 403；
 * 16：HR 创建 / 编辑、审批编辑、同意时带编辑带了不同 attachmentRefs → 400 ATTACHMENT_REFS_READONLY 且不写；
 *     同值或不带照旧；
 * 17：管理员经权限配置入口收回 TenantBase.SelfExit.attachmentRefs 后，表单模式、登记、本人下载随之变化。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png, registration } from './AC-ATT-support.js';
import { APPROVAL, exitWorld, SELF } from './AC-ATT-S2-support.js';

const database = useTestDb();
const FIELDS = ['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'lastWorkDate', 'name', 'code'];
const allowAll: Authorizer = () => true;
const noView: Authorizer = (request) => request.action !== 'object.view';
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

async function drafted(label: string, count = 1) {
  const x = await exitWorld(database().db, label);
  const me = await x.a.person('合成本人甲');
  const files = await x.uploads(me, count);
  const draft = await x.createDraft(
    me,
    files.map((file) => file.id),
  );
  return { x, me, files, draft };
}
/** HR 写入口：自定义授权器（全部放行）+ 字段全开，范围全部；与真实授权引擎无关，只验证附件只读规则。 */
const hrCall = (x: Awaited<ReturnType<typeof exitWorld>>, path: string, method = 'GET', init: object = {}) =>
  x.restrictedHr(allowAll, [...FIELDS, 'attachmentRefs', 'mode', 'exit'])(path, method, init);

describe('AC-ATT-15 HR 载体', () => {
  it('有字段权：详情带 attachments，下载 200 + 防内联头 + 原字节；本人与 HR 看到同一份', async () => {
    const { x, files, draft } = await drafted('att15-ok');
    const api = x.restrictedHr(allowAll, [...FIELDS, 'attachmentRefs']);
    const detail = await x.w.json<{ attachmentRefs: string[]; attachments: { id: string; filename: string }[] }>(
      await api(`/exits/${draft.id}`),
    );
    expect(detail.attachmentRefs).toEqual([files[0]!.id]);
    expect(detail.attachments).toEqual([expect.objectContaining({ id: files[0]!.id, filename: '手写1.png' })]);
    const response = await api(`/exits/${draft.id}/attachments/${files[0]!.id}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('etag')).toBe(`"${files[0]!.sha256}"`);
    expect(Buffer.from(await response.arrayBuffer()).equals(png(2, 2))).toBe(true);
  });

  it('无 attachmentRefs 字段权：整键缺席（不是 null / 空数组），下载 404 附件不存在', async () => {
    const { x, files, draft } = await drafted('att15-nofield');
    const api = x.restrictedHr(allowAll, FIELDS);
    const detail = await x.w.json<Record<string, unknown>>(await api(`/exits/${draft.id}`));
    expect(detail).not.toHaveProperty('attachmentRefs');
    expect(detail).not.toHaveProperty('attachments');
    const response = await api(`/exits/${draft.id}/attachments/${files[0]!.id}/content`);
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toBe('附件不存在');
  });

  it('范围外 404（详情与下载同一判定，不泄露存在性）；没有详情查看权 403', async () => {
    const { x, files, draft } = await drafted('att15-scope');
    const outside = x.restrictedHr(allowAll, [...FIELDS, 'attachmentRefs'], 'empty');
    expect((await outside(`/exits/${draft.id}`)).status).toBe(404);
    const hidden = await outside(`/exits/${draft.id}/attachments/${files[0]!.id}/content`);
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain('手写');
    const denied = x.restrictedHr(noView, [...FIELDS, 'attachmentRefs']);
    expect((await denied(`/exits/${draft.id}`)).status).toBe(403);
    expect((await denied(`/exits/${draft.id}/attachments/${files[0]!.id}/content`)).status).toBe(403);
  });

  it('文件不在本单引用里（随机 ID、他人单的文件）→ 404 附件不存在', async () => {
    const { x, draft } = await drafted('att15-foreign');
    const other = await x.a.person('合成本人乙');
    const [theirs] = await x.uploads(other, 1);
    await x.createDraft(other, [theirs!.id]);
    const api = x.restrictedHr(allowAll, [...FIELDS, 'attachmentRefs']);
    for (const id of [randomUUID(), theirs!.id]) {
      const response = await api(`/exits/${draft.id}/attachments/${id}/content`);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).message).toBe('附件不存在');
    }
    expect((await api(`/exits/${draft.id}/attachments/not-a-uuid/content`)).status).toBe(400);
  });
});

describe('AC-ATT-16 非本人出口对 attachmentRefs 只读', () => {
  it('HR 新建（专用入口与通用入口）：带不同的引用 400 且不建单；空数组 / 不带照旧 201', async () => {
    const x = await exitWorld(database().db, 'att16-create');
    const target = await x.a.person('合成员工丙');
    const revision = async () =>
      (await x.w.json<{ revision: number }>(await hrCall(x, `/employees/${target.employeeId}`))).revision;
    const before = await x.counts();
    const refused = await hrCall(x, `/exits/employees/${target.employeeId}`, 'POST', {
      ifMatch: await revision(),
      body: { mode: 'application', lastWorkDate: '2026-12-01', exit: { attachmentRefs: [randomUUID()] } },
    });
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).code).toBe('ATTACHMENT_REFS_READONLY');
    const general = await hrCall(x, `/employees/${target.employeeId}/businesses`, 'POST', {
      ifMatch: await revision(),
      body: {
        kind: 'leave',
        mode: 'application',
        lastWorkDate: '2026-12-01',
        fields: {},
        exit: { attachmentRefs: [randomUUID()] },
      },
    });
    expect(general.status).toBe(400);
    expect((await errorOf(general)).code).toBe('ATTACHMENT_REFS_READONLY');
    expect(await x.counts()).toEqual(before);
    const created = await hrCall(x, `/exits/employees/${target.employeeId}`, 'POST', {
      ifMatch: await revision(),
      body: { mode: 'application', lastWorkDate: '2026-12-01', exit: { attachmentRefs: [] } },
    });
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('HR 编辑：带不同的引用 400 且附件行 / 业务单不变；同值与不带照旧 200', async () => {
    const { x, files, draft } = await drafted('att16-edit', 2);
    const [first, second] = files;
    const send = (body: object, revision = draft.revision) =>
      hrCall(x, `/exits/${draft.id}`, 'PATCH', { ifMatch: revision, body });
    const before = await x.counts();
    for (const refs of [[], [second!.id], [second!.id, first!.id], [randomUUID()]]) {
      const refused = await send({ attachmentRefs: refs });
      expect(refused.status, JSON.stringify(refs)).toBe(400);
      expect((await errorOf(refused)).code).toBe('ATTACHMENT_REFS_READONLY');
    }
    expect(await x.counts()).toEqual(before);
    expect((await x.exitRow(draft.id)).attachment_refs).toEqual([first!.id, second!.id]);
    for (const id of [first!.id, second!.id]) expect((await x.fileState(id)).status).toBe('bound');
    const same = await x.w.json<{ revision: number }>(
      await send({ attachmentRefs: [first!.id, second!.id], lastWorkDate: '2026-12-02' }),
    );
    const absent = await send({ lastWorkDate: '2026-12-03' }, same.revision);
    expect(absent.status, await absent.clone().text()).toBe(200);
    expect((await x.exitRow(draft.id)).attachment_refs).toEqual([first!.id, second!.id]);
  });

  it('审批中编辑 / 同意时带编辑：带不同的 attachmentRefs 400 且不写；不带照旧', async () => {
    for (const editMode of ['separate', 'with_approve'] as const) {
      const x = await exitWorld(database().db, `att16-${editMode}`, { editMode });
      const me = await x.a.person('合成本人甲');
      const [first, second] = await x.uploads(me, 2);
      const { instance, task } = await x.submitted(me, [first!.id]);
      await x.grantFields(x.approver.userId, ['lastWorkDate', 'attachmentRefs']);
      const act = (action: 'edit' | 'approve', fields: object) =>
        x.w.taskAction(x.approver.userId, task.id, action, instance.revision, { fields });
      const action = editMode === 'separate' ? 'edit' : 'approve';
      const before = await x.counts();
      const refused = await act(action, { attachmentRefs: [first!.id, second!.id] });
      expect(refused.status, await refused.clone().text()).toBe(400);
      expect((await errorOf(refused)).code).toBe('ATTACHMENT_REFS_READONLY');
      expect(await x.counts()).toEqual(before);
      expect((await x.fileState(second!.id)).status).toBe('uploaded');
      expect((await x.fileState(first!.id)).status).toBe('bound');
      expect((await x.w.detail(instance.id, me.userId)).status).toBe('running');
    }
  });
});

describe('AC-ATT-17 撤权后本人入口随之变化', () => {
  it('收回 attachmentRefs 编辑 → 表单只读、登记 403；收回查看 → 表单缺席、本人下载 404；恢复后回来', async () => {
    const { x, me, files, draft } = await drafted('att17');
    const profile = await x.a.selfServiceProfile();
    const modes = async () =>
      (await x.w.json<{ fieldModes: Record<string, string> }>(await x.ess(me, '/exit-requests/form'))).fieldModes;
    expect((await modes()).attachmentRefs).toBe('editable');
    expect((await x.download(me, draft.id, files[0]!.id)).status).toBe(200);

    expect((await profile.setAttachmentField(true, false)).status).toBe(200);
    expect((await modes()).attachmentRefs).toBe('readonly');
    expect((await x.a.register(me, registration(png()))).status).toBe(403);
    expect((await x.download(me, draft.id, files[0]!.id)).status).toBe(200);

    expect((await profile.setAttachmentField(false, false)).status).toBe(200);
    expect(await modes()).not.toHaveProperty('attachmentRefs');
    const gone = await x.download(me, draft.id, files[0]!.id);
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).message).toBe('附件不存在');
    const own = await x.w.json<Record<string, unknown>>(await x.ess(me, `/exit-requests/${draft.id}`));
    expect(own).not.toHaveProperty('attachments');

    expect((await profile.setAttachmentField(true, true)).status).toBe(200);
    expect((await modes()).attachmentRefs).toBe('editable');
    expect((await x.download(me, draft.id, files[0]!.id)).status).toBe(200);
  });
});

void SELF;
void APPROVAL;
