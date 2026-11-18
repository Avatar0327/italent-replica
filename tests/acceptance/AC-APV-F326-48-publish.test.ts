/** S7d：真实 HTTP 发布检查；有效值为空时整个命令不产生发布副作用。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import {
  actionsOf,
  audits,
  autoAt,
  counter,
  create,
  draftOk,
  manager,
  newVersion,
  placeholder,
  publicVar,
  publishWith,
  readProcess,
  s4World,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { personnelChange, rejected } from './AC-APV-F326-S4-support.js';

const database = useTestDb();
const single = (key: string, approver = placeholder): NodeInput => ({ key, name: `节点${key}`, approver });

describe('AC-APV-F326-48 / AC-57④ 发布按有效值检查指定人员', () => {
  it('① 未选人发布 400、草稿与 current 不变、无 publish 审计；② 选人保存后发布 200', async () => {
    const w = await s4World(database().db, 's7d-publish');
    const p = await create(w, [single('n1')]);
    const error = await rejected(await publishWith(w, p), 400, 'APPROVAL_SPECIFIED_APPROVER_REQUIRED');
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('节点「节点n1」的指定人员未选择，请选择人员后再发布');
    expect(error.details).toMatchObject({ slots: [{ nodeKey: 'n1', nodeName: '节点n1', slot: 'approver' }] });
    expect(await readProcess(w, p.id)).toEqual(p);
    expect(await audits(w, p.id, 'approval.process.publish')).toEqual([]);
    const selected = await draftOk(w, p, [single('n1', specified(w.near.userId))]);
    const done = await w.json<typeof p>(await publishWith(w, selected));
    expect(done.latestVersion.status).toBe('published');
    expect(done.currentVersion!.id).toBe(p.latestVersion.id);
  });

  it('③ 按节点顺序列出会签 approver 与 empty_approver 两处；④ exception_admin 不豁免', async () => {
    const w = await s4World(database().db, 's7d-slots');
    const nodes: NodeInput[] = [
      counter([placeholder], { key: 'other_handover', name: '甲节点', ...{ emptyApproverPolicy: 'exception_admin' } }),
      counter([manager], {
        key: 'work_handover',
        name: '乙节点',
        ...{ emptyApproverPolicy: 'specified', emptyApproverSources: [placeholder] },
      }),
    ];
    const p = await create(w, nodes, { approvalType: 'exit_handover' });
    const error = await rejected(await publishWith(w, p), 400, 'APPROVAL_SPECIFIED_APPROVER_REQUIRED');
    expect(error.message).toBe('节点「甲节点」的指定人员未选择，请选择人员后再发布');
    expect(error.details).toMatchObject({
      slots: [
        { nodeKey: 'other_handover', nodeName: '甲节点', slot: 'approver' },
        { nodeKey: 'work_handover', nodeName: '乙节点', slot: 'empty_approver' },
      ],
    });
    const fixed = await draftOk(w, p, [
      counter([specified(w.near.userId)], { ...nodes[0]!, approvers: [specified(w.near.userId)] }),
      nodes[1]!,
    ]);
    const fallback = await rejected(await publishWith(w, fixed), 400, 'APPROVAL_SPECIFIED_APPROVER_REQUIRED');
    expect(fallback.message).toBe('节点「乙节点」审批人为空时的指定人员未选择，请选择人员后再发布');
    expect(await audits(w, p.id, 'approval.process.publish')).toEqual([]);
  });

  it('⑤ 其他流程的已发布自动变量为空不挡发布；同流程其他节点的普通引用也不算本位置', async () => {
    const w = await s4World(database().db, 's7d-foreign');
    const b = await w.publish(await create(w, [single('b', specified(w.near.userId))]));
    const v = await autoAt(w, b.id, 'b');
    // 合成已发布空值：新发布门禁不能借用自身来准备这个历史/外部取值场景。
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE approval_variables SET default_value=NULL
      WHERE tenant_id=${w.tenant.id} AND id=${v.id}::uuid`),
    );
    const a = await create(w, [single('a', publicVar(v.id))], { priority: 9 });
    expect((await publishWith(w, a)).status).toBe(200);
    const draft = await newVersion(w, b);
    const moved = await draftOk(w, draft, [single('other', publicVar(v.id))]);
    expect((await publishWith(w, moved)).status).toBe(200);
  });

  it('⑥ / AC-57④ 继承变量清空仅记 pending=[]，B 仍派 A1，发布 400 且整笔不变', async () => {
    const w = await s4World(database().db, 's7d-pending-empty');
    const a = await w.publish(
      await create(w, [single('n1', specified(w.head.userId)), single('n2', specified(w.near.userId))]),
    );
    const x = await autoAt(w, a.id, 'n2');
    await w.publish(await create(w, [single('b1', publicVar(x.id))], { approvalType: 'personnel_change' }));
    const draft = await draftOk(w, await newVersion(w, a), [single('n1', specified(w.head.userId)), single('n2')]);
    const before = await varRow(w, x.id);
    expect(before.default_value).toBe(w.near.userId);
    const business = await personnelChange(w);
    expect(w.pending((await business.submit()).instance).map((t) => t.assigneeUserId)).toEqual([w.near.userId]);
    await rejected(await publishWith(w, draft), 400, 'APPROVAL_SPECIFIED_APPROVER_REQUIRED');
    expect(await varRow(w, x.id)).toEqual(before);
    expect(await readProcess(w, a.id)).toEqual(draft);
    expect(actionsOf(await audits(w, x.id))).toEqual(['auto_create']);
    expect(await audits(w, a.id, 'approval.process.publish')).toHaveLength(1);
  });
});
