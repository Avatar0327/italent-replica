/**
 * F-479 S2 验收夹具：本人离职申请草稿绑定附件、提交封存、审批 / HR 载体读取。
 * 在 attachmentWorld（审批世界 + 员工身份副本）之上加：已发布的离职流程（审批节点表单含 attachmentRefs）、
 * 本人申请入口包装、附件行状态与审计 / outbox 计数读取。一律走真实 HTTP，不直写业务表。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { MODULE_OBJECTS } from '@italent/domain';
import { grantVisibleFields, permissionAdmin, type Person } from './AC-APV-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
import { attachmentWorld, png, type Receipt } from './AC-ATT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

export const SELF = '/api/tenant/self-service';
export const APPROVAL = '/api/tenant/approval';
export const EMPLOYMENT_API = '/api/tenant/employment';

export interface ExitReceipt {
  id: string;
  revision: number;
  status: string;
  employeeId: string;
  attachmentRefs?: string[];
  attachments?: { id: string; filename: string; contentType: string; byteSize: number; uploadedAt: string }[];
}

export interface FileState {
  id: string;
  status: string;
  sealed_at: string | null;
  expires_at: string | null;
  business_type: string | null;
  business_id: string | null;
  cleanup_at: string | null;
  revision: number;
}

type World = Awaited<ReturnType<typeof attachmentWorld>>;
export interface NodeOptions {
  readonly formFields?: readonly string[];
  /** 在审批节点前加一个由“被回避主体”办理的节点（subject_skip，其人不是发起人，AC-ATT-14）。 */
  readonly skipFirst?: boolean;
  /** 审批节点前加一个“首节点”审批人（lead）：第一轮 lead 同意、approver 驳回；第二轮起 lead 待办、approver 只剩已办（AC-ATT-26）。 */
  readonly leadFirst?: boolean;
  /** 审批节点开放 attachmentRefs 为可编辑（单独编辑 / 同意时带编辑），用来验证审批编辑出口对它只读（AC-ATT-16）。 */
  readonly editMode?: 'separate' | 'with_approve';
  /** 审批节点可编辑的字段，默认只有 attachmentRefs；R1 要测“同值回传 + 正常字段编辑”时加上 lastWorkDate。 */
  readonly editableFields?: readonly string[];
}

