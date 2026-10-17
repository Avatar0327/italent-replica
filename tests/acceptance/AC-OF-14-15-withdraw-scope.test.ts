/**
 * BE-14a3 第 1 轮审查 P1-01（DEC-455）：审批侧撤回 Offer / Offer 批量审批，按发起入口同一口径复核发起人当前权限——
 * Offer 对象编辑开关 + 本单关联的每一份 Offer 都在当前 Offer 范围内（批量逐份），不沿用任职撤回按钮与任职范围。
 * 真实授权器：发起在全部允许的夹具里完成，撤回由发起人本人以真实身份调用。
 */
import { APPROVAL_OBJECTS, APPROVAL_INSTANCE_OBJECT, MODULE_OBJECTS, type ObjectDefinition } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { permissionAdmin, type InstanceView } from './AC-APV-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  setObjectPermission,
  type ProfileBody,
} from './AC-PRM-support.js';
import { offerApprovalWorld, reasonOf, type OfferView } from './AC-OF-BE14a3-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const OFFER_DEFINITION = MODULE_OBJECTS.offer;
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord;

async function world(label: string) {
  const w = await offerApprovalWorld(testDb().db, label);
  const prm = await permissionAdmin(w);
  const user = w.applicant.userId;
  const profile = await createProfile(prm, `of3w${uniqueSuffix()}`);
  const permit = async (definition: ObjectDefinition, update: boolean, buttons: string[] = []) => {
    const response = await setObjectPermission(
      prm,
      profile,
      {
        dataOperations: { create: false, update, delete: false },
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'detail' })),
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  await makeGrantable(prm, [profile.id]);
  expect((await grant(prm, user, profile.id)).status).toBe(201);
  /** 任职看全部（审查复现：任职编辑 + 撤回按钮 + 任职看全部）。 */
  const employmentSeeAll = async (target: ProfileBody) => {
    const response = await prm.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${target.id}/data-scopes/TenantBase`,
      { ...prm.asAdmin, ifMatch: 0, body: { targetKind: 'entity', targetCode: EMPLOYMENT.code, seeAll: true } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  /** 发起人在组织员工应用的范围只有录用部门。 */
  const scopeToDepartment = async () => {
    const response = await prm.api.request('PUT', `/api/tenant/permission/scopes/${user}/TenantBase`, {
      ...prm.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: w.department, includeDescendants: false }] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const withdraw = (view: InstanceView, key: string = randomUUID()) =>
    prm.api.request('POST', `/api/tenant/approval/instances/${view.id}/withdraw`, {
      ...w.as(user),
      ifMatch: view.revision,
      idempotencyKey: key,
      body: {},
    });
  const single = async () => {
    const offer = await w.offer(w.applicant);
    await w.json(await w.submitRaw(offer));
    return { offer, view: await w.instance(offer.id) };
  };
  const approvalStatus = async (offer: OfferView) => (await w.get(offer.id)).approvalStatus;
  return { ...w, prm, profile, permit, employmentSeeAll, scopeToDepartment, withdraw, single, approvalStatus };
}

describe('P1-01 审批侧撤回按 Offer 权限复核', () => {
  it('无 Offer 编辑权、只有任职编辑 + 撤回按钮 + 任职看全部：单个 / 批量撤回 403，Offer、批量单、实例都不变', async () => {
    const w = await world('withdraw-employment');
    await w.permit(OFFER_DEFINITION, false);
    await w.permit(EMPLOYMENT, true, ['Employment.Withdraw']);
    await w.employmentSeeAll(w.profile);
    const { offer, view } = await w.single();
    expect(await reasonOf(await w.withdraw(view))).toMatchObject({ status: 403 });
    expect((await w.instance(offer.id)).status).toBe('running');
    expect(await w.approvalStatus(offer)).toBe('approving');

    const batched = await w.offer(w.applicant);
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [batched.id] }), 201);
    const batchView = await w.instance(batch.id);
    expect(await reasonOf(await w.withdraw(batchView))).toMatchObject({ status: 403 });
    expect((await w.instance(batch.id)).status).toBe('running');
    expect(await w.approvalStatus(batched)).toBe('approving');
  });

  it('只有 Offer 编辑权与录用部门范围（无任职撤回权）：单个撤回成功；批量里有一份范围外即整单拒绝', async () => {
    const w = await world('withdraw-offer-scope');
    await w.permit(OFFER_DEFINITION, true);
    await w.scopeToDepartment();
    const { offer, view } = await w.single();
    const ok = await w.withdraw(view);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.approvalStatus(offer)).toBe('unsubmitted');

    const outside = await w.org(`范围外部门${uniqueSuffix()}`);
    const inside = await w.offer(w.applicant);
    const far = await w.offer(w.applicant, outside);
    const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [inside.id, far.id] }), 201);
    const batchView = await w.instance(batch.id);
    expect(await reasonOf(await w.withdraw(batchView))).toMatchObject({
      status: 403,
      reason: 'APPROVAL_SCOPE_DENIED',
    });
    expect((await w.instance(batch.id)).status).toBe('running');
    for (const target of [inside, far]) expect(await w.approvalStatus(target)).toBe('approving');
  });

  it('撤权后用同一幂等键重放撤回 → 拒绝，不交出原结果', async () => {
    const w = await world('withdraw-replay');
    await w.permit(OFFER_DEFINITION, true);
    await w.scopeToDepartment();
    const { view } = await w.single();
    const key = randomUUID();
    const first = await w.withdraw(view, key);
    expect(first.status, await first.clone().text()).toBe(200);
    await w.permit(OFFER_DEFINITION, false);
    expect((await w.withdraw(view, key)).status).toBe(403);
  });

  it('同类位置（管理员转交）：Offer 实例按 Offer 范围限定，只有任职看全部的管理员不能转交', async () => {
    const w = await world('admin-scope');
    const prm = w.prm;
    const { offer, view } = await w.single();
    const task = w.pending(view)[0]!;
    const admin = async (seeAll: string) => {
      const user = await addMember(prm, `Offer审批管理员${uniqueSuffix()}`);
      const profile = await createProfile(prm, `of3a${uniqueSuffix()}`);
      const instanceObject = APPROVAL_OBJECTS.find((o) => o.code === APPROVAL_INSTANCE_OBJECT)!;
      const response = await setObjectPermission(
        prm,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: instanceObject.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
          buttons: [{ buttonCode: 'adminTransfer', level: 'detail' }],
        },
        instanceObject.code,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const scoped = await prm.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
        {
          ...prm.asAdmin,
          ifMatch: 0,
          body: { targetKind: 'entity', targetCode: seeAll, seeAll: true },
        },
      );
      expect(scoped.status, await scoped.clone().text()).toBe(200);
      await makeGrantable(prm, [profile.id]);
      expect((await grant(prm, user.id, profile.id)).status).toBe(201);
      return (current: InstanceView) =>
        prm.api.request('POST', `/api/tenant/approval/instances/${current.id}/admin-transfer`, {
          ...w.as(user.id),
          ifMatch: current.revision,
          body: { taskId: task.id, toUserId: w.manager.userId, reason: '合成转交' },
        });
    };
    const employmentAdmin = await admin(EMPLOYMENT.code);
    expect((await employmentAdmin(view)).status).not.toBe(200);
    expect(w.pending(await w.instance(offer.id)).map((t) => t.assigneeUserId)).toEqual([w.head.userId]);
    const offerAdmin = await admin(OFFER_DEFINITION.code);
    const moved = await offerAdmin(await w.instance(offer.id));
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(w.pending(await w.instance(offer.id)).map((t) => t.assigneeUserId)).toEqual([w.manager.userId]);
  });

  it('真实授权器下的发起口径：Offer 编辑开关 + 范围即可单个 / 批量发起；范围外的 Offer 404；无编辑权 403', async () => {
    const w = await world('submit-real');
    await w.permit(OFFER_DEFINITION, true);
    await w.scopeToDepartment();
    const real = (path: string, ifMatch: number, body: Record<string, unknown> = {}) =>
      w.prm.api.request('POST', `/api/tenant/offers${path}`, { ...w.as(w.applicant.userId), ifMatch, body });
    const offer = await w.offer(w.applicant);
    const submitted = await real(`/${offer.id}/approval`, offer.revision);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect(await w.approvalStatus(offer)).toBe('approving');

    const inside = await w.offer(w.applicant);
    const batch = await real('/batch-approvals', 0, { offerIds: [inside.id] });
    expect(batch.status, await batch.clone().text()).toBe(201);
    const far = await w.offer(w.applicant, await w.org(`范围外部门${uniqueSuffix()}`));
    expect((await real(`/${far.id}/approval`, far.revision)).status).toBe(404);
    expect((await real('/batch-approvals', 0, { offerIds: [far.id] })).status).toBe(404);

    await w.permit(OFFER_DEFINITION, false);
    const denied = await w.offer(w.applicant);
    expect((await real(`/${denied.id}/approval`, denied.revision)).status).toBe(403);
  });
});
