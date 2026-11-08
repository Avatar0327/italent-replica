/**
 * AC-APV-F478-16 / 17（F-478 S3，设计 §5.1 / §5.2）：「主体员工本人」「系统管理员」两个新审批人来源。
 * 保存走真实 HTTP + 真实库，来源误用统一 422（DEC-697）；运行取人走真实提交与待办。
 */
import { APPROVAL_TYPES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld } from './AC-APV-support.js';
import {
  addAdminRecord,
  failureOf,
  node,
  readProcess,
  revokeMember,
  saveSingleNode,
  subjectEmployeeSource,
  systemAdminSource,
  unlinkAccount,
} from './AC-APV-F478-s3-support.js';

const database = useTestDb();
const SINGLE_SUBJECT = ['regularization', 'intern_regularization', 'leave', 'retirement', 'transfer'] as const;
const MULTI_SUBJECT = ['talent_review_result', 'offer', 'offer_batch', 'org_adjustment'] as const;
const NOT_SINGLE = '只能用于单主体审批';
const NO_RECUSAL = '时不能开启本人回避或主体回避';

async function savedNode(w: ApprovalWorld, type: string, approver: { type: string; value: string }) {
  const response = await saveSingleNode(w, type, approver, { avoidSelf: false, avoidSubjects: false });
  expect(response.status, `${type}：${await response.clone().text()}`).toBe(201);
  const saved = (await response.json()) as { id: string };
  return (await readProcess(w, saved.id)).latestVersion.nodes[0]!;
}

describe('AC-APV-F478-16 新来源保存与来源误用', () => {
  it.each(SINGLE_SUBJECT)('%s：主体员工本人（两项回避均关）保存并原样读回', async (type) => {
    const w = await approvalWorld(database().db, `f478s3-subj-${type}`);
    const stored = await savedNode(w, type, subjectEmployeeSource);
    expect(stored.approver).toEqual(subjectEmployeeSource);
    expect(stored.actions).toMatchObject({ avoidSelf: false, avoidSubjects: false });
  });

  it('系统管理员：任一审批类型都能保存并原样读回（含 Offer / 组织调整）', async () => {
    const w = await approvalWorld(database().db, 'f478s3-sysadmin-types');
    for (const type of Object.keys(APPROVAL_TYPES)) {
      const stored = await savedNode(w, type, systemAdminSource);
      expect(stored.approver, type).toEqual(systemAdminSource);
    }
  });

  it.each(MULTI_SUBJECT)('%s：多主体类型选主体员工本人 → 422 来源误用', async (type) => {
    const w = await approvalWorld(database().db, `f478s3-multi-${type}`);
    const failure = await failureOf(await saveSingleNode(w, type, subjectEmployeeSource, { avoidSelf: false }));
    expect(failure).toMatchObject({ status: 422, code: 'APPROVAL_SOURCE_INVALID', reason: 'APPROVAL_DEFINITION_INVALID' });
    expect(failure.violations).toContain(`节点 one 的审批人“主体员工本人”${NOT_SINGLE}`);
  });

  it.each([{ avoidSelf: true }, { avoidSubjects: true }, { avoidSelf: true, avoidSubjects: true }])(
    '单主体类型开启回避 %j → 422，违规原文精确',
    async (actions) => {
      const w = await approvalWorld(database().db, 'f478s3-recusal');
      const failure = await failureOf(
        await saveSingleNode(w, 'regularization', subjectEmployeeSource, { avoidSelf: false, ...actions }),
      );
      expect(failure).toMatchObject({ status: 422, code: 'APPROVAL_SOURCE_INVALID', reason: 'APPROVAL_DEFINITION_INVALID' });
      expect(failure.violations).toEqual([`节点 one 使用“主体员工本人”${NO_RECUSAL}`]);
    },
  );
});

/** 调动场景下的两节点流程：第 1 节点 = 被测来源或调出负责人，第 2 节点 = 另一个。 */
async function twoNodeRun(w: ApprovalWorld, first: 'subject' | 'head', scene: Awaited<ReturnType<typeof transferScene>>) {
  const subjectNode = node('subj', subjectEmployeeSource);
  const headNode = node('head', { type: 'department', value: 'latest_record_department_head' }, { avoidSelf: true });
  const nodes = first === 'subject' ? [subjectNode, headNode] : [headNode, subjectNode];
  await w.publishedProcess({ nodes });
  return w.application(scene.subject.employeeId, { departmentId: scene.to });
}