export async function exitWorld(db: Parameters<typeof attachmentWorld>[0], label: string, node: NodeOptions = {}) {
  const a = await attachmentWorld(db, label);
  const { w } = a;
  const approver = await a.person('合成审批人甲');
  const skipper = node.skipFirst ? await a.person('合成被回避人') : undefined;
  const lead = node.leadFirst ? await a.person('合成首节点审批人') : undefined;
  await w.publishedProcess({
    approvalType: 'leave',
    isFallback: true,
    conditions: { items: [], expression: '' },
    nodes: [
      ...(skipper
        ? [
            {
              key: 'skip',
              approver: { type: 'specified' as const, value: skipper.userId },
              formFields: ['lastWorkDate', 'attachmentRefs'],
              actions: { avoidSubjects: true },
            },
          ]
        : []),
      ...(lead
        ? [
            {
              key: 'lead',
              approver: { type: 'specified' as const, value: lead.userId },
              formFields: ['lastWorkDate', 'attachmentRefs'],
            },
          ]
        : []),
      {
        key: 'review',
        approver: { type: 'specified', value: approver.userId },
        formFields: node.formFields ?? ['lastWorkDate', 'attachmentRefs'],
        actions: { transfer: true, addSign: true, copySend: true },
        ...(node.editMode
          ? { editableFields: node.editableFields ?? ['attachmentRefs'], editMode: node.editMode }
          : {}),
      },
    ],
  });

  const ess = (actor: Person, path: string, method = 'GET', body?: unknown, revision?: number, key?: string) =>
    a.api.request(method, `${SELF}${path}`, { ...w.as(actor.userId), body, ifMatch: revision, idempotencyKey: key });
  const asUser = (actor: Person | { userId: string }, path: string, method = 'GET', init: object = {}) =>
    a.api.request(method, path, { ...w.as(actor.userId), ...init });

  /** 登记并上传 count 张互不相同的合成位图，返回上传回执。 */
  async function uploads(actor: Person, count: number) {
    const receipts: Receipt[] = [];
    for (let index = 0; index < count; index++)
      receipts.push(await a.stored(actor, png(2 + index, 2), `手写${index + 1}.png`));
    return receipts;
  }

  async function employeeRevision(actor: Person) {
    const form = await w.json<{ employee: { revision: number } }>(await ess(actor, '/exit-requests/form'));
    return form.employee.revision;
  }
  const createRaw = async (actor: Person, body: object) =>
    ess(actor, '/exit-requests', 'POST', { lastWorkDate: '2026-12-01', ...body }, await employeeRevision(actor));
  const createDraft = async (actor: Person, refs?: readonly string[]) =>
    w.json<ExitReceipt>(await createRaw(actor, refs ? { attachmentRefs: refs } : {}), 201);
  const patch = (actor: Person, draft: { id: string; revision: number }, body: object) =>
    ess(actor, `/exit-requests/${draft.id}`, 'PATCH', body, draft.revision);
  const read = async (actor: Person, id: string) => w.json<ExitReceipt>(await ess(actor, `/exit-requests/${id}`));
  const submit = (actor: Person, draft: { id: string; revision: number }, key = randomUUID()) =>
    ess(actor, `/exit-requests/${draft.id}/submit`, 'POST', {}, draft.revision, key);
  const download = (actor: Person, id: string, fileId: string) =>
    ess(actor, `/exit-requests/${id}/attachments/${fileId}/content`);

  async function fileState(id: string): Promise<FileState> {
    const result = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT id,status,sealed_at::text,expires_at::text,business_type,business_id::text,
        cleanup_at::text,revision FROM attachment_files WHERE tenant_id=${w.tenant.id} AND id=${id}::uuid`),
    );
    return rowsOf<FileState>(result)[0]!;
  }
  /** 审计、outbox、业务单行数：重放不得新增（AC-ATT-24）。 */
  async function counts() {
    const count = async (statement: ReturnType<typeof sql>) =>
      Number(rowsOf<{ n: number }>(await withTenant(w.db, w.tenant.id, (tx) => tx.execute(statement)))[0]!.n);
    return {
      audit: await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=${w.tenant.id}`),
      attachmentOutbox: await count(
        sql`SELECT count(*)::int AS n FROM attachment_outbox WHERE tenant_id=${w.tenant.id}`,
      ),
    };
  }
  const exitRow = async (id: string) =>
    rowsOf<{ attachment_refs: string[] | null }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT attachment_refs FROM exit_requests WHERE tenant_id=${w.tenant.id}
          AND business_id=${id}::uuid`),
      ),
    )[0]!;

  /** 提交后的审批实例与待办任务（审批人甲）。 */
  async function instanceOf(draft: { id: string }, initiator: Person) {
    const instance = await w.instanceOf(draft.id, initiator.userId);
    return { instance, task: w.pending(instance)[0]! };
  }
  async function submitted(actor: Person, refs: readonly string[]) {
    const draft = await createDraft(actor, refs);
    const done = await w.json<ExitReceipt>(await submit(actor, draft));
    expect(done.status).toBe('in_review');
    return { draft: done, ...(await instanceOf(done, actor)) };
  }
  const approvalDetail = (viewer: { userId: string }, instanceId: string) =>
    asUser(viewer, `${APPROVAL}/instances/${instanceId}`);
  const approvalDownload = (viewer: { userId: string }, instanceId: string, fileId: string) =>
    asUser(viewer, `${APPROVAL}/instances/${instanceId}/attachments/${fileId}/content`);

  /** 受限 HR：自定义授权器与字段可见集合（范围全部或为空（fail-closed），仅用于验收字段 / 按钮 / 范围裁剪）。 */
  function restrictedHr(authorize: Authorizer, fields: readonly string[], scope: 'all' | 'empty' = 'all') {
    registerScopeProvider(authorize, {
      scope: async () => (scope === 'all' ? { ...EMPTY_SCOPE, all: true, hasDataPermission: true } : EMPTY_SCOPE),
      authorize: async (request) => authorize(request),
      fields: async () => new Set(fields),
    });
    const api = tenantApi(w.db, { authorize, clock: w.clock });
    return (path: string, method = 'GET', init: object = {}) =>
      api.request(method, `${EMPLOYMENT_API}${path}`, { ...w.as(w.hr.id), ...init });
  }

  /** 离职类型是同意前必须由 HR 补齐的字段（EXIT_HR_FIELDS_REQUIRED）：经 HR 编辑入口补上，供 R1 走到“审批通过”。 */
  async function fillExitType(id: string) {
    const api = restrictedHr(() => true, ['id', 'status', 'revision', 'lastWorkDate', 'exitTypeCode', 'mode', 'exit']);
    const detail = await w.json<{ revision: number }>(await api(`/exits/${id}`));
    const response = await api(`/exits/${id}`, 'PATCH', {
      ifMatch: detail.revision,
      body: { exitTypeCode: 'voluntary' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 定时生效：按给定的服务器时刻跑本租户的任职生效任务（审批通过 ≠ 生效，R1 P2-2 要走到已生效）。 */
  async function activateAt(iso: string) {
    const result = await runEmploymentActivations(
      w.db,
      cmd(),
      { tenantId: w.tenant.id },
      { clock: () => new Date(iso) },
    );
    expect(result.runs).toHaveLength(1);
    return result.runs[0]!;
  }

  /** 给用户授予任职对象的字段查看权（审批人 / HR 的 attachmentRefs 字段权，AC-ATT-13～15）。 */
  let admin: ReturnType<typeof permissionAdmin> | undefined;
  async function grantFields(userId: string, fields: readonly string[]) {
    admin ??= permissionAdmin(w);
    return grantVisibleFields(await admin, userId, fields);
  }
  /** 改写已授予身份的可见字段（AC-ATT-26：办理之后收回 / 补授字段权）。 */
  async function reviseFields(profile: Parameters<typeof setObjectPermission>[1], visible: readonly string[]) {
    admin ??= permissionAdmin(w);
    const definition = MODULE_OBJECTS.employmentRecord;
    const response = await setObjectPermission(
      await admin,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: visible.includes(f.code), edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  /** 夹具：把已上传的本人文件直接标成“已绑定到别的业务单”（同一员工不能同时有两张未办结离职单，造不出第二张草稿）。 */
  async function bindElsewhere(fileId: string) {
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE attachment_files SET status='bound', business_type='employment',
        business_id=${randomUUID()}::uuid, expires_at=NULL WHERE tenant_id=${w.tenant.id} AND id=${fileId}::uuid`),
    );
  }

  return {
    grantFields,
    reviseFields,
    bindElsewhere,
    activateAt,
    fillExitType,
    a: a as World,
    w,
    approver,
    skipper,
    lead,
    ess,
    asUser,
    uploads,
    createRaw,
    createDraft,
    patch,
    read,
    submit,
    download,
    fileState,
    counts,
    exitRow,
    instanceOf,
    submitted,
    approvalDetail,
    approvalDownload,
    restrictedHr,
  };
}

export type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;
