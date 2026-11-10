/**
 * AC-F476-13（P4 第 2 轮审查返工，P1-1）：已办冻结读取的结构穷举。
 * 披露集合只含一个业务字段时，遍历整个响应 JSON 的每个叶子路径：除流程事实白名单与该字段外，不得有任何业务键值。
 * 覆盖生效失败场景（只有离职生效检查后续记录，退休不查，exit-activation.ts followingTransfers）：离职已批准，节点表单不含生效日，当前字段权允许看生效日（真实授权器授全部字段），
 * 定时生效因未来已落地的转正记录失败（EXIT_LATER_RECORD_EXISTS）——失败详情里的记录日期、提示文案里的日期
 * 都不是节点表单里的字段，整个业务详情不得出现节点外日期。
 * 夹具：业务数据都经真实接口创建；日期手写（离职 2026-10-20 / 生效 2026-10-21，后续转正 2026-11-10）。
 */
import { runEmploymentActivations } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  EMP,
  changeAfterHandled,
  detailEntries,
  handledScene,
  readEntries,
  realWorld,
  type Scene,
  type ScenarioKind,
} from './AC-F476-p4-support.js';
import { installProbationSeeds } from './AC-EMP-support.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();
const LATER = '2026-11-10';
const DATE = /\d{4}-\d{2}-\d{2}/;

/** 流程事实：身份、状态、版本号、动作、生效 / 撤销结果、事件、下游件数、内容来源标记（始终读现值，不是办理内容）。 */
const FACT_PATHS: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'code',
  'name',
  'revision',
  'employeeRevision',
  'status',
  'kind',
  'mode',
  'formId',
  'employeeStatus',
  'entryStatus',
  'initiator',
  'initiatorUserId',
  'batchId',
  'createdAt',
  'approvalInstanceId',
  'actions[]',
  'cancellation',
  'record',
  'events[].eventNo',
  'events[].state',
  'events[].createdAt',
  'versions[].versionNo',
  'versions[].createdAt',
  'dutyTransfer.transferred',
  'dutyTransfer.failed',
  'effects[].phase',
  'effects[].kind',
  'effects[].count',
  'activation',
  'activation.status',
  'activation.reason',
  'activation.failureCount',
  'activation.failureReason',
  'activation.blockedByBusinessId',
  'activation.lastAttemptAt',
  // 失败详情：标题、隐藏件数、动作、后续记录的标识与类型是流程事实；记录日期、提示文案里的日期是业务值
  'activation.details.title',
  'activation.details.hiddenCount',
  'activation.details.actions[]',
  'activation.details.records[].docId',
  'activation.details.records[].docNo',
  'activation.details.records[].bizType',
  'contentView.mode',
  'contentView.instanceId',
  'contentView.taskId',
  'contentView.round',
  'contentView.actedAt',
]);

/** 流程事实里的时间戳（事件时间，不是业务日期）。 */
const TIMESTAMP_PATHS: ReadonlySet<string> = new Set([
  'createdAt',
  'events[].createdAt',
  'versions[].createdAt',
  'activation.lastAttemptAt',
  'contentView.actedAt',
]);

/** 每种类型只放开一个业务字段：响应里该字段的路径。 */
const ONLY: Record<ScenarioKind, { form: string; path: string }> = {
  transfer: { form: 'place', path: 'fields.place' },
  hire: { form: 'place', path: 'fields.place' },
  regularization: { form: 'place', path: 'fields.place' },
  intern_regularization: { form: 'place', path: 'fields.place' },
  leave: { form: 'employerName', path: 'employerName' },
  retirement: { form: 'handoverEmployeeId', path: 'handoverEmployeeId' },
};

/** 叶子路径（数组写 []）与值；空对象 / 空数组不含值，不算叶子。 */
function leaves(value: unknown, path = '', out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(value)) value.forEach((item) => leaves(item, `${path}[]`, out));
  else if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key, out);
  else out.push([path, value]);
  return out;
}

function expectOnlyFacts(kind: ScenarioKind, label: string, body: unknown) {
  const allowed = ONLY[kind].path;
  const extra = leaves(body).filter(([path]) => !FACT_PATHS.has(path) && path !== allowed);
  expect(extra, `${label} 出现节点外业务键值`).toEqual([]);
  const dates = leaves(body).filter(([path, v]) => !TIMESTAMP_PATHS.has(path) && DATE.test(String(v)));
  expect(dates, `${label} 出现节点外日期`).toEqual([]);
}

describe.each(Object.keys(ONLY) as ScenarioKind[])('AC-F476-13 P4 %s：披露集合只含一个字段的结构穷举', (kind) => {
  it('驳回后改单：各入口整个响应只有流程事实与该字段', async () => {
    const scene = await handledScene(testDb().db, `f476-p4-struct-${kind}`, kind, { nodeForm: [ONLY[kind].form] });
    await changeAfterHandled(scene);
    const reads = await readEntries(scene, scene.approver.userId);
    for (const entry of detailEntries(kind)) {
      expect(reads[entry]!.status, `${kind}/${entry}`).toBe(200);
      expect(reads[entry]!.body.contentView?.mode, `${kind}/${entry}`).toBe('frozen');
      expectOnlyFacts(kind, `${kind}/${entry}`, reads[entry]!.body);
    }
  });
});

