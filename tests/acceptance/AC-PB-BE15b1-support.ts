/**
 * BE-15b1 试用期考核验收夹具（docs/02_业务建模/29 PB-R3～R6、PB-R9）：在审批中心夹具（approvalWorld）上建考核部门、
 * 部门里的直接上级和若干试用员工，以可信方式安装并发布考核两类与转正的预置流程（与开通时 provisioning 同一路径），
 * 考核与转正走真实接口，审批走真实审批中心接口（员工自评 → 经理评价）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { expect } from 'vitest';
import { installPresets, publishProcess, replaceDraft } from '../../apps/api/src/modules/approval/definitions.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { approvalWorld, type InstanceView, type Person } from './AC-APV-support.js';
import { uniqueSuffix } from './support/unique.js';

const EMPLOYMENT = '/api/tenant/employment';
const SETTINGS = '/api/tenant/settings';
export const PARALLEL_KEYS = {
  probation: 'probation.assessment_parallel.probation_assessment',
  regularization: 'probation.assessment_parallel.regularization_assessment',
} as const;

export interface AssessmentView {
  readonly id: string;
  readonly employeeId: string;
  readonly assessmentType: string;
  readonly assessmentName: string;
  readonly assessmentDate: string;
  readonly selfEvaluation: string | null;
  readonly managerRating: string | null;
  readonly regularizationOpinion: string | null;
  readonly regularizationDate: string | null;
  readonly status: string;
  readonly regularizationBusinessId: string | null;
  readonly revision: number;
}

export interface LaunchReceipt {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly items: readonly {
    readonly employeeId: string;
    readonly status: 'succeeded' | 'failed';
    readonly assessmentId: string | null;
    readonly assessmentStatus: string | null;
    readonly error: { readonly code: string; readonly message: string; readonly details?: { reason?: string } } | null;
  }[];
}

async function publishPresets(db: Db, tenantId: string, userId: string, exceptionAdmin: string, types: string[]) {
  await withTenant(db, tenantId, async (tx) => {
    const ctx = { tenantId, userId, timezone: 'Asia/Shanghai', now: new Date(), commandId: randomUUID() };
    for (const installed of await installPresets(tx, { ...ctx, expectedRevision: 0 })) {
      if (!types.includes(installed.approvalType)) continue;
      const preset = PRESET_PROCESSES.find((p) => p.presetKey === installed.presetKey)!;
      const definition = { ...preset.definition, exceptionAdminUserId: exceptionAdmin };
      const draft = await replaceDraft(tx, { ...ctx, expectedRevision: installed.revision }, installed.id, definition);
      await publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, installed.id);
    }
  });
}

export async function assessmentWorld(db: Db, label: string) {
  const w = await approvalWorld(db, `pb15b1-${label}`);
  // 试用结果字典的预置项（DEC-361 种子）：新租户开通即装，夹具按模块补装
  await withTenant(db, w.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: w.tenant.id, actorUserId: null, now: new Date(), commandId: randomUUID() },
      { modules: ['employment-probation'] },
    ),
  );
  const department = await w.org(`考核部门${uniqueSuffix()}`);
  const manager = await w.person('直接上级', department);
  await publishPresets(db, w.tenant.id, w.hr.id, w.exceptionAdmin, [
    'probation_assessment',
    'regularization_assessment',
    'regularization',
  ]);

  /** 试用员工：入职 2026-09-01，试用到 endDate（预计结束日），账号已绑定，直线经理 = manager。 */
  async function probationer(name: string, options: { endDate?: string; manager?: Person | null } = {}) {
    const userId = await w.member(name);
    const created = await w.employee(name);
    await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO permission_user_person_links(tenant_id, user_id, employee_id)
        VALUES (${w.tenant.id}, ${userId}::uuid, ${created.id}::uuid)`),
    );
    const directManager = options.manager === undefined ? manager : options.manager;
    const body = {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: {
        employType: 'internal',
        departmentId: department,
        ...(directManager ? { directManagerId: directManager.employeeId } : {}),
      },
      probation: true,
      probationEndDate: options.endDate ?? '2026-11-30',
    };
    const hired = await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${created.id}/businesses`, {
      ifMatch: 1,
      body,
    });
    expect(hired.status, await hired.clone().text()).toBe(201);
    return { userId, employeeId: created.id, name } satisfies Person;
  }

  const employeeRevision = async (employeeId: string) =>
    (await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${employeeId}`)))
      .revision;

  async function launchRaw(
    type: 'probation' | 'regularization',
    people: readonly Person[],
    extra: Record<string, unknown> = {},
  ) {
    const items = [];
    for (const person of people) items.push({ employeeId: person.employeeId, revision: await employeeRevision(person.employeeId) });
    return w.request(w.hr.id, 'POST', `${EMPLOYMENT}/probation-assessments`, {
      body: { assessmentType: type, assessmentName: `${type}-考核`, assessmentDate: '2026-10-01', items, ...extra },
    });
  }
  async function launch(type: 'probation' | 'regularization', person: Person) {
    const receipt = await w.json<LaunchReceipt>(await launchRaw(type, [person]));
    expect(receipt.items[0], JSON.stringify(receipt)).toMatchObject({ status: 'succeeded' });
    return receipt.items[0]!.assessmentId!;
  }
  const get = async (id: string) =>
    w.json<AssessmentView>(await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/probation-assessments/${id}`));
  const patchRaw = (id: string, ifMatch: number, body: Record<string, unknown>) =>
    w.request(w.hr.id, 'PATCH', `${EMPLOYMENT}/probation-assessments/${id}`, { ifMatch, body });
  const instance = (assessmentId: string): Promise<InstanceView> => w.instanceOf(assessmentId, w.hr.id);

  async function decide(
    assessmentId: string,
    actor: Person,
    action: 'approve' | 'disagree' | 'reject',
    fields?: Record<string, unknown>,
  ) {
    const view = await instance(assessmentId);
    const task = w.pending(view).find((t) => t.assigneeUserId === actor.userId);
    expect(task, `${actor.name} 没有待办`).toBeDefined();
    const response = await w.taskAction(actor.userId, task!.id, action, view.revision, {
      comment: '合成意见',
      ...(fields ? { fields } : {}),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  /** 员工自评 → 经理评价走完审批（经理在同意时填写评价、转正意见与转正日期，“编辑并同意”）。 */
  async function complete(
    assessmentId: string,
    person: Person,
    evaluation: Record<string, unknown> = {},
    selfEvaluation = '自评：完成情况良好',
  ) {
    await decide(assessmentId, person, 'approve', { selfEvaluation });
    await decide(assessmentId, manager, 'approve', evaluation);
  }

  const probationDetail = async (employeeId: string, asOf = '2026-10-01') =>
    w.json<{
      regularizationDate: string | null;
      regularizationState: string | null;
      regularizationBusinessId: string | null;
      probationResult: string | null;
      records: { kind: string; effectiveDate: string; employeeStatus: number }[];
    }>(await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${employeeId}/probation?asOf=${asOf}`));
  async function view(name: string, query = '') {
    const response = await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/probation-views?view=${name}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: Record<string, unknown>[] };
  }

  async function setParallel(key: keyof typeof PARALLEL_KEYS, value: unknown) {
    const path = `${SETTINGS}/${PARALLEL_KEYS[key]}`;
    const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', path));
    return w.request(w.hr.id, 'PUT', path, { ifMatch: current.revision, body: { value } });
  }

  /** 调整试用信息 / 转正申请 / 直接转正：返回原始响应或回执，用来断言 PB-R9 互斥。 */
  async function adjustRaw(employeeId: string) {
    return w.request(w.hr.id, 'PUT', `${EMPLOYMENT}/employees/${employeeId}/probation`, {
      ifMatch: await employeeRevision(employeeId),
      body: { hasProbation: true, startDate: '2026-09-01', months: 3, expectedEndDate: '2026-11-30' },
    });
  }
  async function regularizeRaw(person: Person, mode: 'direct' | 'application') {
    return w.request(w.hr.id, 'POST', `${EMPLOYMENT}/regularizations`, {
      body: {
        mode,
        probationResult: 'normal',
        effectiveDate: '2026-12-01',
        items: [{ employeeId: person.employeeId, revision: await employeeRevision(person.employeeId) }],
      },
    });
  }

  return {
    ...w,
    department,
    manager,
    probationer,
    employeeRevision,
    launchRaw,
    launch,
    get,
    patchRaw,
    instance,
    decide,
    complete,
    probationDetail,
    view,
    setParallel,
    adjustRaw,
    regularizeRaw,
  };
}

export type AssessmentWorld = Awaited<ReturnType<typeof assessmentWorld>>;
export const reasonOf = async (response: Response) => {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
};
