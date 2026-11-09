/**
 * F-476 P4 验收夹具：任职 / 离退类审批的「办理人已办 → 人事事后改单」场景。
 * 流程只有一个指定审批人节点（审批人 A）：HR 发起并提交 → A 驳回（办理份在此时冻结）→ HR 在驳回态改单。
 * 此后 A 读三个人事详情入口（任职业务 / 离职 / 退休）应读到办理时的值；HR（发起人）读现值。
 * 内容用 ZZ_ 前缀的合成文本；断言只看业务字段值与 contentView，不依赖办理份内部形状。
 */
import { sql, withTenant } from '@italent/db';
import { APPROVAL_TYPES } from '@italent/domain';
import { expect } from 'vitest';
import { approvalWorld, type ApprovalWorld, type Person } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { installProbationSeeds, loginEmailOf } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-people-support.js';

export const EMP = '/api/tenant/employment';
export const BEFORE = 'ZZ_办理时';
export const AFTER = 'ZZ_改后';

export type ScenarioKind = 'transfer' | 'hire' | 'regularization' | 'intern_regularization' | 'leave' | 'retirement';
export const EXIT_KINDS: readonly ScenarioKind[] = ['leave', 'retirement'];

export interface Scene {
  w: ApprovalWorld;
  kind: ScenarioKind;
  approver: Person;
  subjectId: string;
  /** 退休单的交接人（办理时 / 改单后）；其余类型为空串。 */
  handover: { before: string; after: string };
  businessId: string;
  instanceId: string;
}

/** 详情响应体里本片断言用到的字段（其余字段按未知处理）。 */
export interface Body {
  status?: string;
  record?: unknown;
  fields?: Record<string, unknown>;
  employerName?: unknown;
  handoverEmployeeId?: unknown;
  contentView?: { mode: string };
  [key: string]: unknown;
}

/** 三个人事详情入口的读取结果（状态码 + 响应体）。 */
export interface Reads {
  business: { status: number; body: Body };
  exit: { status: number; body: Body };
  retirement: { status: number; body: Body };
}

/** 业务字段 → 各入口里的“可辨认值”。任职类用地点（fields.place），离退类用扩展行的 employerName。 */
export const markerOf = (kind: ScenarioKind, reads: Reads): unknown =>
  kind === 'leave'
    ? reads.exit.body.employerName
    : kind === 'retirement'
      ? reads.retirement.body.handoverEmployeeId
      : reads.business.body.fields?.place;

const createBody = (
  kind: ScenarioKind,
  dept: string,
  subject: { employeeId: string },
  handover: string,
  extra: Record<string, unknown> = {},
) => {
  const base = { mode: 'application', fields: { departmentId: dept, place: BEFORE } };
  switch (kind) {
    case 'hire':
      return { ...base, kind, effectiveDate: '2026-10-05', loginEmail: loginEmailOf(subject.employeeId) };
    case 'leave':
      return {
        mode: 'application',
        lastWorkDate: '2026-10-20',
        exit: { exitTypeCode: 'voluntary', employerName: BEFORE, ...extra },
      };
    case 'retirement':
      return { mode: 'application', lastWorkDate: '2026-10-20', exit: { handoverEmployeeId: handover, ...extra } };
    case 'regularization':
      return { ...base, kind, effectiveDate: '2026-10-05', probationResult: 'normal' };
    case 'intern_regularization':
      return { ...base, kind, effectiveDate: '2026-10-05', probation: false };
    default:
      return { ...base, kind, effectiveDate: '2026-10-05' };
  }
};

/** 创建入口：离职 / 退休走专用入口（请求体不带 kind），其余走通用任职业务入口。 */
const createPath = (kind: ScenarioKind, employeeId: string) =>
  kind === 'leave'
    ? `${EMP}/exits/employees/${employeeId}`
    : kind === 'retirement'
      ? `${EMP}/retirements/employees/${employeeId}`
      : `${EMP}/employees/${employeeId}/businesses`;

const patchBody = (kind: ScenarioKind, handover: string) =>
  kind === 'leave'
    ? { employerName: AFTER }
    : kind === 'retirement'
      ? { handoverEmployeeId: handover }
      : { fields: { place: AFTER } };

const patchPath = (kind: ScenarioKind, id: string) =>
  kind === 'leave'
    ? `${EMP}/exits/${id}`
    : kind === 'retirement'
      ? `${EMP}/retirements/${id}`
      : `${EMP}/businesses/${id}`;

/** 被办理人：入职 = 尚无任职的人员；转正 = 试用中的在职人员；实习转正 = 实习生；其余 = 在职人员。 */
async function subjectOf(w: ApprovalWorld, kind: ScenarioKind, dept: string): Promise<string> {
  if (kind === 'hire') return (await w.employee('待入职员工')).id;
  if (kind === 'intern_regularization') return (await w.person('实习员工', dept, { employType: 'intern' })).employeeId;
  if (kind !== 'regularization') return (await w.person('任职员工', dept)).employeeId;
  const created = await w.employee('试用员工');
  const hired = await w.request(w.hr.id, 'POST', `${EMP}/employees/${created.id}/businesses`, {
    ifMatch: 1,
    body: {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      probation: true,
      loginEmail: loginEmailOf(created.id),
      fields: { departmentId: dept },
    },
  });
  expect(hired.status, await hired.clone().text()).toBe(201);
  return created.id;
}