/** HR 给被办理人直接做一笔生效日在离职之后的转正：未来已落地的非调动记录，离职生效时被拦下。 */
async function laterRegularization(scene: Scene) {
  const { w, subjectId } = scene;
  await installProbationSeeds(w.db, w.tenant.id);
  const employee = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${EMP}/employees/${subjectId}`));
  const response = await w.request(w.hr.id, 'POST', `${EMP}/employees/${subjectId}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'regularization', mode: 'direct', effectiveDate: LATER, fields: {}, probationResult: 'normal' },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

/** 到离职生效日跑定时生效：因后续记录失败（批准 ≠ 生效，失败留在已批准）。 */
async function failActivation(scene: Scene) {
  const run = await runEmploymentActivations(
    scene.w.db,
    cmd(),
    { tenantId: scene.w.tenant.id },
    { clock: () => new Date('2026-10-21T01:00:00.000Z') },
  );
  expect(run.runs[0]?.activated ?? [], JSON.stringify(run)).toEqual([]);
}

async function failedScene(kind: ScenarioKind, label: string, nodeForm: readonly string[]) {
  const scene = await handledScene(testDb().db, `f476-p4-struct-fail-${label}-${kind}`, kind, {
    action: 'approve',
    nodeForm,
  });
  await laterRegularization(scene);
  await failActivation(scene);
  const real = await realWorld(scene);
  await real.grantRead(scene.approver.userId);
  await real.grantRead(scene.w.hr.id);
  return { scene, real };
}

describe('AC-F476-13 P4 leave：定时生效失败的详情不旁路', () => {
  const kind: ScenarioKind = 'leave';
  it('节点不含生效日、当前字段权允许：整个业务详情无节点外日期、无节点外业务键值', async () => {
    const { scene, real } = await failedScene(kind, 'dates', [ONLY[kind].form]);
    await real.setScope(scene.approver.userId, 'contains');
    const reads = await readEntries(scene, scene.approver.userId, detailEntries(kind), real.fetch);
    for (const entry of detailEntries(kind)) {
      const { status, body } = reads[entry]!;
      expect(status, `${kind}/${entry}`).toBe(200);
      expect(body.contentView?.mode, `${kind}/${entry}`).toBe('frozen');
      const activation = body.activation as { failureReason?: string; reason?: string } | null;
      expect(activation?.failureReason ?? activation?.reason, `${kind}/${entry} 失败原因是流程事实`).toBe(
        'EXIT_LATER_RECORD_EXISTS',
      );
      expect(JSON.stringify(body), `${kind}/${entry}`).not.toContain(LATER);
      expectOnlyFacts(kind, `${kind}/${entry}`, body);
    }
    // 对照：发起人读现值，失败详情里有后续记录的生效日
    await real.setScope(scene.w.hr.id, 'contains');
    const hr = await readEntries(scene, scene.w.hr.id, ['business'], real.fetch);
    expect(JSON.stringify(hr.business!.body)).toContain(LATER);
  });

  it('节点含最后工作日：失败提示文案嵌着现值日期，已办读取不下发文案', async () => {
    const { scene, real } = await failedScene(kind, 'message', ['lastWorkDate']);
    await real.setScope(scene.approver.userId, 'contains');
    const reads = await readEntries(scene, scene.approver.userId, detailEntries(kind), real.fetch);
    for (const entry of detailEntries(kind)) {
      const details = (reads[entry]!.body.activation as { details?: Record<string, unknown> } | null)?.details;
      expect(details, `${kind}/${entry} 失败详情仍在`).toBeDefined();
      expect(details, `${kind}/${entry}`).not.toHaveProperty('message');
      expect(JSON.stringify(details), `${kind}/${entry}`).not.toContain(LATER);
    }
  });

  it('后续记录不是本人办理的那份内容：读取人当前范围为空时只计件数，不露记录标识', async () => {
    const { scene, real } = await failedScene(kind, 'scope', [ONLY[kind].form]);
    await real.setScope(scene.approver.userId, 'contains');
    await real.setScope(scene.approver.userId, 'empty');
    const reads = await readEntries(scene, scene.approver.userId, detailEntries(kind), real.fetch);
    for (const entry of detailEntries(kind)) {
      expect(reads[entry]!.status, `${kind}/${entry}`).toBe(200);
      const details = (reads[entry]!.body.activation as { details?: Record<string, unknown> } | null)?.details;
      expect(details, `${kind}/${entry}`).toMatchObject({ hiddenCount: 1 });
      expect(details?.records ?? [], `${kind}/${entry}`).toEqual([]);
    }
  });
});
