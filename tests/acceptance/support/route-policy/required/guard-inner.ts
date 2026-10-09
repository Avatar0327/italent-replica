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

/**
 * 守卫内部 `when` 条件的语义登记（#162 审查 P2-2）：条件名是 B4b 撤权预期分流的依据，必须与真实路由代码一致。
 * 凡涉及数组 / 引用的条件都写明空数组、已有引用与新增引用的语义；表里用到的条件必须登记
 * （GUARD_INNER_CONDITION_UNREGISTERED）。
 */
export const INNER_CONDITIONS: Readonly<Record<string, string>> = {
  'body.processId': '请求体带 processId 才解析流程范围（PATCH 模板：`body.processId ? processScopeFor : undefined`）',
  'import.notSync': '导入评价者且未选择“同步”（`sync` 不为 true）才另判 360 人员更新权；同步只判新建',
  'payload.person': '请求录入 person（隐式新建 360 人员）才判人员新建权；只选 personId 不判',
  'questionnaire.notCreatedBySelf': '套卷创建人不是当前用户才判 editOthers 按钮与更新权；创建人本人直接放行',
  'payload.categoryId': '请求体带 categoryId（非空）才引用分类；缺省或 null 不判',
  categoryChanged: 'categoryId 给出且与现值不同才引用新分类；原样传现值不判',
  'body.parentId': '请求体带 parentId 才引用上级；缺省不判',
  'body.layerId': '请求体带 layerId 才引用层级；缺省不判',
  layerChanged: 'layerId 给出且与现值不同才引用新层级；原样传现值不判',
  'evalMode=grade': '创建指标时评价方式为 grade 才引用等级方案；score 不判',
  'grade.changed':
    '更新指标时评价方式或等级方案相对现值发生变更，且变更后评价方式为 grade 才引用等级方案；原样传 grade、只改名称等字段不判',
  childrenExist: '确有连带删除的子对象时才要求子对象删除权；没有子对象不判',
  'channels.nonEmpty':
    '替换发展通道时 channels 非空：每条输入通道（含已有通道、原样 PUT）都判类别 / 级别查看权；空数组不判',
  'dimensions.nonEmpty': '创建人才标准时 dimensions 非空：每条都是新增引用，逐个判指标查看权；空数组不判',
  'dimensions.newReference':
    '更新人才标准时 dimensions 中存在现有引用之外的新增引用才判指标查看权；只改已有引用的 weight / target、空数组都不判',
  'details.targetReference':
    '标准 details 非空：每个单元格的指标引用都判指标查看权；details 为空数组（创建 / 更新）不判；PATCH 不带 details 也不判',
  'instance.personnelChange':
    '审批实例业务类型为人员子集变更（personnel_change）时，同单重提经适配器调 resubmitChangeInTransaction，按子集登记的' +
    '自助申请准入复核（R3-T02 P0）；其他业务类型不判；未登记策略的子集钩子不调用',
};
