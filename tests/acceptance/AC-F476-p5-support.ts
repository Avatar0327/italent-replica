/**
 * F-476 P5 验收夹具（合同 / 子集 / 兼职）：三个模块共用的“办理 → 事后被改 → 已办人读”流程。
 * 夹具造的都是后端真实形状（真路由 + 真审批中心动作），不手写响应形状；数据一律合成（ZZ_ 前缀、example.com）。
 * 所有租户数据读写都在 withTenant 内，app_owner（FORCE RLS）下同样成立。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Tx } from '@italent/db';
import { APPROVAL_INSTANCE_OBJECT, PRESET_PROCESSES, SUBSETS, type SubsetKind } from '@italent/domain';
import { expect } from 'vitest';
import { approvalWorld, type ApprovalWorld, type InstanceView, type Person } from './AC-APV-support.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { type RequestOptions, tenantApi } from './support/tenant-api.js';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';

export const BASE = '/api/tenant/approval';
export const CONTRACTS = '/api/tenant/contracts';

/** 审批中心之外各入口返回的 contentView（办理时冻结 / 现值）。 */
export interface ContentView {
  mode: 'frozen' | 'live';
  instanceId: string;
  taskId: string | null;
  round: number | null;
  actedAt: string | null;
}

export interface Reply {
  status: number;
  body: Record<string, unknown> & { contentView?: ContentView };
}

export async function get(w: ApprovalWorld, user: string, path: string): Promise<Reply> {
  const res = await w.request(user, 'GET', path);
  return { status: res.status, body: (await res.json()) as Reply['body'] };
}

