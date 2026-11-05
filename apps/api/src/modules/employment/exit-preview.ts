/**
 * 离职预览（R2-T03 设计 §4 preview 行）：只读给出按这个最后工作日创建时会遇到的情况，不抛业务拒绝、不写任何数据。
 * - blockers：创建会被拒的原因（未办结离职 / §8A 逾期迟到调动 / §8B 转正在途）；
 * - ack：§8 在途调动确认清单与令牌（创建时带回 exit.pendingTransferAck）；
 * - warnings：生效时将被作废的在途任职申请（DEC-496①；超过 VOID_LIMIT 时改为只提示 EXIT_APPLICATIONS_TOO_MANY，F-237）、
 *   已落地且晚于最后工作日的直接调动（DEC-263②）、
 *   在途考核（F-229，DEC-617，只在有在途考核时追加在末尾；确认令牌覆盖它，见 exit-gate.ts）、
 *   将终止的个人信息类流程（F-400 EXIT_FLOWS_TO_TERMINATE，只在有时追加；候选取自 exit-flow-candidates.ts，令牌覆盖它）。
 *   将终止 / 删除的合同与将撤回的在途合同申请（EXIT_CONTRACTS_TO_HANDLE）、将结束的兼职与将作废的兼职申请
 *   （EXIT_PART_TIMES_TO_END，F-429），选择与生效时同函数（exit-preview-effects.ts），只提示、不进确认令牌。
 * 清单逐项按 DEC-177 可见性与字段查看权裁剪（disclose），不可见的只计件数；合同类另按合同对象查看权裁剪（§9.1）。
 */
import type { Tx } from '@italent/db';
import { dayAfter } from './fields.js';
import {
  disclose,
  batchDisclose,
  assessmentNoticeItems,
  inFlightApplications,
  leavesInProgress,
  overdueTransferBlocker,
  pendingTransferAckSet,
  regularizationBlocker,
  untickedEmploymentKeep,
  type InFlight,
} from './exit-gate.js';
import { contractExitWarning, partTimeExitWarning } from './exit-preview-effects.js';
import { discloseFlows } from './exit-flow-candidates.js';
import { trimWith, type ExitViewable } from './exit-queries.js';
import { previewRetirement as retirementPreview } from './retirement-application.js';
import { previewRehire } from './retirement-rehire.js';
import { RETIREMENT_RESPONSE_DEPENDENCIES } from './retirement-views.js';
import { exceedsVoidLimit, VOID_LIMIT, voidCandidates } from './exit-void-applications.js';
import type { EmploymentContext } from './types.js';

async function rehirePreview(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  input: { reEmployed?: unknown; rehire?: unknown },
) {
  const preview = await previewRehire(tx, ctx, employeeId, lastWorkDate, input);
  return preview ? { rehire: preview } : {};
}

const asRows = (rows: readonly InFlight[], date: (row: InFlight) => string = (row) => row.planned) =>
  rows.map((row) => ({ id: row.id, effectiveDate: date(row), departmentId: row.departmentId }));

/** F-301：调用方漏传 / 错传属于内部错误，必须在读取业务数据前失败。 */
function assertRetirementView(retirementView: ExitViewable) {
  if (
    retirementView === null ||
    typeof retirementView !== 'object' ||
    typeof retirementView.employee !== 'function' ||
    typeof retirementView.employment !== 'function'
  ) {
    throw new Error('previewExit 必须显式传入有效的 retirementView');
  }
}

