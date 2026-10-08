/**
 * R3-T07 个人发展计划 IDP 验收夹具（docs/02_业务建模/28；REQ-IDP-001）。PR-A：发展计划流程（子流程）与发展计划模板。
 * 接口挂在 /api/tenant/idp/ 之下；缺省注入“全部允许”的授权钩子，权限用例另用真实授权器（AC-IDP-config-permissions）。
 * 子流程引用审批中心的已发布流程（IDP-R1），夹具直接用审批定义服务建 IDP 三类审批类型的流程并发布。
 */
import { randomUUID } from 'node:crypto';
import { type Db, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { type RequestOptions, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

export const IDP_NOW = new Date('2026-10-08T02:00:00.000Z');
export const IDP_BASE = '/api/tenant/idp';
const ORG_PATH = '/api/tenant/org/organizations';

export type IdpApprovalType = 'idp_plan' | 'idp_mid_review' | 'idp_final_review';

export interface SubProcessView {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly category: 'plan' | 'review' | 'evaluation';
  readonly approvalType: IdpApprovalType;
  readonly approvalProcessId: string;
  readonly startMode: 'auto' | 'manual';
  readonly startTimeType: 'fixed' | 'relative' | null;
  readonly fixedDate: string | null;
  readonly referencePoint: string | null;
  readonly startFrom: 'same_day' | 'before' | 'after' | null;
  readonly days: number | null;
  readonly ruleText: string;
}

export interface ProcessView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly orgId: string;
  readonly publicDown: boolean;
  readonly enabled: boolean;
  readonly referenced: boolean;
  readonly subProcesses: SubProcessView[];
}

export interface NodeSettingView {
  readonly subProcessId: string;
  readonly nodeKey: string;
  readonly enabled: boolean;
  readonly buttons: string[];
}

export interface ModuleView {
  readonly id: string;
  readonly moduleType: string;
  readonly name: string;
  readonly description?: string | null;
  readonly displayOrder: number;
  readonly allowCustomGoal?: boolean;
  readonly allowLibraryGoal?: boolean;
  readonly competencySource?: string | null;
  readonly goalReviewEnabled?: boolean;
  readonly taskEnabled?: boolean;
  readonly checkNoneGoal?: boolean;
  readonly nodeSettings?: NodeSettingView[];
}

export interface CommonGoalView {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly measure: string | null;
  readonly suggestion: string | null;
  readonly displayOrder: number;
}

export interface TemplateView {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description?: string | null;
  readonly orgId: string;
  readonly publicDown: boolean;
  readonly processId: string;
  readonly status: 'draft' | 'published';
  readonly referenced: boolean;
  readonly modules: ModuleView[];
  readonly commonGoals: CommonGoalView[];
}

export interface Identity {
  readonly user: string;
  readonly tenant: string;
}

type Api = ReturnType<typeof tenantApi>;

/** 经组织接口建一个组织（带版本与层级，数据范围解析需要它们）。 */
export async function createOrg(api: Api, who: Identity, name: string, parentId = who.tenant): Promise<string> {
  const response = await api.request('POST', ORG_PATH, {
    ...who,
    ifMatch: 0,
    body: { name, establishedOn: '2026-01-01', parents: { admin: { parentId } } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** 两个节点的 IDP 审批流程（制定发展目标 → 审批发展计划），可选只建草稿不发布。 */
export async function idpApprovalProcess(
  db: Db,
  who: Identity,
  approvalType: IdpApprovalType,
  options: { publish?: boolean; nodes?: readonly [string, string][] } = {},
): Promise<{ id: string; nodes: string[] }> {
  const ctx = { tenantId: who.tenant, userId: who.user, timezone: 'Asia/Shanghai', now: IDP_NOW };
  const nodes = options.nodes ?? [
    ['set_goals', '制定发展目标'],
    ['approve_plan', '审批发展计划'],
  ];
  return withTenant(db, who.tenant, async (tx) => {
    const created = await createProcess(
      tx,
      { ...ctx, commandId: randomUUID(), expectedRevision: 0 },
      { code: `IDP_${randomUUID().slice(0, 8)}`, approvalType },
      {
        name: `IDP 流程 ${approvalType}`,
        groupName: null,
        description: null,
        priority: 0,
        isFallback: true,
        exceptionAdminUserId: who.user,
        urgeEnabled: true,
        hideRecordsFromInitiator: false,
        conditions: { items: [], expression: '' },
        nodes: nodes.map(([key, name]) => ({
          key,
          name,
          approver: 'owner',
          noAssignee: 'exception_admin',
          sameAssigneeSkip: false,
          historySameAssigneeSkip: false,
          sameAssigneeResult: 'approve',
          historySameAssigneeResult: 'approve',
          formFields: [],
          editableFields: [],
          editMode: 'none',
          actions: { transfer: false, addSign: false, copySend: false, retrieve: false, urge: 'inherit' },
          rejectCommentRequired: false,
          hideRecords: false,
          rejectResubmit: 'restart',
          messageRules: [],
        })),
      },
    );
    if (options.publish !== false) {
      await publishProcess(tx, { ...ctx, commandId: randomUUID(), expectedRevision: created.revision }, created.id);
    }
    return { id: created.id, nodes: nodes.map(([key]) => key) };
  });
}

/** 子流程请求体：缺省为“制定计划、自动开启、无规则（上一阶段结束 / 计划开始即开启）”。 */
export function subProcessBody(approvalProcessId: string, extra: Record<string, unknown> = {}) {
  return {
    name: '制定计划',
    category: 'plan',
    approvalType: 'idp_plan',
    approvalProcessId,
    startMode: 'auto',
    ...extra,
  };
}

/** 一个租户 + 一名成员 + 一个组织 + 三条已发布的 IDP 审批流程，带建流程 / 模板的快捷方法。 */
export async function idpWorld(db: Db, label: string, deps: Parameters<typeof tenantApi>[1] = {}) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => IDP_NOW, ...deps });
  const as: Identity = { user: member.user.id, tenant: member.tenant.id };
  const orgId = await createOrg(api, as, `${label}人力资源部`);
  const approvals = {
    plan: await idpApprovalProcess(db, as, 'idp_plan'),
    mid: await idpApprovalProcess(db, as, 'idp_mid_review', {
      nodes: [
        ['employee_mid', '员工中期回顾'],
        ['tutor_mid', '指导人中期回顾'],
      ],
    }),
    final: await idpApprovalProcess(db, as, 'idp_final_review', {
      nodes: [
        ['employee_final', '员工期末回顾'],
        ['tutor_final', '指导人期末回顾'],
      ],
    }),
  };
  const request = (method: string, path: string, options: RequestOptions = {}, who: Identity = as) =>
    api.request(method, `${IDP_BASE}${path}`, { ...options, ...who });

  async function created<T>(path: string, body: unknown, who: Identity = as, ifMatch = 0): Promise<T> {
    const response = await request('POST', path, { ifMatch, body }, who);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  }

  async function read<T>(path: string, who: Identity = as): Promise<T> {
    const response = await request('GET', path, {}, who);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  }

  /** 三段流程：制定计划（自动、无规则）→ 中期回顾（手动）→ 期末回顾（上一阶段结束后 7 天自动开启）。 */
  const threeStages = () => [
    subProcessBody(approvals.plan.id),
    subProcessBody(approvals.mid.id, {
      name: '中期回顾',
      category: 'review',
      approvalType: 'idp_mid_review',
      startMode: 'manual',
    }),
    subProcessBody(approvals.final.id, {
      name: '期末回顾',
      category: 'evaluation',
      approvalType: 'idp_final_review',
      startTimeType: 'relative',
      referencePoint: 'previous_end',
      startFrom: 'after',
      days: 7,
    }),
  ];

  const process = (extra: Record<string, unknown> = {}, who: Identity = as) =>
    created<ProcessView>('/processes', { name: '年度发展流程', orgId, subProcesses: threeStages(), ...extra }, who);

  const template = (processId: string, extra: Record<string, unknown> = {}, who: Identity = as) =>
    created<TemplateView>(
      '/templates',
      { name: `发展计划模板${randomUUID().slice(0, 6)}`, orgId, processId, ...extra },
      who,
    );

  /** 在模板上加一个模块（If-Match = 模板 revision），返回新的模板视图。 */
  const addModule = async (template: TemplateView, body: Record<string, unknown>, who: Identity = as) =>
    created<TemplateView>(`/templates/${template.id}/modules`, body, who, template.revision);

  return { ...member, api, as, orgId, approvals, request, created, read, process, template, addModule, threeStages };
}

export type IdpWorld = Awaited<ReturnType<typeof idpWorld>>;
