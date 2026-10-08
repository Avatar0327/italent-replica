/**
 * R3-T07 PR-B 第 2 轮 P2-6：计划侧写入复用 PR-A 的完整重放执行器——重放返回前按当前归属复核，并复核命令实际用到的权限。
 * - 催办 / 开启下一阶段 / 终止：首次得到失败回执（业务错误）后撤空范围，同键重放该条回执为 404，不再回放业务错误；
 * - 新建计划带出了通用目标 measure（E2）/ 按直线经理解析指导人（E3）：首次成功后撤掉源字段查看权，同键重放 403。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import {
  grantTenantBaseView,
  permissionWorldOf,
  planWorld,
  type PlanWorld,
  type Receipt,
} from './AC-IDP-plan-support.js';
import { setObjectPermission } from './AC-PRM-support.js';

const testDb = useTestDb();

const planBody = (w: PlanWorld, extra: Record<string, unknown> = {}) => ({
  name: '2026 年度发展计划',
  employeeId: w.employee.employeeId,
  templateId: w.template.id,
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  tutorRole: 'other',
  tutorEmployeeId: w.manager.employeeId,
  ...extra,
});

describe('P2-6：批量干预的失败回执重放先复核范围', () => {
  it.each([
    ['urge', 'IDP_NO_RUNNING_STAGE'],
    ['start-next', 'IDP_PLAN_NOT_ACTIVE'],
    ['terminate', 'IDP_PLAN_NOT_ACTIVE'],
  ])('%s：首次失败回执 → 撤空范围 → 同键重放回执 404', async (path, code) => {
    const w = await planWorld(testDb().db, `idp-replay-${path}`);
    const pw = await permissionWorldOf(w);
    let plan = await w.createPlan();
    if (path === 'terminate') {
      await w.ok(await w.intervene('terminate', { items: [{ id: plan.id, revision: plan.revision }] }));
      plan = await w.readPlan(plan.id);
    }
    const hr = await idpOperator(pw, { orgId: w.dept });
    const body = { items: [{ id: plan.id, revision: plan.revision }], runningMode: 'skipRunning' };
    const options = {
      ifMatch: 0,
      idempotencyKey: `replay-${path}`,
      body: path === 'start-next' ? body : { items: body.items },
    };
    const first = await w.ok<{ receipts: Receipt[] }>(await hr.request('POST', `/plans/${path}`, options));
    expect(first.receipts).toEqual([expect.objectContaining({ id: plan.id, status: 409, code })]);
    await hr.setOrg(null);
    const replay = await hr.request('POST', `/plans/${path}`, options);
    const text = await replay.text();
    expect(replay.status, text).toBe(200);
    expect(JSON.parse(text).receipts).toEqual([{ id: plan.id, status: 404, code: 'NOT_FOUND' }]);
    expect(text).not.toContain(code);
  });
});

describe('P2-6：带出源的查看权记入台账、重放复核', () => {
  it('E2：带出了通用目标 measure，撤掉 measure 查看权后同键重放 403', async () => {
    const w = await planWorld(testDb().db, 'idp-replay-e2');
    const pw = await permissionWorldOf(w);
    const hr = await idpOperator(pw, { orgId: w.dept });
    const options = { ifMatch: 0, idempotencyKey: 'replay-e2', body: planBody(w) };
    const first = await hr.request('POST', '/plans', options);
    expect(first.status, await first.clone().text()).toBe(201);
    await hr.hideFields('commonGoal', ['measure']);
    const replay = await hr.request('POST', '/plans', options);
    expect(replay.status, await replay.clone().text()).toBe(403);
  });

  it('E3：按直线经理解析了指导人，撤掉任职记录 directManagerId 查看权后同键重放 403', async () => {
    const w = await planWorld(testDb().db, 'idp-replay-e3');
    const pw = await permissionWorldOf(w);
    const hr = await idpOperator(pw, { orgId: w.dept });
    const profile = await grantTenantBaseView(pw, hr.user.id, [w.dept]);
    const options = {
      ifMatch: 0,
      idempotencyKey: 'replay-e3',
      body: planBody(w, { tutorRole: 'direct_manager', tutorEmployeeId: undefined }),
    };
    const first = await hr.request('POST', '/plans', options);
    expect(first.status, await first.clone().text()).toBe(201);
    const record = MODULE_OBJECTS.employmentRecord;
    const hidden = await setObjectPermission(
      pw,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: record.fields.map((f) => ({ fieldCode: f.code, view: f.code !== 'directManagerId', edit: false })),
        buttons: [],
      },
      record.code,
    );
    expect(hidden.status).toBe(200);
    const replay = await hr.request('POST', '/plans', options);
    expect(replay.status, await replay.clone().text()).toBe(403);
  });
});
