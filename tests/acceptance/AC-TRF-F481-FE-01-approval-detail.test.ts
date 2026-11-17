/**
 * AC-TRF-F481-FE-01（F-481 设计 §8.1，第 2 轮 P2-2）：调动审批详情里的「发起电子文件签署」「电子签署模板」。
 * 走真实预置流程 standard_transfer（节点白名单由 TRANSFER_DETAIL_VIEW 推出，DEC-057），写法同 AC-TRF-118-detail：
 * 发起时审批人看到是否发起与同序模板名称（esignTemplateIdsName，approval/reference-names.ts），未发起时为否、空。
 * 直接读写租户数据都在 withTenant 内（PGlite 与 PG16 app_owner 同跑，F-212）。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { publishPreset } from './AC-APV-F478-s3-support.js';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { referenceNames } from '../../apps/api/src/modules/approval/reference-names.js';

const database = useTestDb();

async function scene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await publishPreset(w, 'standard_transfer');
  const created = async (path: string, body: Record<string, unknown>) =>
    w.json<{ id: string; name: string }>(await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body }), 201);
  const master = (kind: string) =>
    created(`/api/tenant/contracts/master-data/${kind}`, { code: randomUUID(), name: `合成${kind}` });
  const [type, company] = [await master('types'), await master('companies')];
  const contract = await created('/api/tenant/contracts/commands', {
    ...{ operation: 'create', mode: 'direct', employeeId: s.subject.employeeId },
    fields: {
      ...{ typeId: type.id, companyId: company.id, effectiveDate: '2026-01-01', endDate: '2027-12-31' },
      ...{ termType: 'fixed', termMonths: 24 },
    },
  });
  const template = (suffix: string) =>
    created('/api/tenant/esign/templates', {
      code: `syn.esign.${suffix}_${randomUUID()}`,
      name: `ZZ_F481_详情模板_${suffix}`,
      body: '{员工姓名}调入{调入部门}。',
    });
  const templates = [await template('A'), await template('B')];
  /** 调动申请：带合同变更；esign 给了模板就是发起签署，不给就是未发起。 */
  async function approval(esign?: { templateIds: string[] }) {
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const linkage = { contract: { targetId: contract.id, fields: { endDate: '2029-10-09' } }, ...(esign && { esign }) };
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/transfers/employees/${s.subject.employeeId}`, {
        ifMatch: employee.revision,
        body: {
          ...{ initiator: 'hr', transferTypeCode: 'cross_department', mode: 'application' },
          ...{ effectiveDate: '2026-10-10', fields: { departmentId: s.to }, linkage },
        },
      }),
      201,
    );
    const instance = await w.submit(draft);
    expect(instance).toMatchObject({ currentNodeKey: 'out_head' });
    return w.detail(instance.id, s.outHead.userId);
  }
  return { w, templates, approval };
}

describe('AC-TRF-F481-FE-01 调动审批详情：发起电子文件签署与电子签署模板（真实预置流程）', () => {
  it('发起签署：审批人看到“是”、所选模板 ID 与同序名称', async () => {
    const { templates, approval } = await scene('f481-detail-esign');
    const [a, b] = templates as [{ id: string; name: string }, { id: string; name: string }];
    const detail = await approval({ templateIds: [b.id, a.id] });
    expect(detail.form.values).toMatchObject({
      electronicSignature: true,
      esignTemplateIds: [b.id, a.id],
      esignTemplateIdsName: [b.name, a.name],
    });
  });

  it('未发起签署：是否发起为否，模板与名称都为空数组', async () => {
    const { approval } = await scene('f481-detail-none');
    const detail = await approval();
    expect(detail.form.values).toMatchObject({ electronicSignature: false, esignTemplateIds: [] });
    expect(detail.form.values['esignTemplateIdsName']).toEqual([]);
  });

  it('沿用冻结与裁剪规则：已带名称不覆盖；查不到的模板为 null；ID 被裁掉时名称不单独带出', async () => {
    const { w, templates } = await scene('f481-detail-rules');
    const [a] = templates as [{ id: string; name: string }];
    const missing = randomUUID();
    const ctx = { tenantId: w.tenant.id, userId: w.hr.id, timezone: 'Asia/Shanghai', now: new Date() };
    const named = (values: Record<string, unknown>, originals: Record<string, unknown>) =>
      withTenant(w.db, w.tenant.id, (tx) => referenceNames(tx, ctx, 'transfer', { form: { values, originals } }));
    const fresh = await named({ esignTemplateIds: [a.id, missing, 'not-a-uuid'] }, { esignTemplateIdsName: ['旧名'] });
    expect(fresh.form.values['esignTemplateIdsName']).toEqual([a.name, null, null]);
    expect(fresh.form.originals).not.toHaveProperty('esignTemplateIdsName');
    const frozen = await named({ esignTemplateIds: [a.id], esignTemplateIdsName: ['办理时的名称'] }, {});
    expect(frozen.form.values['esignTemplateIdsName']).toEqual(['办理时的名称']);
  });
});
