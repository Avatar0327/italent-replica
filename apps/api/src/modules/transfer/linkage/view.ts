/**
 * 联动详情（AC-LNK-04 失败明细），按当前操作人的权限裁剪（PR #74 第二轮 P1-3，AGENTS.md §10「权限」）：
 * 任职侧联动按任职对象的字段查看权（TRANSFER_LINKAGE_FIELDS）；合同部分另须合同对象的查看权、对目标合同的范围
 * （含“我创建的”）与合同字段查看权。无权的部分不返回，不以空值暗示其存在。
 */
import { and, eq, sql, transferHandovers, transferLinkageItems, transferOnTrials, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { checkScope } from '../../contracts/context.js';
import { loadEmploymentBusiness } from '../../employment/read-model.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import type { ModuleScope } from '../../permission/module-access.js';
import type { LinkageOptions } from './input.js';
import { itemView, type LinkageItemRow } from './items.js';
import { latestLinkage } from './store.js';

export interface LinkageVisibility {
  /** 任职对象可查看字段；undefined = 全部可见。 */
  readonly employmentFields: ReadonlySet<string> | undefined;
  readonly contract: {
    readonly visible: boolean;
    readonly scope: ModuleScope | undefined;
    readonly fields: ReadonlySet<string> | undefined;
  };
}

interface RunRow {
  executedAt: string | Date;
  beforeContractId: string | null;
  afterContractId: string | null;
  salaryReminderStatus: string | null;
}

export async function readTransferLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  visibility: LinkageVisibility,
) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const business = await loadEmploymentBusiness(tx, ctx.tenantId, businessId, today, ctx.scope);
  if (!business || business.kind !== 'transfer') throw new AppError('NOT_FOUND', '调动不存在');
  const show = (code: string) => !visibility.employmentFields || visibility.employmentFields.has(code);
  const stored = await latestLinkage(tx, ctx.tenantId, businessId);
  const [run] = rowsOf<RunRow>(
    await tx.execute(sql`SELECT executed_at AS "executedAt", before_contract_id AS "beforeContractId",
      after_contract_id AS "afterContractId", salary_reminder_status AS "salaryReminderStatus"
      FROM transfer_linkage_runs WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`),
  );
  const contractTarget = stored?.options.contract?.targetId ?? run?.beforeContractId ?? null;
  const contractShown =
    show('contractChange') && (await contractVisible(tx, ctx, visibility, business.employeeId, contractTarget));
  const results = await linkageResults(tx, ctx, businessId, show);
  const executedAt = run ? new Date(run.executedAt).toISOString() : null;
  return {
    businessId,
    revision: business.revision,
    options: stored ? visibleOptions(stored.options, show, contractShown, visibility.contract.fields) : null,
    executedAt,
    contract:
      contractShown && run?.afterContractId
        ? { beforeContractId: run.beforeContractId, afterContractId: run.afterContractId }
        : null,
    ...results,
    salaryReminder:
      show('adjustSalary') && run?.salaryReminderStatus
        ? { status: run.salaryReminderStatus, createdAt: executedAt }
        : null,
  };
}

async function contractVisible(
  tx: Tx,
  ctx: EmploymentContext,
  visibility: LinkageVisibility,
  employeeId: string,
  targetId: string | null,
): Promise<boolean> {
  if (!visibility.contract.visible) return false;
  // 未勾选变更合同：有合同查看权即可看到“未变更”，无需针对具体合同判定范围。
  if (!targetId) return true;
  const [target] = rowsOf<{ createdBy: string | null }>(
    await tx.execute(sql`SELECT created_by AS "createdBy" FROM contract_records
      WHERE tenant_id=${ctx.tenantId} AND id=${targetId}::uuid`),
  );
  if (!target) return false;
  try {
    await checkScope(tx, { ...ctx, scope: visibility.contract.scope }, employeeId, target.createdBy ?? undefined);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

function visibleOptions(
  options: LinkageOptions,
  show: (code: string) => boolean,
  contractShown: boolean,
  contractFields: ReadonlySet<string> | undefined,
) {
  const contract = options.contract;
  return {
    ...(contractShown
      ? {
          contract: contract && {
            targetId: contract.targetId,
            fields: pickContractFields(contract.fields, contractFields),
          },
        }
      : {}),
    ...(show('adjustSalary') ? { adjustSalary: options.adjustSalary } : {}),
    ...(show('onTrialMonths')
      ? {
          onTrial: options.onTrial && {
            months: options.onTrial.months,
            ...(show('onTrialStartDate') ? { startDate: options.onTrial.startDate } : {}),
          },
        }
      : {}),
    ...(show('handoverPersonId') ? { handover: options.handover } : {}),
    ...(show('partTimeEnds') ? { partTimes: options.partTimes } : {}),
    ...(show('dutyTransfer') ? { dutyTransfer: options.dutyTransfer } : {}),
  };
}

function pickContractFields(fields: Readonly<Record<string, unknown>>, viewable: ReadonlySet<string> | undefined) {
  if (!viewable) return fields;
  const entries = Object.entries(fields).flatMap(([key, value]): [string, unknown][] => {
    if (key !== 'customFields') return viewable.has(key) ? [[key, value]] : [];
    const custom = Object.entries((value ?? {}) as Record<string, unknown>).filter(([id]) =>
      viewable.has(`custom:${id}`),
    );
    return custom.length ? [[key, Object.fromEntries(custom)]] : [];
  });
  return Object.fromEntries(entries);
}

async function linkageResults(tx: Tx, ctx: EmploymentContext, businessId: string, show: (code: string) => boolean) {
  const byBusiness = (table: typeof transferOnTrials | typeof transferHandovers) =>
    and(eq(table.tenantId, ctx.tenantId), eq(table.businessId, businessId));
  const [trial] = show('onTrialMonths')
    ? await tx.select().from(transferOnTrials).where(byBusiness(transferOnTrials))
    : [];
  const [handover] = show('handoverPersonId')
    ? await tx.select().from(transferHandovers).where(byBusiness(transferHandovers))
    : [];
  const items = (await tx
    .select()
    .from(transferLinkageItems)
    .where(and(eq(transferLinkageItems.tenantId, ctx.tenantId), eq(transferLinkageItems.businessId, businessId)))
    .orderBy(transferLinkageItems.lineNo)) as LinkageItemRow[];
  return {
    onTrial: trial
      ? {
          startDate: trial.startDate,
          months: trial.months,
          expectedEndDate: trial.expectedEndDate,
          status: trial.status,
        }
      : null,
    handover: handover
      ? {
          handoverPersonId: handover.handoverPersonId,
          handoverStatus: handover.handoverStatus,
          approvalStatus: handover.approvalStatus,
        }
      : null,
    dutyTransfer: show('dutyTransfer') ? dutyTransferView(items) : null,
    partTimes: show('partTimeEnds') ? items.filter((item) => item.itemType === 'part_time_end').map(itemView) : [],
  };
}

/** `21` §2 DutyTransfer：职责总数、下属员工 / 组织角色职责数、失败数，明细逐条列出。 */
function dutyTransferView(items: readonly LinkageItemRow[]) {
  const duties = items.filter((item) => item.itemType !== 'part_time_end');
  if (!duties.length) return null;
  return {
    total: duties.length,
    subordinateCount: duties.filter((item) => item.itemType === 'duty_subordinate').length,
    orgRoleCount: duties.filter((item) => item.itemType === 'duty_org_role').length,
    failedCount: duties.filter((item) => item.status === 'failed').length,
    items: duties.map(itemView),
  };
}
