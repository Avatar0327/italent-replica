/**
 * IDP 阶段的办理份内容与已办读取（F-476 P8，设计 §5.2、§5.4、§6.0）。
 * 业务单元是计划阶段（审批实例 businessId = 阶段 ID）。办理时在计划行锁下读一份“计划详情的内容部分”：
 * 模板模块结构、目标（含任务、目标回顾）、综述、回顾、关键信息，再带上计划头与阶段标识；
 * 已办读取按它还原，不随之后目标 / 任务 / 综述的修改变化。
 * - sections 是披露上限：按办理时模板模块配置推出（目标模块 → goals，开启任务 / 目标回顾再加 tasks / goalReviews；
 *   综述 → analyses；回顾 → reviews；关键信息 → keyInfo），读取时只放出上限内的段，空集什么都不放；
 *   关键信息另按当前读者对源对象的字段与范围权限裁剪（上限 ∩ 当前权限）。
 * - 读取只给只读呈现（参与人字段集，节点按钮为空）；办理份缺失 / 形状不对 503，绝不退回现值（DEC-807）。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { approvalError } from '../approval/context.js';
import { loadPlanRow, loadStage } from './plan-store.js';
import {
  type GoalView,
  type KeyInfo,
  loadKeyInfo,
  loadPlanContent,
  type PlanContent,
  type PlanDetail,
  presentPlan,
  type Projections,
} from './plan-view.js';
import type { PlanViewer } from './plan-access.js';

/** 办理份里的披露段（设计 §5.2 的“真实详情的 module / section 映射”）。 */
export const SECTIONS = ['goals', 'tasks', 'goalReviews', 'analyses', 'reviews', 'keyInfo'] as const;
export type Section = (typeof SECTIONS)[number];

export interface IdpStageContent extends PlanContent {
  readonly stage: { readonly id: string; readonly seq: number; readonly name: string; readonly subProcessId: string };
  /** 办理时的计划修订号（展示版本，不对外）。 */
  readonly planRevision: number;
  readonly plan: {
    readonly name: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly tutorRole: string;
    readonly tutorEmployeeId: string;
  };
  readonly sections: Section[];
}

/** 按模板模块配置推出披露段（办理时刻的配置）。 */
export function sectionsOf(modules: PlanContent['modules']): Section[] {
  const sections = new Set<Section>();
  for (const module of modules) {
    if (module.moduleType === 'goal') {
      sections.add('goals');
      if (module.taskEnabled === true) sections.add('tasks');
      if (module.goalReviewEnabled === true) sections.add('goalReviews');
    }
    if (module.moduleType === 'analysis') sections.add('analyses');
    if (module.moduleType === 'review') sections.add('reviews');
    if (module.moduleType === 'key_info') sections.add('keyInfo');
  }
  return SECTIONS.filter((section) => sections.has(section));
}

/**
 * 办理份扩展内容加载器（经 provider 注册，在办理人办理、业务状态还没被推进之前调用）。
 * 调用方已持有计划行锁（适配器 lock 先锁计划再锁实例，与所有计划内容写入同序）：模板、目标、综述、回顾与修订号因此一致。
 * 关键信息（带教 / 职业发展 / 轮岗）的维护只锁源记录、不取计划锁，三类各自一条 SELECT 可能读到不同时刻的状态
 * （带教 A + 职业发展 B 从未同时存在）。这里不加新锁（设计 §4.3 禁止新增先实例锁再员工 / 组织锁的路径），改为
 * 读两遍比对：两遍每一类都相同 → 三类在第一遍末与第二遍首之间同时不变，保存的是一个真实存在过的完整状态；
 * 不同 → 409 且不落份，任务保持待办，办理人重试。（SELECT 不带修订号，A→B→A 的往返读不出，该往返的终态与首态
 * 相同，保存的仍是真实存在过的状态。）
 */