describe('AC-APV-F478-16 主体员工本人：运行取人', () => {
  it('HR 代发：任务派给被审批的员工本人，不派 HR，员工不被回避', async () => {
    const w = await approvalWorld(database().db, 'f478s3-subj-run');
    const scene = await transferScene(w);
    const view = await w.submit(await twoNodeRun(w, 'subject', scene));
    expect(w.pending(view).map((task) => task.assigneeUserId)).toEqual([scene.subject.userId]);
    expect(view.initiatorUserId).toBe(w.hr.id);
  });

  it.each([
    ['人员没有账号', unlinkAccount],
    ['账号已停用', revokeMember],
  ] as const)('首节点：%s → 拒绝提交 APPROVAL_FIRST_NODE_EMPTY，业务仍为草稿', async (_name, breakAccount) => {
    const w = await approvalWorld(database().db, 'f478s3-subj-empty-first');
    const scene = await transferScene(w);
    const business = await twoNodeRun(w, 'subject', scene);
    await breakAccount(w, scene.subject.userId);
    const response = await w.submitRaw(business);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: 'CONFLICT',
      message: '第一个审批节点没有审批人',
      details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' },
    });
    expect((await w.business(business.id)).status).toBe('draft');
  });

  it('中间节点：员工没有账号 → 转异常管理员', async () => {
    const w = await approvalWorld(database().db, 'f478s3-subj-empty-mid');
    const scene = await transferScene(w);
    const business = await twoNodeRun(w, 'head', scene);
    await unlinkAccount(w, scene.subject.userId);
    const view = await w.submit(business);
    const task = w.pending(view)[0]!;
    expect(task.assigneeUserId).toBe(scene.outHead.userId);
    const response = await w.taskAction(scene.outHead.userId, task.id, 'approve', view.revision);
    expect(response.status, await response.clone().text()).toBe(200);
    const next = w.pending(await w.detail(view.id));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ assigneeUserId: w.exceptionAdmin, isExceptionAdmin: true });
  });
});

describe('AC-APV-F478-17 系统管理员：取开通顺序第一位', () => {
  async function adminWorld(label: string) {
    const w = await approvalWorld(database().db, label);
    const scene = await transferScene(w);
    const dept = scene.from;
    const admins = {
      revoked: await w.person('合成已撤销管理员', dept),
      first: await w.person('合成管理员甲', dept),
      second: await w.person('合成管理员乙', dept),
      tenantAdmin: await w.person('合成租户管理员', dept),
    };
    await addAdminRecord(w, admins.tenantAdmin.userId, 'tenant_admin', '2025-01-01T00:00:00Z');
    await addAdminRecord(w, admins.revoked.userId, 'system_admin', '2025-02-01T00:00:00Z', 'revoked');
    await addAdminRecord(w, admins.second.userId, 'system_admin', '2026-01-02T00:00:00Z');
    await addAdminRecord(w, admins.first.userId, 'system_admin', '2026-01-01T00:00:00Z');
    // 另一租户的系统管理员：开通更早，也不能被本租户取到
    const other = await approvalWorld(database().db, `${label}-other`);
    const outsider = await other.person('合成他租户管理员', await other.org('他租户部门'));
    await addAdminRecord(other, outsider.userId, 'system_admin', '2024-01-01T00:00:00Z');
    await w.publishedProcess({ nodes: [node('admin', systemAdminSource)] });
    return { w, scene, admins, outsider };
  }

  async function assignee(w: ApprovalWorld, scene: Awaited<ReturnType<typeof transferScene>>) {
    const business = await w.application(scene.subject.employeeId, { departmentId: scene.to });
    return w.pending(await w.submit(business)).map((task) => task.assigneeUserId);
  }

  it('两位有效管理员取先开通的；撤销记录、租户管理员、他租户管理员都不参与', async () => {
    const { w, scene, admins, outsider } = await adminWorld('f478s3-admin-order');
    const picked = await assignee(w, scene);
    expect(picked).toEqual([admins.first.userId]);
    expect(picked).not.toContain(outsider.userId);
  });

  it('第一位账号停用后顺延到第二位', async () => {
    const { w, scene, admins } = await adminWorld('f478s3-admin-next');
    await revokeMember(w, admins.first.userId);
    expect(await assignee(w, scene)).toEqual([admins.second.userId]);
  });

  it('没有有效系统管理员（只有租户管理员）→ 首节点拒绝提交', async () => {
    const w = await approvalWorld(database().db, 'f478s3-admin-none');
    const scene = await transferScene(w);
    const tenantAdmin = await w.person('合成唯一租户管理员', scene.from);
    await addAdminRecord(w, tenantAdmin.userId, 'tenant_admin', '2025-01-01T00:00:00Z');
    await w.publishedProcess({ nodes: [node('admin', systemAdminSource)] });
    const response = await w.submitRaw(await w.application(scene.subject.employeeId, { departmentId: scene.to }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ details: { reason: 'APPROVAL_FIRST_NODE_EMPTY' } });
  });
});