/** 业务单对应的最新审批实例（同一业务单可能有多个实例，取最新）。 */
export async function latestInstance(w: ApprovalWorld, type: string, businessId: string): Promise<InstanceView> {
  const [row] = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id::text FROM approval_instances
        WHERE business_type = ${type} AND business_id = ${businessId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`),
    ),
  );
  expect(row, `${type} 单 ${businessId} 没有审批实例`).toBeDefined();
  return w.detail(row!.id);
}

/** 某人在实例上的待办动作；没有待办时直接让用例失败。 */
export async function act(
  w: ApprovalWorld,
  instanceId: string,
  actor: Person,
  action: 'approve' | 'reject' | 'disagree',
  fields?: Record<string, unknown>,
): Promise<void> {
  const view = await w.detail(instanceId);
  const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === actor.userId);
  expect(task, `${actor.name} 在 ${view.currentNodeKey} 没有待办`).toBeDefined();
  const res = await w.taskAction(actor.userId, task!.id, action, view.revision, {
    comment: '合成意见',
    ...(fields ? { fields } : {}),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** 发起人在审批中心对被驳回的单据同单修正重提（DEC-099）。 */
export async function resubmit(w: ApprovalWorld, instanceId: string, user: string, fields: Record<string, unknown>) {
  const view = await w.detail(instanceId);
  const res = await w.instanceAction(user, instanceId, 'resubmit', view.revision, { fields });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** 两个指定审批人节点（n1 → n2，都有同意 / 不同意出口），按审批类型装配并发布，覆盖预置流程的节点。 */
export async function installTwoNodes(w: ApprovalWorld, prefix: string, n1: Person, n2: Person): Promise<void> {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    for (const preset of PRESET_PROCESSES.filter((p) => p.approvalType.startsWith(prefix))) {
      const ctx = {
        tenantId: w.tenant.id,
        userId: w.hr.id,
        timezone: 'Asia/Shanghai',
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      const base = preset.definition.nodes[0]!;
      const created = await createProcess(tx, ctx, { code: preset.code, approvalType: preset.approvalType }, {
        ...preset.definition,
        exceptionAdminUserId: w.exceptionAdmin,
        nodes: [n1, n2].map((p, i) => ({
          ...base,
          key: `n${i + 1}`,
          name: `审批${i + 1}`,
          kind: 'single' as const,
          approver: { type: 'specified' as const, value: p.userId },
          exits: ['approve', 'disagree'] as const,
        })),
      } as never);
      await publishProcess(tx, { ...ctx, expectedRevision: created.revision }, created.id);
    }
  });
}

/** 合同世界：审批世界 + 合同主数据 + 一个在职员工 + 两个审批人（合同类流程已装为 n1 → n2）。 */
export async function contractScene(db: Parameters<typeof approvalWorld>[0], label: string) {
  const w = await approvalWorld(db, label);
  const dept = await w.org(`ZZ_合同部门`);
  const [n1, n2] = [await w.person('ZZ_审批一', dept), await w.person('ZZ_审批二', dept)];
  const subject = await w.person('ZZ_合同员工', dept);
  await installTwoNodes(w, 'contract_', n1, n2);
  const master = async (kind: string, name: string) => {
    const res = await w.request(w.hr.id, 'POST', `${CONTRACTS}/master-data/${kind}`, {
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string };
  };
  const type = await master('types', 'ZZ_劳动合同');
  const company = await master('companies', 'ZZ_合成法人公司');
  const base = {
    typeId: type.id,
    companyId: company.id,
    effectiveDate: '2025-01-01',
    endDate: '2026-09-30',
    termType: 'fixed',
    termMonths: 21,
    signingDate: '2024-12-20',
  };
  async function command(body: Record<string, unknown>, ifMatch: number) {
    return w.request(w.hr.id, 'POST', `${CONTRACTS}/commands`, { ifMatch, body });
  }
  /** 直接生效的存量合同。 */
  async function direct(extra: Record<string, unknown> = {}) {
    const res = await command(
      { operation: 'create', mode: 'direct', employeeId: subject.employeeId, fields: { ...base, ...extra } },
      0,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; revision: number; endDate: string | null };
  }
  /** 四种申请（create 无目标合同）；返回申请单 id。 */
  async function apply(
    operation: 'create' | 'renew' | 'change' | 'terminate',
    fields: Record<string, unknown>,
    target?: { id: string; revision: number },
  ) {
    const res = await command(
      {
        operation,
        mode: 'application',
        employeeId: subject.employeeId,
        ...(target ? { targetId: target.id } : {}),
        fields: operation === 'create' ? { ...base, ...fields } : fields,
      },
      target?.revision ?? 0,
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; revision: number };
  }
  const requestPath = (id: string) => `${CONTRACTS}/requests/${id}`;
  return { w, dept, n1, n2, subject, base, direct, apply, requestPath };
}

/** 办理 → 事后被改：n1 同意、n2 驳回，发起人带修正重提；返回实例 id。 */
export async function handledThenResubmitted(
  s: Pick<Awaited<ReturnType<typeof contractScene>>, 'w' | 'n1' | 'n2'>,
  type: string,
  businessId: string,
  corrections: Record<string, unknown>,
): Promise<string> {
  const { w, n1, n2 } = s;
  const instance = await latestInstance(w, type, businessId);
  await act(w, instance.id, n1, 'approve');
  await act(w, instance.id, n2, 'reject');
  await resubmit(w, instance.id, w.hr.id, corrections);
  return instance.id;
}

export const PERSONNEL = '/api/tenant/personnel';

/** 子集里前两个自助可改的字段（文本优先，没有文本字段的子集退到日期字段）：第一个做「被改的」，第二个做「不变的」。 */
export function textFieldsOf(subset: SubsetKind): string[] {
  const writable = SUBSETS[subset].fields.filter((f) => !('system' in f && f.system));
  const plain = writable.filter((f) => f.kind === 'text');
  return (plain.length >= 2 ? plain : [...plain, ...writable.filter((f) => f.kind === 'date')])
    .slice(0, 2)
    .map((f) => f.code);
}

/** 区分办理时与事后内容的字段（自助可改、不依赖字典）；见 textFieldsOf。 */
export function textFieldOf(subset: SubsetKind): string {
  return textFieldsOf(subset)[0]!;
}

const DATES: Readonly<Record<string, string>> = {
  原值: '2024-01-01',
  办理时: '2024-02-01',
  改后: '2024-03-01',
  第二次: '2024-04-01',
};
/** 该子集的区分字段在某个阶段的取值：文本字段 `ZZ_<阶段>`，日期字段取固定日期。 */
export function val(subset: SubsetKind, stage: '原值' | '办理时' | '改后' | '第二次'): string {
  const kind = SUBSETS[subset].fields.find((f) => f.code === textFieldOf(subset))!.kind;
  return kind === 'date' ? DATES[stage]! : `ZZ_${stage}`;
}

/** 员工信息变更世界：每个子集开放自助字段，个人信息变更流程为 n1 → n2（兜底流程）。 */
/** sameAssigneeSecond：第 2 节点也由审批一办理，并开同人自动同意（同一命令里引擎写系统份，F-476 P8 合 main 核对）。 */
export async function personnelScene(
  db: Parameters<typeof approvalWorld>[0],
  label: string,
  options: { sameAssigneeSecond?: boolean } = {},
) {
  const w = await approvalWorld(db, label);
  const dept = await w.org('ZZ_子集部门');
  const [n1, n2] = [await w.person('ZZ_审批一', dept), await w.person('ZZ_审批二', dept)];
  const subject = await w.person('ZZ_子集员工', dept);
  const stranger = await w.person('ZZ_无关同事', dept);
  const cc = await w.person('ZZ_抄送同事', dept);
  const open = Object.fromEntries((Object.keys(SUBSETS) as SubsetKind[]).map((k) => [k, textFieldsOf(k)]));
  const setting = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
    ifMatch: 0,
    body: { value: open },
  });
  expect(setting.status, await setting.clone().text()).toBe(200);
  const node = (key: string, person: Person) => ({
    key,
    approver: { type: 'specified' as const, value: person.userId },
    formFields: Object.values(open).flat(),
    actions: { copySend: true },
    exits: ['approve', 'disagree'] as ('approve' | 'disagree')[],
  });
  await w.publishedProcess({
    approvalType: 'personnel_change',
    isFallback: true,
    conditions: { items: [] },
    nodes: [
      node('n1', n1),
      options.sameAssigneeSecond
        ? { ...node('n2', n1), sameAssigneeSkip: true, sameAssigneeResult: 'approve' as const }
        : node('n2', n2),
    ],
  });
  /** 主数据里的一条子集记录（HR 直接维护）。 */
  async function record(subset: SubsetKind, values: Record<string, unknown>) {
    const res = await w.request(w.hr.id, 'POST', `${PERSONNEL}/employees/${subject.employeeId}/subsets/${subset}`, {
      ifMatch: 0,
      body: values,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; revision: number };
  }
  /** 员工本人发起的子集变更申请；target 缺省为新增。 */
  async function apply(subset: SubsetKind, values: Record<string, unknown>, target?: { id: string; revision: number }) {
    const res = await w.request(subject.userId, 'POST', `${PERSONNEL}/change-requests`, {
      ifMatch: 0,
      body: {
        employeeId: subject.employeeId,
        subset,
        ...(target ? { recordId: target.id, targetRevision: target.revision } : {}),
        values,
      },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string };
  }
  const requestPath = (id: string) => `${PERSONNEL}/change-requests/${id}`;
  return { w, dept, n1, n2, subject, stranger, cc, record, apply, requestPath };
}

/**
 * 可撤销的字段权（AC-F476-07）：与审批世界同租户、另起一个带权限提供方的应用。
 * 办理动作与读取都经它，办理时的披露上限才反映「当时」可见的字段；之后 hide/show 立即影响读取时的当前权限。
 * 可见字段取各对象的真实字段目录（不注入目录外的键）：容器键（submittedFields / values 等）能否出现在响应里，
 * 由生产代码的投影契约决定，夹具不替它放行（F-476 P5 第 1 轮 P2-2）。
 */
export function rights(w: ApprovalWorld, deny: (request: Parameters<Authorizer>[0]) => boolean = () => false) {
  const hidden = new Map<string, Set<string>>();
  const authorize: Authorizer = (request) => !deny(request);
  const viewable = async (_tenantId: string, _userId: string, objectCode: string) => {
    const base = objectCatalog.get(objectCode)?.fields.map((f) => f.code) ?? [];
    return new Set(base.filter((f) => !hidden.get(objectCode)?.has(f)));
  };
  registerScopeProvider(authorize, {
    scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true }),
    authorize: async () => true,
    fields: viewable,
  });
  const api = tenantApi(w.db, { authorize, clock: w.clock });
  const request = (user: string, method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...options, user, tenant: w.tenant.id });
  async function get(user: string, path: string): Promise<Reply> {
    const res = await request(user, 'GET', path);
    return { status: res.status, body: (await res.json()) as Reply['body'] };
  }
  /** 经本应用做审批动作（办理份的披露上限据此捕获）。 */
  async function decide(
    instanceId: string,
    actor: Person,
    action: 'approve' | 'reject' | 'disagree',
    fields?: Record<string, unknown>,
  ) {
    const view = await w.detail(instanceId);
    const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === actor.userId);
    expect(task, `${actor.name} 没有待办`).toBeDefined();
    const res = await request(actor.userId, 'POST', `${BASE}/tasks/${task!.id}/${action}`, {
      ifMatch: view.revision,
      body: { comment: '合成意见', ...(fields ? { fields } : {}) },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }
  const detail = (user: string, instanceId: string) => get(user, `${BASE}/instances/${instanceId}`);
  return {
    request,
    get,
    decide,
    detail,
    hide: (objectCode: string, ...fields: string[]) => {
      hidden.set(objectCode, new Set([...(hidden.get(objectCode) ?? []), ...fields]));
    },
    show: (objectCode: string, ...fields: string[]) => {
      for (const f of fields) hidden.get(objectCode)?.delete(f);
    },
  };
}

/**
 * 与生产授权器同事务形状的放行授权器（P2-1）：直接调用时自己开一个租户事务（PGlite 单连接下，若调用方已占着
 * withTenant 的连接就会永久等待）；经 authorizeInTransaction 绑到调用方事务后只在该事务内判定。
 * 范围 / 字段提供方同生产（permission/authorizer.ts）：传了 Tx 沿用，未传 Tx 自开租户事务（第 2 轮 P2-2）。
 * 不是「同步放行」的替身：入口漏绑事务时它会和生产授权器一样卡死，用来守住各详情入口。
 */
export function transactionalRights(w: ApprovalWorld) {
  const inTenant = <T>(tenantId: string, tx: Tx | undefined, run: () => T) =>
    tx
      ? tx.execute(sql`SELECT 1`).then(run)
      : withTenant(w.db, tenantId, async (own) => {
          await own.execute(sql`SELECT 1`);
          return run();
        });
  const authorize: Authorizer = async (request) => inTenant(request.tenantId, undefined, () => true);
  registerScopeProvider(authorize, {
    scope: (query, tx) => inTenant(query.tenantId, tx, () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true })),
    authorize: (request, tx) => inTenant(request.tenantId, tx, () => true),
    fields: (tenantId, _userId, objectCode, tx) =>
      inTenant(tenantId, tx, () => new Set(objectCatalog.get(objectCode)?.fields.map((f) => f.code) ?? [])),
  });
  const api = tenantApi(w.db, { authorize, clock: w.clock });
  return {
    get: async (user: string, path: string): Promise<Reply> => {
      const res = await api.request('GET', path, { user, tenant: w.tenant.id });
      return { status: res.status, body: (await res.json()) as Reply['body'] };
    },
  };
}

/** 去掉流程管理员按钮的权限：让读者只剩「普通参与人」身份（审批中心 adminTransfer / adminIntervene 都不放行）。 */
export const noAdmin = (r: { action: string; resource?: string }) =>
  r.action === 'object.button' && (r.resource ?? '').startsWith(APPROVAL_INSTANCE_OBJECT);