export async function loadIdpStageContent(tx: Tx, tenantId: string, stageId: string): Promise<IdpStageContent> {
  const stage = await loadStage(tx, tenantId, stageId);
  const plan = stage ? await loadPlanRow(tx, tenantId, stage.planId) : undefined;
  if (!stage || !plan) throw new AppError('NOT_FOUND', '发展计划阶段不存在');
  const content = await loadPlanContent(tx, plan);
  if (JSON.stringify(await loadKeyInfo(tx, plan)) !== JSON.stringify(content.keyInfo)) throw changing();
  return {
    stage: { id: stage.id, seq: stage.seq, name: stage.name, subProcessId: stage.subProcessId },
    planRevision: plan.revision,
    plan: {
      name: plan.name,
      startDate: plan.startDate,
      endDate: plan.endDate,
      tutorRole: plan.tutorRole,
      tutorEmployeeId: plan.tutorEmployeeId,
    },
    sections: sectionsOf(content.modules),
    ...content,
  };
}

const missing = () =>
  approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');

const changing = () =>
  approvalError('CONFLICT', 'IDP_KEY_INFO_CHANGING', '关键信息正在被修改，办理内容未能一致读取，请稍后重试');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isList = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(isRecord);

/**
 * 校验办理份扩展：形状不对（空扩展 / 老版本空 values 份 / 阶段对不上）一律 503。
 * expectedStageId 是读取方按“选中的实例”推出的阶段，防止拿错阶段的份顶替。
 */
export function parseIdpStageContent(ext: unknown, expectedStageId: string): IdpStageContent {
  if (!isRecord(ext) || !isRecord(ext.stage) || ext.stage.id !== expectedStageId) throw missing();
  const { plan, sections, modules, goals, analyses, reviews, keyInfo } = ext;
  const keyInfoOk =
    isRecord(keyInfo) && [keyInfo.tutorships, keyInfo.careers, keyInfo.workShifts].every((rows) => isList(rows));
  const sectionsOk = Array.isArray(sections) && sections.every((s) => (SECTIONS as readonly unknown[]).includes(s));
  if (!isRecord(plan) || typeof plan.name !== 'string' || typeof plan.startDate !== 'string') throw missing();
  if (!sectionsOk || !keyInfoOk) throw missing();
  if (![modules, goals, analyses, reviews].every(isList)) throw missing();
  return ext as unknown as IdpStageContent;
}

const NO_KEY_INFO: KeyInfo = { tutorships: [], careers: [], workShifts: [] };

/**
 * 把办理份还原成计划详情：计划头、内容段取办理时的值，修订号 / 状态 / 阶段进度仍是现值（它们是审批进度，不是内容）。
 * 披露上限：不在 sections 里的段放空，目标里的任务 / 目标回顾也按段取舍。
 */
export function frozenDetail(live: PlanDetail, content: IdpStageContent): PlanDetail {
  const allowed = new Set<Section>(content.sections);
  const goals: GoalView[] = allowed.has('goals')
    ? content.goals.map((goal) => ({
        ...goal,
        tasks: allowed.has('tasks') ? goal.tasks : [],
        reviews: allowed.has('goalReviews') ? goal.reviews : [],
      }))
    : [];
  return {
    ...live,
    ...content.plan,
    modules: content.modules,
    goals,
    analyses: allowed.has('analyses') ? content.analyses : [],
    reviews: allowed.has('reviews') ? content.reviews : [],
    keyInfo: allowed.has('keyInfo') ? content.keyInfo : NO_KEY_INFO,
  };
}

/** 已办读取只给只读呈现：参与人字段集，节点按钮为空。 */
const READ_ONLY: PlanViewer = { kind: 'participant', at: { participant: true, stage: null, nodeKey: null } };

/**
 * 计划详情与审批中心详情共用的办理份呈现（P2-3：两个入口读到同一份内容）。
 * 已办的 HR 也按办理份读（办理人的权限不因另有管理员身份放宽，DEC-801 D2），关键信息仍按当前权限裁剪。
 */
export function presentFrozen(
  tx: Tx,
  tenantId: string,
  live: PlanDetail,
  ext: unknown,
  stageId: string,
  projections: Projections,
) {
  return presentPlan(tx, tenantId, frozenDetail(live, parseIdpStageContent(ext, stageId)), READ_ONLY, projections);
}
