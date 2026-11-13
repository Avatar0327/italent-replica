/**
 * F-479 S6 / AC-ATT-26（设计 §2.1、§2.3、§3.2）：已办审批人读到的附件 = 办理当时那一份。
 * 场景：两节点流程（首节点 Y 同意，第二节点 X 驳回）；本人删去已封存的 P（→ detached）再提交，第二轮 Y 待办、X 只剩已办。
 * - X（已办，冻结读）：详情仍展开 P、Q（取办理份里的 ID 序列 + 展示元数据），P 可下载（载体判定集含 detached）；
 * - Y（待办，现值读）：只看到 Q，P 仍 404；
 * - 展开与下载都复核当前状态与字段权：P 变 pending_cleanup / purged、X 的 attachmentRefs 字段权被收回，则整项消失、不回显旧文件名；
 * - 办理份只存 ID 序列与展示元数据，不存字节与下载地址，披露上限含 attachmentRefs。
 * 全部走真实 HTTP，字段权用真实授权引擎的字段授权，租户数据读写在对应租户的 withTenant 里。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { png } from './AC-ATT-support.js';
import { APPROVAL, exitWorld } from './AC-ATT-S2-support.js';

const database = useTestDb();
// 办理走真实授权引擎：改动字段里有审批人看不到的会被盲审拦下（APPROVAL_BLIND_REVIEW），所以办理人先授任职对象全部字段，
// 再按场景收回 attachmentRefs
const ALL = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);
const WITHOUT = ALL.filter((code) => code !== 'attachmentRefs');
// 办理人必须能看到 attachmentRefs（它是本单的改动字段，看不到会被盲审拦下），所以办理份的披露上限必含该键；
// “办理时无字段权、事后补授”造不出办理份，由盲审门槛兜住，不单列用例。

interface Shown {
  attachmentRefs?: string[];
  attachments?: { id: string; filename: string; contentType: string; byteSize: number }[];
}
interface DetailBody {
  contentView: { mode: string };
  form: { values: Shown };
  snapshot?: { values?: Shown };
}

async function twoRounds(label: string) {
  const x = await exitWorld(database().db, label, { leadFirst: true });
  const me = await x.a.person('合成本人甲');
  const [p, q] = await x.uploads(me, 2);
  await x.grantFields(x.lead!.userId, ALL);
  const profile = await x.grantFields(x.approver.userId, ALL);
  const { draft, instance, task } = await x.submitted(me, [p!.id, q!.id]);
  // 办理走真实授权引擎（与详情同一授权器），办理份的披露上限才是办理人当时的真实字段权
  const act = (user: { userId: string }, taskId: string, action: 'approve' | 'reject', revision: number) =>
    x.asUser(user, `${APPROVAL}/tasks/${taskId}/${action}`, 'POST', { ifMatch: revision, body: { comment: '办理' } });
  const approved = await act(x.lead!, task.id, 'approve', instance.revision);
  expect(approved.status, await approved.clone().text()).toBe(200);
  const view = await x.w.detail(instance.id, me.userId);
  const rejected = await act(x.approver, x.w.pending(view)[0]!.id, 'reject', view.revision);
  expect(rejected.status, await rejected.clone().text()).toBe(200);
  const returned = await x.read(me, draft.id);
  const saved = await x.w.json<{ revision: number }>(await x.patch(me, returned, { attachmentRefs: [q!.id] }));
  expect((await x.fileState(p!.id)).status).toBe('detached');
  const again = await x.w.json<{ status: string }>(await x.submit(me, { id: draft.id, revision: saved.revision }));
  expect(again.status).toBe('in_review');
  const running = (await x.w.instanceOfAll(draft.id, me.userId)).find((item) => item.status === 'running')!;
  return { x, me, p: p!, q: q!, profile, draftId: draft.id, instanceId: running.id };
}
type Scene = Awaited<ReturnType<typeof twoRounds>>;

async function detailOf(scene: Scene, viewer: { userId: string }) {
  const response = await scene.x.approvalDetail(viewer, scene.instanceId);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return { body: JSON.parse(text) as DetailBody, text };
}

async function setStatus(scene: Scene, fileId: string, status: 'pending_cleanup' | 'purged') {
  const { db, tenant } = scene.x.w;
  await withTenant(db, tenant.id, (tx) =>
    tx.execute(sql`UPDATE attachment_files SET status=${status} WHERE tenant_id=${tenant.id} AND id=${fileId}::uuid`),
  );
}

describe('AC-ATT-26 已办审批人读冻结附件：办理当时那一份，复核当前状态与字段权', () => {
  it('X（已办）详情仍展开 P、Q，且 P（detached）可下载；Y（待办）只看到 Q，P 仍 404', async () => {
    const s = await twoRounds('att26-frozen');
    const handled = await detailOf(s, s.x.approver);
    expect(handled.body.contentView.mode).toBe('frozen');
    expect(handled.body.form.values.attachmentRefs).toEqual([s.p.id, s.q.id]);
    expect(handled.body.form.values.attachments).toEqual([
      { id: s.p.id, filename: '手写1.png', contentType: 'image/png', byteSize: png(2, 2).length },
      { id: s.q.id, filename: '手写2.png', contentType: 'image/png', byteSize: png(3, 2).length },
    ]);
    const first = await s.x.approvalDownload(s.x.approver, s.instanceId, s.p.id);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer()).equals(png(2, 2))).toBe(true);
    expect((await s.x.approvalDownload(s.x.approver, s.instanceId, s.q.id)).status).toBe(200);

    const live = await detailOf(s, s.x.lead!);
    expect(live.body.contentView.mode).toBe('live');
    expect(live.body.form.values.attachmentRefs).toEqual([s.q.id]);
    expect(live.body.form.values.attachments?.map((item) => item.id)).toEqual([s.q.id]);
    expect(live.text).not.toContain('手写1.png');
    expect((await s.x.approvalDownload(s.x.lead!, s.instanceId, s.p.id)).status).toBe(404);
    expect((await s.x.approvalDownload(s.x.lead!, s.instanceId, s.q.id)).status).toBe(200);
  });

  it('P 变 pending_cleanup / purged 后：X 详情不再有 P、不回显旧文件名，下载 404；Q 不受影响', async () => {
    const s = await twoRounds('att26-gone');
    for (const status of ['pending_cleanup', 'purged'] as const) {
      await setStatus(s, s.p.id, status);
      const { body, text } = await detailOf(s, s.x.approver);
      expect(
        body.form.values.attachments?.map((item) => item.id),
        status,
      ).toEqual([s.q.id]);
      expect(text, status).not.toContain('手写1.png');
      expect((await s.x.approvalDownload(s.x.approver, s.instanceId, s.p.id)).status, status).toBe(404);
      expect((await s.x.approvalDownload(s.x.approver, s.instanceId, s.q.id)).status, status).toBe(200);
    }
  });

  it('不属于办理份的文件（办理后才绑定到本单的附件）：X 读不到，哪怕它现在是 bound', async () => {
    const s = await twoRounds('att26-outside');
    // 办理份只有 [P, Q]；本人第二轮又加了新文件 N 并绑定在本单上：X 的办理份里没有它
    const [fresh] = await s.x.uploads(s.me, 1);
    const { db, tenant } = s.x.w;
    await withTenant(db, tenant.id, (tx) =>
      tx.execute(sql`UPDATE attachment_files SET status='bound', business_type='employment',
        business_id=${s.draftId}::uuid, expires_at=NULL WHERE tenant_id=${tenant.id} AND id=${fresh!.id}::uuid`),
    );
    expect((await s.x.approvalDownload(s.x.approver, s.instanceId, fresh!.id)).status).toBe(404);
    const { body } = await detailOf(s, s.x.approver);
    expect(body.form.values.attachments?.map((item) => item.id)).toEqual([s.p.id, s.q.id]);
  });

  it('X 的 attachmentRefs 字段权被收回：详情不含 attachments / attachmentRefs，下载 404；补回后恢复', async () => {
    const s = await twoRounds('att26-revoked');
    await s.x.reviseFields(s.profile, WITHOUT);
    const { body, text } = await detailOf(s, s.x.approver);
    expect(body.form.values).not.toHaveProperty('attachments');
    expect(body.form.values).not.toHaveProperty('attachmentRefs');
    expect(text).not.toContain('手写');
    expect((await s.x.approvalDownload(s.x.approver, s.instanceId, s.p.id)).status).toBe(404);
    await s.x.reviseFields(s.profile, ALL);
    expect((await s.x.approvalDownload(s.x.approver, s.instanceId, s.p.id)).status).toBe(200);
  });

  it('办理份只存 ID 序列与展示元数据：无字节、无下载地址、无 uploadedAt', async () => {
    const s = await twoRounds('att26-shape');
    const { db, tenant } = s.x.w;
    const rows = rowsOf<{ exit: Record<string, unknown>; ceiling: string[] | null }>(
      await withTenant(db, tenant.id, (tx) =>
        tx.execute(sql`SELECT c.content->'ext'->'exit' AS exit, c.disclosure_ceiling AS ceiling
          FROM approval_handling_contents c
          WHERE c.tenant_id=${tenant.id} AND c.actor_user_id=${s.x.approver.userId}::uuid`),
      ),
    );
    expect(rows).toHaveLength(1);
    const { exit, ceiling } = rows[0]!;
    expect(ceiling).toContain('attachmentRefs');
    expect(exit.attachmentRefs).toEqual([s.p.id, s.q.id]);
    expect(exit.attachments).toEqual([
      { id: s.p.id, filename: '手写1.png', contentType: 'image/png', byteSize: png(2, 2).length },
      { id: s.q.id, filename: '手写2.png', contentType: 'image/png', byteSize: png(3, 2).length },
    ]);
    const text = JSON.stringify(exit);
    expect(text).not.toMatch(/base64|uploadedAt|\/attachments\/|content"?:\s*"/);
  });
});
