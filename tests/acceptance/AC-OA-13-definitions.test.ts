/**
 * R2-T08 BE-10a：组织调整的审批契约（设计 §4.1 / §4.2 / §14.1 第 10a 行；DEC-526②、DEC-644 A-2 / A-14）。
 * - AC-OA-13（定义 / 解析）：流程编码 OrganizationProcess、预置两节点；审批人按审批主体组织取负责人 / HRBP（F-135，DEC-789）；
 * - 审批类型 / 适配器种类：objectCode 只在一个常量里定义；`approvalTypeOfBusiness('org_adjustment')` 返回 null；
 * - 适配器：BE-10a 占位（任何钩子 409 ORG_ADJUSTMENT_NOT_AVAILABLE）已由 BE-10c 换成真适配器，这里只核对钩子齐全（含 lockMany、
 *   beforeApprove），行为见 AC-OA-12～15 / 26 / 27 / 38 / 39 / 43；通用任职入口对 application 方式 400 KIND_RESERVED。
 * 授权 / 对象 / DEC-415 的断言不在本批（A-14 取证后随 BE-10a2）。
 */
import {
  APPROVAL_TYPES,
  approverSource,
  type ApproverExpression,
  approvalTypeOfBusiness,
  ORG_ADJUSTMENT_FORM_FIELDS,
  ORG_ADJUSTMENT_OBJECT_CODE,
  ORG_ADJUSTMENT_PROCESS_CODE,
  PRESET_PROCESSES,
} from '@italent/domain';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../../apps/api/src/modules/approval/adapters.js';
import { resolveCandidate, type RoutingSubject } from '../../apps/api/src/modules/approval/resolver.js';
import { parseEmploymentInput } from '../../apps/api/src/modules/employment/fields.js';
import { approvalWorld } from './AC-APV-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const preset = PRESET_PROCESSES.find((p) => p.approvalType === 'org_adjustment');

describe('审批类型定义（§4.1）', () => {
  it('独立类型：对象编码来自单一常量、适配器 org_adjustment、默认流程编码 OrganizationProcess', () => {
    const type = APPROVAL_TYPES.org_adjustment;
    expect(ORG_ADJUSTMENT_OBJECT_CODE).toBe('TenantBase.OrganizationApproval');
    expect(ORG_ADJUSTMENT_PROCESS_CODE).toBe('OrganizationProcess');
    expect(type).toMatchObject({
      code: 'org_adjustment',
      name: '组织调整',
      objectCode: ORG_ADJUSTMENT_OBJECT_CODE,
      adapter: 'org_adjustment',
      defaultProcessCode: 'OrganizationProcess',
      approvalEdit: true,
      readonlyFields: [],
    });
    expect(type.conditionFields.map((f) => [f.path, f.kind])).toEqual([
      ['processCode', 'text'],
      ['adjustment.approvalSubjectOrgId', 'org'],
    ]);
    expect(type.formFields).toEqual(ORG_ADJUSTMENT_FORM_FIELDS);
  });

  it('approvalTypeOfBusiness：org_adjustment 不再映射任职业务；其余映射不变', () => {
    expect(approvalTypeOfBusiness('org_adjustment')).toBeNull();
    expect(approvalTypeOfBusiness('transfer')).toBe('transfer');
    expect(approvalTypeOfBusiness('rehire')).toBe('hire');
    expect(approvalTypeOfBusiness('retire_rehire')).toBe('hire');
    expect(approvalTypeOfBusiness('add_employee')).toBeNull();
    expect(approvalTypeOfBusiness('part_time')).toBeNull();
    expect(approvalTypeOfBusiness('no_such_kind')).toBeNull();
  });
});

describe('预置流程（§4.2，DEC-644 A-2：取人口径是推断，可改草稿，不随开通发布）', () => {
  it('专用预置 standard_organization_process：两节点、流程编码条件、旧预置键移除', () => {
    expect(PRESET_PROCESSES.filter((p) => p.approvalType === 'org_adjustment')).toHaveLength(1);
    expect(PRESET_PROCESSES.some((p) => p.presetKey === 'standard_org_adjustment')).toBe(false);
    expect(preset).toMatchObject({
      presetKey: 'standard_organization_process',
      code: 'StandardOrganizationProcess',
      publishOnProvision: false,
    });
    const definition = preset!.definition;
    expect(definition.conditions.items).toEqual([
      { no: 1, field: 'processCode', operator: 'eq', value: 'OrganizationProcess' },
    ]);
    expect(definition.isFallback).toBe(false);
    expect(definition.nodes.map((n) => [n.key, n.name, 'approver' in n && n.approver])).toEqual([
      ['department_head', '部门负责人审批', { type: 'object_field', value: 'approval_subject_org_head' }],
      ['hr_review', 'HR审核生效', { type: 'object_field', value: 'approval_subject_org_hrbp' }],
    ]);
    for (const node of definition.nodes) {
      expect(node.formFields).toEqual(ORG_ADJUSTMENT_FORM_FIELDS);
      expect(node.noAssignee).toBe('exception_admin');
      expect(node.actions).toMatchObject({ avoidSelf: true, avoidSubjects: false });
    }
  });

  it('其他预置不带 publishOnProvision: false（照旧开通时发布）', () => {
    const others = PRESET_PROCESSES.filter((p) => p.approvalType !== 'org_adjustment');
    expect(others.every((p) => p.publishOnProvision !== false)).toBe(true);
  });
});

