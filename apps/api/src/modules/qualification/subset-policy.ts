/**
 * 任职资格子集的策略（R3-T02 C1-1，设计 §4.1；P0 钩子 registerSubsetPolicy，拆分方案第 3、5 节）：
 * - 自助不开放 🟡（Q-M0-133 剩余，取证后另改）：beforeRequest 一律 403（首次提交与同单重提都在写申请之前拦下），
 *   beforeSave 对 self_service 来源同样 403，作为落地前复核；
 * - SW74 关闭时 is_auto_sync = true 的行不可改删（409 QUALIFICATION_SUBSET_LOCKED）：按当前开关实时判断、不存快照
 *   （DEC-331③ 追溯）。只约束人工入口（HR 直写、信息采集）；任职同步 / 初始化 / 评定发布是系统来源，不受 HR 开关约束；
 * - 类别 / 级别须对操作人可见（DEC-352：有对象查看权即可见，不再按范围）且启用，只校验新引用（新增，或改了类别 / 级别）：
 *   走 assertQualificationRefs。系统来源的类别 / 级别由各自入口（C1-4 映射、C1-5 初始化、C2-8 发布）产生，不是操作人
 *   选的，这里只靠外键保证引用存在。
 * 取锁限制（P0 subset-policy.ts）：钩子在员工锁之后调用，只做读取与判断，不取新的员工锁，拒绝时抛错、不写数据。
 *
 * 钩子的签名里没有授权器，所以在装配路由时由 bindQualificationSubsetPolicy 绑定（最近一次装配的 deps 生效）；
 * 未绑定时人工来源 fail-closed（503）。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import type { PersonnelContext, Row } from '../personnel/store.js';
import { registerSubsetPolicy, type SubsetSaveCheck } from '../personnel/subset-policy.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import {
  assertQualificationRefs,
  codeOf,
  type QualificationRefAccess,
  type QualificationRefObject,
  type QualificationRefs,
} from './access.js';
import './settings.js';

type PolicyDeps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

let bound: PolicyDeps | null = null;

/** 绑定授权器与时钟（装配路由时调用）；测试可重绑以模拟不同的查看权。 */
export function bindQualificationSubsetPolicy(deps: PolicyDeps): void {
  bound = { authorize: deps.authorize, clock: deps.clock };
}

const SELF_SERVICE_CLOSED = () =>
  new AppError('FORBIDDEN', '员工暂不能自助修改任职资格', { reason: 'QUALIFICATION_SELF_SERVICE_CLOSED' });

/** 人工入口：HR 直写与信息采集（系统来源见文件头）。 */
const isHuman = (source: SubsetSaveCheck['source']) => source.type === 'hr_direct' || source.type === 'info_collection';

async function assertAutoSyncEditable(tx: Tx, ctx: PersonnelContext): Promise<void> {
  const setting = await readEffectiveSetting(tx, ctx.tenantId, 'qualification.auto_sync_editable');
  // 只认明确的 true；其他值一律按锁定处理（fail-closed）
  if (setting.value === true) return;
  throw new AppError('CONFLICT', '自动同步生成的任职资格记录不允许修改或删除', {
    reason: 'QUALIFICATION_SUBSET_LOCKED',
  });
}

function requireText(row: Row, field: 'categoryId' | 'levelId' | 'startDate'): void {
  if (typeof row[field] !== 'string' || row[field] === '') {
    throw new AppError('VALIDATION_FAILED', '任职类别、任职级别和开始日期必填', { reason: 'FIELD_REQUIRED', field });
  }
}

/** 新引用：新增，或相对修改前换了类别 / 级别（已有引用在配置停用后照常保留，DEC-281⑧）。 */
function newRefs(before: Row | null, row: Row): QualificationRefs {
  const changed = (field: 'categoryId' | 'levelId') => (before?.[field] === row[field] ? [] : [String(row[field])]);
  return { categoryIds: changed('categoryId'), levelIds: changed('levelId') };
}

async function assertRefs(tx: Tx, ctx: PersonnelContext, refs: QualificationRefs): Promise<void> {
  if (!refs.categoryIds?.length && !refs.levelIds?.length) return;
  if (!bound) throw new AppError('SERVICE_UNAVAILABLE', '任职资格子集策略未就绪');
  const authorize = authorizeInTransaction(bound.authorize, tx);
  const scopes: Partial<
    Record<QualificationRefObject, Awaited<ReturnType<typeof resolveModuleScopeInTransaction>> | null>
  > = {};
  for (const [object, ids] of [
    ['category', refs.categoryIds],
    ['level', refs.levelIds],
  ] as const) {
    if (!ids?.length) continue;
    const code = codeOf(object);
    const visible = await authorize({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      timezone: ctx.timezone,
      action: 'object.view',
      resource: code,
      fields: [],
    });
    scopes[object] = visible ? await resolveModuleScopeInTransaction(bound, ctx, tx, code) : null;
  }
  const access: QualificationRefAccess = { ctx, scopes };
  await assertQualificationRefs(tx, access, refs);
}

registerSubsetPolicy('qualification', {
  beforeRequest: async () => {
    throw SELF_SERVICE_CLOSED();
  },
  beforeSave: async (tx, ctx, { before, row, deleted, source }) => {
    if (source.type === 'self_service') throw SELF_SERVICE_CLOSED();
    const human = isHuman(source);
    if (human && before?.isAutoSync === true) await assertAutoSyncEditable(tx, ctx);
    if (deleted) return;
    requireText(row, 'categoryId');
    requireText(row, 'levelId');
    requireText(row, 'startDate');
    // 未显式给出时的缺省：任职同步生成的行是自动同步数据，其余（手工 / 初始化 / 评定）不是（规格 23 §10 IfAutoSync）
    row.isAutoSync ??= source.type === 'employment_sync';
    if (human) await assertRefs(tx, ctx, newRefs(before, row));
  },
});