/** 直接调动（不走审批）：给被办理人留一条更早的任职记录。 */
async function directTransfer(w: ApprovalWorld, employeeId: string, at: { place: string; effectiveDate: string }) {
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${EMP}/employees/${employeeId}`),
  );
  const response = await w.request(w.hr.id, 'POST', `${EMP}/employees/${employeeId}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'transfer', mode: 'direct', effectiveDate: at.effectiveDate, fields: { place: at.place } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

/** 审批人节点的表单字段：审批人只看本节点表单里的字段（DEC-057），默认放开用例要对比的那个字段。 */
const defaultNodeForm = (kind: ScenarioKind): readonly string[] =>
  kind === 'leave'
    ? ['lastWorkDate', 'exitTypeCode', 'employerName']
    : kind === 'retirement'
      ? ['lastWorkDate', 'handoverEmployeeId']
      : ['effectiveDate', 'departmentId', 'place'];

export interface SceneOptions {
  /** 审批人 A 的办理动作，缺省驳回（驳回态可改单）；approve = 通过但未到生效日（批准不等于生效）。 */
  action?: 'reject' | 'approve';
  /** 审批人 A 所在节点的表单字段（缺省见 defaultNodeForm）。 */
  nodeForm?: readonly string[];
  /** 追加到创建请求 exit 对象里的字段（离职 / 退休）。 */
  exit?: Record<string, unknown>;
  /** 提交前先给被办理人补一条直接调动记录（生效日、地点），作为本次调动的前驱。 */
  predecessor?: { place: string; effectiveDate: string };
}

/** 建场景：发起 → 提交 → A 驳回；不改单（改单由 changeAfterHandled 单独做，便于测“办理后”时点）。 */
export async function handledScene(
  db: Parameters<typeof approvalWorld>[0],
  label: string,
  kind: ScenarioKind,
  options: SceneOptions = {},
): Promise<Scene> {
  const w = await approvalWorld(db, label);
  if (EXIT_KINDS.includes(kind)) await installExitSeeds(db, w.tenant.id);
  if (kind === 'regularization') await installProbationSeeds(db, w.tenant.id);
  const dept = await w.org('合成部门');
  const approver = await w.person('审批人A', dept);
  const code = APPROVAL_TYPES[kind].defaultProcessCode;
  await w.publishedProcess({
    approvalType: kind,
    conditions: { items: [{ no: 1, field: 'processCode', operator: 'eq', value: code }] },
    nodes: [
      {
        key: 'review',
        name: '审核',
        approver: { type: 'specified', value: approver.userId },
        formFields: options.nodeForm ?? defaultNodeForm(kind),
      },
    ],
  });
  const subjectId = await subjectOf(w, kind, dept);
  const handover = {
    before: kind === 'retirement' ? (await w.person('交接人甲', dept)).employeeId : '',
    after: kind === 'retirement' ? (await w.person('交接人乙', dept)).employeeId : '',
  };
  if (options.predecessor) await directTransfer(w, subjectId, options.predecessor);
  const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${EMP}/employees/${subjectId}`));
  const created = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', createPath(kind, subjectId), {
      ifMatch: current.revision,
      body: createBody(kind, dept, { employeeId: subjectId }, handover.before, options.exit),
    }),
    201,
  );
  const view = await w.submit(created);
  const task = w.pending(view)[0]!;
  const action = options.action ?? 'reject';
  const done = await w.taskAction(approver.userId, task.id, action, view.revision, { comment: '合成意见' });
  expect(done.status, await done.clone().text()).toBe(200);
  return { w, kind, approver, subjectId, handover, businessId: created.id, instanceId: view.id };
}

/** 发起人在驳回态下改单（审批人 A 已办理）：把可辨认值从 BEFORE 改成 AFTER。 */
export async function changeAfterHandled(scene: Scene): Promise<void> {
  const { w, kind, businessId } = scene;
  const current = await w.business(businessId);
  const response = await w.request(w.hr.id, 'PATCH', patchPath(kind, businessId), {
    ifMatch: current.revision,
    body: patchBody(kind, scene.handover.after),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

const read = async (scene: Scene, user: string, path: string) => {
  const response = await scene.w.request(user, 'GET', path);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Body) : {} };
};

/** 某人读三个人事详情入口。 */
export async function readsBy(scene: Scene, user: string): Promise<Reads> {
  const id = scene.businessId;
  return {
    business: await read(scene, user, `${EMP}/businesses/${id}`),
    exit: await read(scene, user, `${EMP}/exits/${id}`),
    retirement: await read(scene, user, `${EMP}/retirements/${id}`),
  };
}

/** 入口只对本类型有效：任职类走 business，离职走 exit（同时也能走 business），退休走 retirement（同时也能走 business）。 */
export const entriesOf = (kind: ScenarioKind): (keyof Reads)[] =>
  kind === 'leave' ? ['business', 'exit'] : kind === 'retirement' ? ['business', 'retirement'] : ['business'];

/** 办理份读取（只经 withTenant，app_owner + FORCE RLS 下可用）。 */
export async function copyTexts(scene: Scene): Promise<string[]> {
  const { w, instanceId } = scene;
  return withTenant(w.db, w.tenant.id, async (tx) =>
    resultRows<{ text: string }>(
      await tx.execute(sql`SELECT content::text AS text FROM approval_handling_contents
        WHERE instance_id = ${instanceId}::uuid ORDER BY acted_at`),
    ).map((row) => row.text),
  );
}

/** 办理时 / 改单后各入口应读到的可辨认值。 */
export const expectedMarker = (scene: Scene, phase: 'before' | 'after'): string =>
  scene.kind === 'retirement' ? scene.handover[phase] : phase === 'before' ? BEFORE : AFTER;
