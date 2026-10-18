/**
 * BE-15b1 权限与审批人取值限制：
 * - 发起 / 修改考核走考核对象 TenantBase.ProbationAssessment 的数据操作 + 按钮（create@list、update@detail），
 *   任何一项被拒都是 403 且不写入；
 * - 审批人“考核 - 考核对象本人”只能用于试用中考核 / 转正考核；考核两类审批也不能选 Offer、IDP 专用取值。
 */
import { PROBATION_ASSESSMENT_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { assessmentWorld, reasonOf, type LaunchReceipt } from './AC-PB-BE15b1-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const ASSESSMENTS = '/api/tenant/employment/probation-assessments';

describe('考核对象权限', () => {
  it('缺少数据操作或按钮：发起 / 修改 403，不写入；允许时可发起', async () => {
    const w = await assessmentWorld(testDb().db, 'auth');
    const person = await w.probationer('权限员工');
    const body = async () => ({
      assessmentType: 'probation',
      assessmentName: '权限考核',
      assessmentDate: '2026-10-01',
      items: [{ employeeId: person.employeeId, revision: await w.employeeRevision(person.employeeId) }],
    });
    const deniedBy = (denied: (request: { action: string; resource?: string }) => boolean) =>
      tenantApi(testDb().db, {
        clock: w.clock,
        authorize: (request) => !denied(request as { action: string; resource?: string }),
      });
    const as = { user: w.hr.id, tenant: w.tenant.id };
    const onObject = (action: string) => (request: { action: string; resource?: string }) =>
      request.action === action && request.resource === PROBATION_ASSESSMENT_OBJECT;
    const noButton = (request: { action: string; resource?: string }) =>
      request.action === 'object.button' && (request.resource ?? '').startsWith(PROBATION_ASSESSMENT_OBJECT);

    for (const denied of [onObject('object.create'), noButton]) {
      const api = deniedBy(denied);
      const response = await api.request('POST', ASSESSMENTS, { ...as, body: await body() });
      expect((await reasonOf(response)).status).toBe(403);
    }
    const listed = await w.json<{ items: unknown[] }>(await w.request(w.hr.id, 'GET', ASSESSMENTS));
    expect(listed.items).toEqual([]);

    const id = await w.launch('probation', person);
    await w.complete(id, person, { managerRating: 'meets', regularizationOpinion: 'normal' });
    const current = await w.get(id);
    const api = deniedBy(onObject('object.update'));
    const patched = await api.request('PATCH', `${ASSESSMENTS}/${id}`, {
      ...as,
      ifMatch: current.revision,
      body: { managerRating: 'exceeds' },
    });
    expect(patched.status).toBe(403);
    expect((await w.get(id)).managerRating).toBe('meets');
    expect(await w.json<LaunchReceipt>(await w.launchRaw('probation', [person]))).toMatchObject({ succeeded: 1 });
  });
});

describe('审批人取值的类型限制', () => {
  const process = (approvalType: string, approver: string) => ({
    code: `PB15_${approvalType}_${approver}`.slice(0, 60),
    name: '合成流程',
    approvalType,
    exceptionAdminUserId: null,
    isFallback: true,
    conditions: { items: [] },
    nodes: [{ key: 'n1', approver }],
  });

  it('“考核对象本人”只用于两类考核；考核两类不能选 Offer / IDP 专用取值', async () => {
    const w = await assessmentWorld(testDb().db, 'types');
    const post = (body: unknown) => w.request(w.hr.id, 'POST', '/api/tenant/approval/processes', { ifMatch: 0, body });
    for (const [type, approver] of [
      ['transfer', 'assessment_employee'],
      ['regularization', 'assessment_employee'],
      ['probation_assessment', 'idp_employee'],
      ['regularization_assessment', 'offer_department_head'],
    ] as const) {
      expect(await reasonOf(await post(process(type, approver))), `${type}/${approver}`).toMatchObject({
        status: 400,
        reason: 'APPROVAL_DEFINITION_INVALID',
      });
    }
    for (const type of ['probation_assessment', 'regularization_assessment'] as const)
      expect((await post(process(type, 'assessment_employee'))).status, type).toBe(201);
  });
});
