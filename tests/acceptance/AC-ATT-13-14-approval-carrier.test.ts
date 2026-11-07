/**
 * F-479 S2 / AC-ATT-13、14（设计 §3.2 ～ §3.4）：审批载体下载。
 * 13：待办审批人、已办审批人、转交接收人、加签人、抄送人读到 200 + 防内联头；
 * 14：无关员工、被回避主体、节点表单不含该字段、无字段权、拿 A 单地址取 B 单附件，一律 404（前两个是“审批实例不存在”，
 * 其余是“附件不存在”）。全部走真实 HTTP，字段权用真实授权引擎的字段授权。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { png } from './AC-ATT-support.js';
import { APPROVAL, exitWorld } from './AC-ATT-S2-support.js';
import { useSubjectMapping } from './support/f048.js';

const database = useTestDb();
const mapSubjects = useSubjectMapping();
const FIELDS = ['lastWorkDate', 'attachmentRefs'];
const messageOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

async function ready(label: string) {
  const x = await exitWorld(database().db, label);
  const me = await x.a.person('合成本人甲');
  const [file] = await x.uploads(me, 1);
  const scene = await x.submitted(me, [file!.id]);
  await x.grantFields(x.approver.userId, FIELDS);
  return { x, me, file: file!, ...scene };
}

function expectHeaders(response: Response, sha256: string) {
  const header = (name: string) => response.headers.get(name);
  expect(header('content-type')).toBe('image/png');
  expect(header('content-disposition')).toMatch(/^attachment;/);
  expect(header('x-content-type-options')).toBe('nosniff');
  expect(header('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(header('cross-origin-resource-policy')).toBe('same-origin');
  expect(header('cache-control')).toBe('private, no-store');
  expect(header('etag')).toBe(`"${sha256}"`);
}

describe('AC-ATT-13 审批人可读：与详情同一份取值', () => {
  it('待办审批人：详情带 attachments，下载 200 + §3.4 头 + 原字节', async () => {
    const { x, file, instance } = await ready('att13-pending');
    const detail = await x.w.json<{ form: { values: { attachments: { id: string; filename: string }[] } } }>(
      await x.approvalDetail(x.approver, instance.id),
    );
    expect(detail.form.values.attachments).toEqual([expect.objectContaining({ id: file.id, filename: '手写1.png' })]);
    const response = await x.approvalDownload(x.approver, instance.id, file.id);
    expect(response.status).toBe(200);
    expectHeaders(response, file.sha256);
    expect(response.headers.get('content-length')).toBe(String(png(2, 2).length));
    expect(Buffer.from(await response.arrayBuffer()).equals(png(2, 2))).toBe(true);
  });

  it('已办审批人（驳回后）、转交接收人、加签人、抄送人都能读', async () => {
    const { x, me, file, instance, task } = await ready('att13-roles');
    const delegate = await x.a.person('合成转交人');
    const helper = await x.a.person('合成加签人');
    const cc = await x.a.person('合成抄送人');
    for (const user of [delegate, helper, cc]) await x.grantFields(user.userId, FIELDS);
    const copy = await x.w.request(x.approver.userId, 'POST', `${APPROVAL}/tasks/${task.id}/cc`, {
      ifMatch: instance.revision,
      body: { userIds: [cc.userId] },
    });
    expect(copy.status, await copy.clone().text()).toBe(200);
    expect((await x.approvalDownload(cc, instance.id, file.id)).status).toBe(200);

    let view = await x.w.detail(instance.id, me.userId);
    const moved = await x.w.taskAction(x.approver.userId, task.id, 'transfer', view.revision, {
      toUserId: delegate.userId,
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect((await x.approvalDownload(delegate, instance.id, file.id)).status).toBe(200);

    view = await x.w.detail(instance.id, me.userId);
    const signed = await x.w.taskAction(delegate.userId, x.w.pending(view)[0]!.id, 'add-sign', view.revision, {
      userIds: [helper.userId],
      type: 'before',
    });
    expect(signed.status, await signed.clone().text()).toBe(200);
    expect((await x.approvalDownload(helper, instance.id, file.id)).status).toBe(200);

    view = await x.w.detail(instance.id, me.userId);
    const rejected = await x.w.taskAction(helper.userId, x.w.pending(view)[0]!.id, 'reject', view.revision, {
      comment: '补充材料',
    });
    expect(rejected.status, await rejected.clone().text()).toBe(200);
    // 已办（办完的转交人 / 原审批人）仍可读：载体读的是当前 bound 附件
    for (const handled of [x.approver, delegate, helper])
      expect((await x.approvalDownload(handled, instance.id, file.id)).status).toBe(200);
  });
});

describe('AC-ATT-14 不该读到的人一律 404', () => {
  it('无关员工：404 审批实例不存在', async () => {
    const { x, file, instance } = await ready('att14-unrelated');
    const stranger = await x.a.person('合成无关人');
    await x.grantFields(stranger.userId, FIELDS);
    const response = await x.approvalDownload(stranger, instance.id, file.id);
    expect(response.status).toBe(404);
    expect((await messageOf(response)).message).toBe('审批实例不存在');
  });

  it('被主体回避跳过（subject_skip）的人不算审批人：404 审批实例不存在', async () => {
    const x = await exitWorld(database().db, 'att14-skip', { skipFirst: true });
    const me = await x.a.person('合成本人甲');
    const [file] = await x.uploads(me, 1);
    mapSubjects(() => [x.skipper!.employeeId]);
    const { instance } = await x.submitted(me, [file!.id]);
    await x.grantFields(x.skipper!.userId, FIELDS);
    const response = await x.approvalDownload(x.skipper!, instance.id, file!.id);
    expect(response.status).toBe(404);
    expect((await messageOf(response)).message).toBe('审批实例不存在');
  });

  it('节点表单不含 attachmentRefs：详情无附件、下载 404 附件不存在', async () => {
    const x = await exitWorld(database().db, 'att14-form', { formFields: ['lastWorkDate'] });
    const me = await x.a.person('合成本人甲');
    const [file] = await x.uploads(me, 1);
    const { instance } = await x.submitted(me, [file!.id]);
    await x.grantFields(x.approver.userId, FIELDS);
    const detail = await x.w.json<{ form: { values: Record<string, unknown> } }>(
      await x.approvalDetail(x.approver, instance.id),
    );
    expect(detail.form.values).not.toHaveProperty('attachmentRefs');
    expect(detail.form.values).not.toHaveProperty('attachments');
    const response = await x.approvalDownload(x.approver, instance.id, file!.id);
    expect(response.status).toBe(404);
    expect((await messageOf(response)).message).toBe('附件不存在');
  });

  it('审批人没有 attachmentRefs 字段权：详情无该键，下载 404 附件不存在', async () => {
    const x = await exitWorld(database().db, 'att14-right');
    const me = await x.a.person('合成本人甲');
    const [file] = await x.uploads(me, 1);
    const { instance } = await x.submitted(me, [file!.id]);
    await x.grantFields(x.approver.userId, ['lastWorkDate']);
    const detail = await x.w.json<{ form: { values: Record<string, unknown> } }>(
      await x.approvalDetail(x.approver, instance.id),
    );
    expect(detail.form.values).not.toHaveProperty('attachments');
    const response = await x.approvalDownload(x.approver, instance.id, file!.id);
    expect(response.status).toBe(404);
    expect((await messageOf(response)).message).toBe('附件不存在');
  });

  it('A 单的地址取 B 单的附件：404 附件不存在', async () => {
    const x = await exitWorld(database().db, 'att14-cross');
    const first = await x.a.person('合成本人甲');
    const second = await x.a.person('合成本人乙');
    const [fileA] = await x.uploads(first, 1);
    const [fileB] = await x.uploads(second, 1);
    const sceneA = await x.submitted(first, [fileA!.id]);
    await x.submitted(second, [fileB!.id]);
    await x.grantFields(x.approver.userId, FIELDS);
    expect((await x.approvalDownload(x.approver, sceneA.instance.id, fileA!.id)).status).toBe(200);
    const response = await x.approvalDownload(x.approver, sceneA.instance.id, fileB!.id);
    expect(response.status).toBe(404);
    expect((await messageOf(response)).message).toBe('附件不存在');
  });
});
