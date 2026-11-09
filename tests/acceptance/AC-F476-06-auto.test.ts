/**
 * AC-F476-06（P3 部分）：自动同意 / 自动跳过留“系统办理份”（handling_kind = system，actor 为空），
 * 不冒认候选人亲自办理：候选人的人工办理份只来自他真正点过的动作，已办读取仍选他自己最后一次人工办理。
 * 设计 §1.3「自动同意 / 自动跳过」、§4.2 engine.ts 行。
 */
import { approverSource, ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { NodeInput } from './AC-APV-support.js';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { type Copy, copiesOf } from './AC-F476-support.js';

const testDb = useTestDb();
const HRBP = approverSource('approval_subject_org_hrbp');

const system = (copies: readonly Copy[]) => copies.filter((copy) => copy.handling_kind === 'system');
const human = (copies: readonly Copy[]) => copies.filter((copy) => copy.handling_kind === 'human');

async function started(
  label: string,
  nodes: NodeInput[],
  afterWorld?: (w: Awaited<ReturnType<typeof flowWorld>>) => Promise<void>,
) {
  const w = await flowWorld(testDb().db, label, { nodes });
  await afterWorld?.(w);
  const { id } = await w.draft();
  await w.submitted(id);
  return { w, id };
}

describe('AC-F476-06 自动处理 → 系统办理份', () => {
  it.each([
    ['approve', 'auto_approve', 'approved'],
    ['skip', 'skip', 'skipped'],
  ] as const)(
    '同人自动处理（结果 %s）：n1 人工一份 + n2 系统一份，系统份锚定自动任务',
    async (result, action, status) => {
      const { w, id } = await started(
        `f476-06-same-${result}`,
        oaNodes([{}, { approver: HRBP, sameAssigneeSkip: true, sameAssigneeResult: result }]),
      );
      await w.acted(id, w.hrbp, 'approve');
      const view = await w.instance(id);
      expect(view.status).toBe('approved');
      const auto = view.tasks.find((t) => t.nodeKey === 'n2')!;
      expect(auto.status).toBe(status);
      const copies = await copiesOf(w, view.id);
      expect(human(copies).map((c) => [c.node_key, c.actor_user_id, c.action])).toEqual([
        ['n1', w.hrbp.userId, 'approve'],
      ]);
      expect(system(copies)).toHaveLength(1);
      expect(system(copies)[0]).toMatchObject({
        task_id: auto.id,
        node_key: 'n2',
        actor_user_id: null,
        action,
        event: action,
      });
      expect(system(copies)[0]!.payload_bytes).toBeGreaterThan(0);
    },
  );

  it('候选人不因自动处理获得“亲自办理”：已办读取仍是他 n1 的人工份，而不是系统份', async () => {
    const { w, id } = await started('f476-06-same-read', oaNodes([{}, { approver: HRBP, sameAssigneeSkip: true }]));
    await w.acted(id, w.hrbp, 'approve');
    const view = await w.instance(id);
    const n1 = view.tasks.find((t) => t.nodeKey === 'n1')!;
    const detail = (await w.detail(view.id, w.hrbp.userId)) as unknown as {
      contentView: { mode: string; taskId: string };
    };
    expect(detail.contentView).toMatchObject({ mode: 'frozen', taskId: n1.id });
    // 候选人的 n2 自动任务有 assignee，但那是系统处理：他名下只有 n1 一份人工办理份
    expect((await copiesOf(w, view.id)).filter((c) => c.actor_user_id === w.hrbp.userId)).toHaveLength(1);
  });

  it('历史相同审批人自动同意（n3）：写 n3 系统份；人工份仍只有 n1、n2 两个节点各自的办理', async () => {
    const third: NodeInput = {
      key: 'n3',
      name: '第三节点',
      approver: HRBP,
      historySameAssigneeSkip: true,
      formFields: ORG_ADJUSTMENT_FORM_FIELDS,
      exits: ['approve', 'disagree'],
    };
    const { w, id } = await started('f476-06-history', [...oaNodes(), third]);
    await w.acted(id, w.hrbp, 'approve');
    await w.acted(id, w.head, 'approve');
    const view = await w.instance(id);
    expect(view.status).toBe('approved');
    expect(view.tasks.find((t) => t.nodeKey === 'n3')).toMatchObject({ origin: 'history_skip', status: 'approved' });
    const copies = await copiesOf(w, view.id);
    expect(human(copies).map((c) => c.node_key)).toEqual(['n1', 'n2']);
    expect(system(copies).map((c) => [c.node_key, c.action, c.actor_user_id])).toEqual([['n3', 'auto_approve', null]]);
  });
});
