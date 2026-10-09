/**
 * 守卫内部“或”的备选登记（F-039 PR-B1，设计 B-08 步骤二第 5 点“守卫内部角色”）。
 * 某些守卫（承载者）内部是“或”：既有由授权器回答的权限备选，也有不经授权器的数据态备选（如计划参与人关系）。
 * 表里 `purpose: 'guard:<承载者>'` 且 `inner.role === 'or'` 的义务，其内部备选必须在这里登记（required.ts
 * GUARD_INNER_ALT_UNREGISTERED），并带证据；探测按样本实际满足的内部分支决定撤权期望（PR-B4b）。
 * 备选值：权限键列表（授权器回答），或 `data:<关系名>`（数据态，不经授权器）。
 */
import type { Evidence } from './types.js';

export interface GuardInnerAlts {
  /** 内部“或”组名，与义务 `inner.group` 相等。 */
  readonly group: string;
  readonly alts: Readonly<Record<string, readonly string[] | `data:${string}`>>;
  readonly at: readonly Evidence[];
}

const APPROVAL = 'apps/api/src/modules/approval';
const IDP = 'apps/api/src/modules/idp';

export const GUARD_INNER_ALTS: Readonly<Record<string, GuardInnerAlts>> = {
  // 审批详情 / 任务 / 日志可打开：发起人、参与审批人或被抄送人（数据态），或范围内的流程管理员（转交 / 干预按钮）
  'approval.canOpen': {
    group: 'canOpen',
    alts: {
      initiator: 'data:approval.initiator',
      participant: 'data:approval.participant',
      adminTransfer: ['btn:TenantBase.ApprovalInstance#adminTransfer@detail'],
      adminIntervene: ['btn:TenantBase.ApprovalInstance#adminIntervene@detail'],
    },
    at: [
      {
        role: 'call',
        unit: `${APPROVAL}/disclosure.ts#readDetail`,
        anchor: 'await assertCanOpen(tx, ctx, instance, viewer)',
      },
      {
        role: 'impl',
        unit: `${APPROVAL}/disclosure.ts#assertCanOpen`,
        anchor: 'if (instance.initiatorUserId === viewer.userId) return;',
      },
      {
        role: 'impl',
        unit: `${APPROVAL}/disclosure.ts#assertCanOpen`,
        anchor: 'for (const scope of [viewer.transferScope, viewer.interveneScope])',
      },
    ],
  },
  // IDP 执行写入：HR（计划查看权且员工在其范围内）或计划参与人，之后还要求当前待办节点与节点按钮
  'idp.executor': {
    group: 'executor',
    alts: {
      hr: ['obj:IDP.Idp:view'],
      participant: 'data:idp.planParticipant',
    },
    at: [
      {
        role: 'call',
        unit: `${IDP}/execution-service.ts#executorFor`,
        anchor: 'const executor = await requireExecutor(tx, ctx, ctx.hr, plan, stages, moduleId, button)',
      },
      {
        role: 'impl',
        unit: `${IDP}/plan-access.ts#requireExecutor`,
        anchor:
          "if (!at.participant && !(await hrSees(tx, hr, plan))) throw new AppError('NOT_FOUND', '发展计划不存在')",
      },
    ],
  },
};
