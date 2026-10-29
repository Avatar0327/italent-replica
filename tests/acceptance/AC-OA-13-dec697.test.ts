/** DEC-697：组织调整来源保持三项白名单，保存 / 运行 / 设计器共用来源契约。 */
import {
  APPROVAL_TYPES,
  APPROVER_EXPRESSIONS,
  approverSource,
  approverSourceViolations,
  type ApproverSource,
} from '@italent/domain';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ProcessView } from '../../apps/api/src/modules/approval/definitions.js';
import { resolveSource } from '../../apps/api/src/modules/approval/source-resolver.js';
import { sourceInputError, sourceOptions } from '../../apps/web/src/approval/designer/sources.js';
import { flowFixture } from './support/f315-fixture.js';
import { approvalWorld } from './AC-APV-support.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();
const values = ['approval_subject_org_hrbp', 'approval_subject_org_head'] as const;
const source = (value: string): ApproverSource => ({ type: 'object_field', value });
type World = Awaited<ReturnType<typeof approvalWorld>>;
const save = (w: World, approvalType: string, approver: ApproverSource) =>
  w.request(w.hr.id, 'POST', '/api/tenant/approval/processes', {
    ifMatch: 0,
    body: {
      code: `DEC697_${uniqueSuffix()}`,
      name: '合成来源契约流程',
      approvalType,
      isFallback: true,
      conditions: { items: [] },
      nodes: [{ key: 'one', name: '合成节点', approver }],
    },
  });

async function rejected(response: Response) {
  expect(response.status).toBe(422);
  expect((await response.json()).error).toMatchObject({
    code: 'APPROVAL_SOURCE_INVALID',
    details: { reason: 'APPROVAL_DEFINITION_INVALID' },
  });
}

describe('AC-OA-13 DEC-697 双向来源', () => {
  it.each(values)('%s：保存并读回原 JSON，实际来源解析仍取审批主体组织角色', async (value) => {
    const w = await approvalWorld(db().db, 'dec697-valid');
    const subjectOrg = await w.org(`审批主体${uniqueSuffix()}`);
    const otherOrg = await w.org(`无关组织${uniqueSuffix()}`);
    const head = await w.person('合成负责人', subjectOrg);
    const hrbp = await w.person('合成HRBP', subjectOrg);
    const other = await w.person('合成无关负责人', otherOrg);
    await w.setOrgRoles(subjectOrg, { head: head.employeeId, hrbp: hrbp.employeeId });
    await w.setOrgRoles(otherOrg, { head: other.employeeId, hrbp: other.employeeId });
    const response = await save(w, 'org_adjustment', source(value));
    expect(response.status).toBe(201);
    const view = (await response.json()) as ProcessView;
    const node = view.latestVersion.nodes[0]!;
    expect(node).toMatchObject({ kind: 'single', approver: source(value) });
    if (node.kind !== 'single') throw new Error('预期单人节点');
    const candidates = await withTenant(db().db, w.tenant.id, (tx) =>
      resolveSource(
        tx,
        {
          tenantId: w.tenant.id,
          asOf: '2026-10-01',
          initiatorUserId: w.hr.id,
          subjectEmployeeId: other.employeeId,
          latestDepartmentId: otherOrg,
          recordDepartmentId: subjectOrg,
        },
        node.approver,
      ),
    );
    expect(candidates.map((candidate) => candidate.userId)).toEqual([
      value === 'approval_subject_org_hrbp' ? hrbp.userId : head.userId,
    ]);
    const legacy = await withTenant(db().db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE approval_process_nodes SET approver_expression=${JSON.stringify(value)}::jsonb
        WHERE tenant_id=${w.tenant.id} AND version_id=${view.latestVersion.id}::uuid`),
    ).then(
      () => null,
      (error: unknown) => `${String(error)} ${String((error as { cause?: unknown }).cause)}`,
    );
    expect(legacy).toContain('approval_nodes_approvers');
  });

  it.each(['offer_batch', 'transfer'])('%s：误用任一组织调整选项统一 422', async (type) => {
    const w = await approvalWorld(db().db, 'dec697-misuse');
    for (const value of values) await rejected(await save(w, type, source(value)));
  });

  it('组织调整原三项白名单不变，指定人员 / 上一节点等不能借新结构进入', async () => {
    const w = await approvalWorld(db().db, 'dec697-whitelist');
    for (const value of APPROVER_EXPRESSIONS) {
      const response = await save(w, 'org_adjustment', approverSource(value));
      if (['owner', ...values].includes(value)) expect(response.status, value).toBe(201);
      else await rejected(response);
    }
    for (const candidate of [
      { type: 'specified', value: w.hr.id },
      { type: 'context_variable', value: 'previous_approved' },
    ] satisfies ApproverSource[])
      await rejected(await save(w, 'org_adjustment', candidate));
  });

  it('空人来源也不能在交接节点借用组织调整专用取值', () => {
    const base = flowFixture().latestVersion.nodes[0]!;
    for (const value of values) {
      const node = { ...base, emptyApproverPolicy: 'specified' as const, emptyApproverSources: [source(value)] };
      expect(approverSourceViolations(node, APPROVAL_TYPES.exit_handover)).not.toEqual([]);
    }
  });

  it('设计器两选项仅组织调整可选，三项白名单与服务端相同，显示可读名称', () => {
    const node = flowFixture().latestVersion.nodes[0]!;
    for (const [code, type] of Object.entries(APPROVAL_TYPES)) {
      const options = sourceOptions(node, code);
      for (const value of values) {
        const option = options.find((entry) => entry.value === 'object_field')?.children.find((v) => v.value === value);
        expect(option, `${code}/${value}`).toMatchObject({ disabled: code !== 'org_adjustment' });
        expect(option?.label).toBe(value.endsWith('hrbp') ? '审批主体组织 HRBP' : '审批主体组织负责人');
        expect(approverSourceViolations({ ...node, kind: 'single', approver: source(value) }, type).length === 0).toBe(
          code === 'org_adjustment',
        );
        expect(sourceInputError(source(value), node, code) === undefined).toBe(code === 'org_adjustment');
      }
    }
    expect(sourceOptions(node, 'org_adjustment').find((type) => type.value === 'specified')).toMatchObject({
      disabled: true,
    });
    const enabled = sourceOptions(node, 'org_adjustment').flatMap((type) =>
      type.children.filter((value) => !value.disabled).map((value) => value.value),
    );
    expect(enabled.sort()).toEqual(['owner', ...values].sort());
    expect(
      sourceInputError({ type: 'specified', value: 'a3000000-0000-4000-8000-000000000003' }, node, 'org_adjustment'),
    ).toBeDefined();
  });
});