describe('审批人表达式的类型限制（§4.2）', () => {
  const process = (approvalType: string, approver: ApproverExpression) => ({
    code: `OA13_${approvalType}_${uniqueSuffix()}`,
    name: '合成流程',
    approvalType,
    exceptionAdminUserId: null,
    isFallback: true,
    conditions: { items: [] },
    nodes: [{ key: 'n1', approver: approverSource(approver) }],
  });

  it('两个新表达式只用于组织调整；组织调整也不能用任职记录类取值', async () => {
    const w = await approvalWorld(testDb().db, 'oa13-types');
    const post = (body: unknown) => w.request(w.hr.id, 'POST', '/api/tenant/approval/processes', { ifMatch: 0, body });
    const reason = async (response: Response) => {
      const body = (await response.json()) as { error?: { details?: { reason?: string } } };
      return [response.status, body.error?.details?.reason];
    };
    for (const [type, approver] of [
      ['transfer', 'approval_subject_org_hrbp'],
      ['offer_batch', 'approval_subject_org_head'],
      ['org_adjustment', 'latest_record_department_head'],
      ['org_adjustment', 'idp_tutor'],
    ] as const) {
      expect(await reason(await post(process(type, approver))), `${type}/${approver}`).toEqual([
        422,
        'APPROVAL_DEFINITION_INVALID',
      ]);
    }
    for (const approver of ['approval_subject_org_hrbp', 'approval_subject_org_head', 'owner'] as const) {
      const created = await post({
        ...process('org_adjustment', approver),
        nodes: [{ key: 'n1', approver: approverSource(approver), formFields: ['subject'] }],
      });
      expect(created.status, approver).toBe(201);
    }
  });
});

describe('审批人解析（AC-OA-13）：按审批主体组织取 HRBP / 负责人', () => {
  it('approval_subject_org_hrbp / approval_subject_org_head 取 recordDepartmentId 的组织角色；缺角色 → 无人', async () => {
    const db = testDb().db;
    const w = await approvalWorld(db, 'oa13-resolve');
    const subjectOrg = await w.org(`审批主体${uniqueSuffix()}`);
    const emptyOrg = await w.org(`无角色${uniqueSuffix()}`);
    const head = await w.person('负责人', subjectOrg);
    const hrbp = await w.person('HRBP', subjectOrg);
    await w.setOrgRoles(subjectOrg, { head: head.employeeId, hrbp: hrbp.employeeId });
    const subjectOf = (orgId: string): RoutingSubject => ({
      tenantId: w.tenant.id,
      asOf: '2026-10-01',
      initiatorUserId: w.hr.id,
      subjectEmployeeId: null,
      latestDepartmentId: null,
      recordDepartmentId: orgId,
    });
    const resolve = (orgId: string, expression: 'approval_subject_org_hrbp' | 'approval_subject_org_head') =>
      withTenant(db, w.tenant.id, (tx) => resolveCandidate(tx, subjectOf(orgId), expression));
    expect((await resolve(subjectOrg, 'approval_subject_org_hrbp')).userId).toBe(hrbp.userId);
    expect((await resolve(subjectOrg, 'approval_subject_org_head')).userId).toBe(head.userId);
    expect(await resolve(emptyOrg, 'approval_subject_org_hrbp')).toMatchObject({ personId: null, userId: null });
    expect(await resolve(emptyOrg, 'approval_subject_org_head')).toMatchObject({ personId: null, userId: null });
  });
});

describe('适配器钩子与 KIND_RESERVED', () => {
  it('BE-10c 真适配器：全部钩子都已实现（含 lockMany、beforeApprove），不再是占位', () => {
    const adapter = ADAPTERS.org_adjustment;
    const hooks = ['lock', 'lockMany', 'snapshot', 'beforeApprove', 'approved', 'rejected', 'disapproved'] as const;
    for (const hook of [...hooks, 'withdrawn', 'resubmit', 'edit'] as const) {
      expect(typeof adapter[hook], hook).toBe('function');
    }
  });

  it('通用任职入口：kind = org_adjustment 且 mode = application → 400 ORG_ADJUSTMENT_KIND_RESERVED；直接方式照旧', () => {
    const base = { kind: 'org_adjustment', effectiveDate: '2026-10-01' };
    expect(() => parseEmploymentInput({ ...base, mode: 'application' })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED', details: { reason: 'ORG_ADJUSTMENT_KIND_RESERVED' } }),
    );
    expect(parseEmploymentInput({ ...base, mode: 'direct' })).toMatchObject({ kind: 'org_adjustment' });
    expect(parseEmploymentInput({ kind: 'transfer', mode: 'application', effectiveDate: '2026-10-01' })).toMatchObject({
      mode: 'application',
    });
  });
});