export async function previewExit(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  retirementView: ExitViewable,
  rehire: { reEmployed?: unknown; rehire?: unknown } = {},
  // F-314：退休预览与执行同口径，在 LIMIT 前排除应保留的等待返聘（voidInFlightApplications 按退休单判断）
  kind: 'leave' | 'retirement' = 'leave',
) {
  assertRetirementView(retirementView);
  const blockers = [];
  const leaves = await leavesInProgress(tx, ctx, employeeId);
  if (leaves.length)
    blockers.push({ reason: 'EXIT_IN_PROGRESS', ...(await disclose(tx, ctx, employeeId, asRows(leaves))) });
  const overdue = await overdueTransferBlocker(tx, ctx, employeeId);
  if (overdue) blockers.push({ reason: 'EXIT_LATE_TRANSFER_PENDING', ...overdue });
  const regularization = await regularizationBlocker(tx, ctx, employeeId, lastWorkDate, 'direct', kind);
  if (regularization) blockers.push({ reason: 'EXIT_REGULARIZATION_IN_FLIGHT', ...regularization });
  const set = await pendingTransferAckSet(tx, ctx, employeeId, lastWorkDate, kind);
  // 已批准且计划生效日 ≤ 最后工作日的申请会先于离职落地（§5.0 队列），不在作废之列；条件在 SQL 里过滤（与生效时同一入口）
  const voided = await voidCandidates(
    tx,
    ctx,
    employeeId,
    lastWorkDate,
    undefined,
    kind === 'retirement'
      ? { effectiveDate: dayAfter(lastWorkDate), reEmployed: rehire.reEmployed === true }
      : undefined,
    await untickedEmploymentKeep(tx, ctx, lastWorkDate, kind),
  );
  const assessments = set?.assessments ?? [];
  const flows = set?.flows.length ? await discloseFlows(tx, ctx, set.flows) : null;
  // 确认清单超上限时不给令牌（不能确认被截断的集合）；上方 warnings 已提示 EXIT_APPLICATIONS_TOO_MANY（F-241）
  const ack = set && !set.tooMany ? set : null;
  const landed = await inFlightApplications(tx, ctx, employeeId, ['transfer'], ['effective'], null, {
    landedEffectiveAfter: lastWorkDate,
  });
  return {
    lastWorkDate,
    effectiveDate: dayAfter(lastWorkDate),
    // R2-T04 §3.1：P 与退休类型按详情 / 列表同一张路径表裁剪（F-266）；离职入口显式传空可见性（F-301）。
    ...trimWith(
      RETIREMENT_RESPONSE_DEPENDENCIES,
      await retirementPreview(tx, ctx, employeeId, lastWorkDate),
      retirementView,
    ),
    // 同时返聘（5b）：返聘日与创建时会遇到的问题；没带 reEmployed + rehire 时没有这一块
    ...(await rehirePreview(tx, ctx, employeeId, lastWorkDate, rehire)),
    blockers,
    ack: ack
      ? {
          ackToken: ack.hash,
          ...(await batchDisclose(tx, ctx, employeeId, ack.rows)),
          ...(assessments.length ? { assessments: await assessmentNoticeItems(tx, ctx, employeeId, assessments) } : {}),
          ...(flows ? { flows } : {}),
        }
      : null,
    warnings: [
      // 超上限时生效会整单拒绝：只提示上限，不列条目也不带数量（披露口径；disclose 本身也以 1000 为上限）
      exceedsVoidLimit(voided)
        ? { reason: 'EXIT_APPLICATIONS_TOO_MANY', limit: VOID_LIMIT }
        : { reason: 'EXIT_APPLICATIONS_TO_VOID', ...(await disclose(tx, ctx, employeeId, asRows(voided))) },
      {
        reason: 'EXIT_FUTURE_TRANSFER_LANDED',
        ...(await batchDisclose(
          tx,
          ctx,
          employeeId,
          asRows(landed, (row) => row.effectiveDate),
        )),
      },
      ...(assessments.length
        ? [{ reason: 'IN_FLIGHT_ASSESSMENT', ...(await assessmentNoticeItems(tx, ctx, employeeId, assessments)) }]
        : []),
      ...(flows ? [{ reason: 'EXIT_FLOWS_TO_TERMINATE', ...flows }] : []),
      ...(await contractExitWarning(tx, ctx, employeeId, lastWorkDate, kind)),
      ...(await partTimeExitWarning(tx, ctx, employeeId, lastWorkDate, kind)),
    ],
  };
}
