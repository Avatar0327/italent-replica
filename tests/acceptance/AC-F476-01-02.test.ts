/**
 * AC-F476-01 / 02（P1 部分：审批详情 + 组织调整详情 / 明细两个入口；预览、导出属 P2）：
 * 已办读办理时的内容（冻结），在办 / 发起人 / 无办理记录的读现值。
 * 红点：旧实现两入口都读现值（B），且组织调整读接口对 HR 先走“HR 现值”分支。
 */
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { NAME_A, NAME_B, SUBJECT_A, SUBJECT_B, copiesOf, handledThenChanged, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();

describe('AC-F476-01 已办读办理时内容（两入口）', () => {
  it('HRBP（同意）与负责人（驳回）的“已办”在审批中心与组织调整详情 / 明细都读到办理时的 A', async () => {
    const w = await flowWorld(testDb().db, 'f476-01');
    const s = await handledThenChanged(w);
    for (const actor of [w.hrbp, w.head]) {
      const seen = await seenBy(w, s, actor.userId);
      expect(seen.orgStatus).toBe(200);
      expect(seen.centerNames, `${actor.name} 审批中心名称`).toEqual([NAME_A]);
      expect(seen.centerSubject, `${actor.name} 审批中心主题`).toBe(SUBJECT_A);
      expect(seen.mode).toBe('frozen');
      expect(seen.orgNames, `${actor.name} 组织明细名称`).toEqual([NAME_A]);
      expect(seen.orgSubject, `${actor.name} 组织详情主题`).toBe(SUBJECT_A);
    }
    expect((await copiesOf(w, s.instanceId)).map((c) => c.handling_kind)).toEqual(['human', 'human']);
  });

  it('发起人读现值 B（审批中心 + 组织调整两入口），不因别人有办理份而变', async () => {
    const w = await flowWorld(testDb().db, 'f476-01-init');
    const s = await handledThenChanged(w);
    const seen = await seenBy(w, s, w.hr.id);
    expect(seen).toMatchObject({
      centerNames: [NAME_B],
      centerSubject: SUBJECT_B,
      orgNames: [NAME_B],
      orgSubject: SUBJECT_B,
    });
    expect(seen.mode).toBe('live');
  });
});

describe('AC-F476-02 D1 / D2 读源选择', () => {
  it('已办人同时持有 HR 权限时仍读自己的冻结份（不得因 HR 身份回到现值）', async () => {
    // hrbp 默认持有 HR / 全部范围：旧实现的 HR 分支会先于审批人分支，给出 B。
    const w = await flowWorld(testDb().db, 'f476-02-hr');
    const s = await handledThenChanged(w);
    const seen = await seenBy(w, s, w.hrbp.userId);
    expect(seen.orgNames).toEqual([NAME_A]);
    expect(seen.orgSubject).toBe(SUBJECT_A);
  });

  it('只有 HR 权限、从未办理的人读组织调整现值 B（无办理份可选）', async () => {
    const w = await flowWorld(testDb().db, 'f476-02-onlyhr');
    const s = await handledThenChanged(w);
    const bystander = await w.person('旁观HR', w.b);
    const seen = await seenBy(w, s, bystander.userId, false);
    expect(seen.orgStatus).toBe(200);
    expect(seen.orgNames).toEqual([NAME_B]);
    expect(seen.orgSubject).toBe(SUBJECT_B);
    // 先红后绿的锚点：办理份必须存在，旁观者不应有自己的份
    expect((await copiesOf(w, s.instanceId)).some((c) => c.actor_user_id === bystander.userId)).toBe(false);
  });

  it('节点字段集取自被选中的办理节点：负责人节点不勾名称时，其已办读不到名称，且不因现值回退', async () => {
    const w = await flowWorld(testDb().db, 'f476-02-node', {
      nodes: oaNodes([{}, { formFields: ORG_ADJUSTMENT_FORM_FIELDS.filter((code) => code !== 'orgItems.name') }]),
    });
    const s = await handledThenChanged(w);
    const head = await seenBy(w, s, w.head.userId);
    expect(head.centerNames).toEqual([]);
    expect(head.orgNames.every((name) => name === undefined)).toBe(true);
    const hrbp = await seenBy(w, s, w.hrbp.userId);
    expect(hrbp.centerNames).toEqual([NAME_A]);
  });
});
