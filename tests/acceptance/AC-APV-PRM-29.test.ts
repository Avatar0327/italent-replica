/**
 * AC-PRM-29 / DEC-057 审批人最小披露：详情只显示本节点表单字段并按审批人字段权限裁剪；
 * 审批不授予员工档案、履历、子集、附件的数据范围；审批完成后仍按本人当前权限显示。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  grantVisibleFields,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type InstanceView,
} from './AC-APV-support.js';
import { createProfile } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('AC-PRM-29 审批人最小披露', () => {
  it('B 只看本节点表单字段（且按字段权限裁剪），对员工档案 / 履历 / 子集 / 附件的请求按无数据权限处理', async () => {
    const db = database().db;
    const w = await approvalWorld(db, 'apv-disclosure');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    // DEC-205：显式空经理配置替代后备字段；本例仅使用下方授予的可见字段，保留职级隐藏断言。
    await createProfile(world, 'department_manager_self_service');
    // B = 调入部门负责人：能看 部门、生效日期、地点、备注 字段，但没有任何数据范围。
    // 业务日期是本单新内容，看不到即为盲审（PR #35 第二轮清单 3）。
    await grantVisibleFields(world, s.inHead.userId, ['id', 'departmentId', 'effectiveDate', 'place', 'remarks']);
    // Q-M0-71：负责人默认派生经理范围；本用例明确配置空范围，继续验证审批不会突破它。
    const emptyScope = await world.api.request('PUT', `/api/tenant/permission/scopes/${s.inHead.userId}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [] },
    });
    expect(emptyScope.status, await emptyScope.clone().text()).toBe(200);
    await w.publishedProcess({
      nodes: [
        { key: 'in_head', approver: 'record_department_head', formFields: ['departmentId', 'levelId', 'place'] },
        { key: 'out_head', approver: 'latest_record_department_head' },
      ],
    });
    const draft = await w.application(s.subject.employeeId, {
      departmentId: s.to,
      place: '新地点',
      remarks: '不在表单',
    });
    const submitted = await w.submit(draft);
    const real = tenantApi(db, { authorize: undefined, clock: w.clock });
    const asB = w.as(s.inHead.userId);
    const read = async () => {
      const response = await real.request('GET', `/api/tenant/approval/instances/${submitted.id}`, asB);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as InstanceView;
    };
    const view = await read();
    expect(Object.keys(view.form.values).sort()).toEqual(['departmentId', 'place']);
    expect(view.form.values).toMatchObject({ departmentId: s.to, place: '新地点' });
    expect(JSON.stringify(view.form)).not.toContain('不在表单');

    const e = s.subject.employeeId;
    for (const path of [
      `/api/tenant/employment/employees/${e}`,
      `/api/tenant/employment/employees/${e}/records`,
      `/api/tenant/employment/businesses/${draft.id}`,
      `/api/tenant/personnel/employees/${e}`,
      `/api/tenant/personnel/employees/${e}/subsets/education`,
      `/api/tenant/personnel/employees/${e}/history`,
    ]) {
      const response = await real.request('GET', path, asB);
      expect([403, 404], `${path} -> ${response.status}`).toContain(response.status);
    }
    const attachment = await real.request('POST', `/api/tenant/personnel/employees/${e}/attachments`, {
      ...asB,
      ifMatch: 0,
      body: { purpose: 'photo', filename: 'a.png', contentType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) },
    });
    expect([403, 404]).toContain(attachment.status);

    const approved = await real.request('POST', `/api/tenant/approval/tasks/${view.tasks[0]!.id}/approve`, {
      ...asB,
      ifMatch: view.revision,
      body: {},
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const after = await read();
    expect(after.actions).toEqual([]);
    expect(Object.keys(after.form.values).sort()).toEqual(['departmentId', 'place']);
    const stranger = await w.member('无关用户');
    expect((await real.request('GET', `/api/tenant/approval/instances/${submitted.id}`, w.as(stranger))).status).toBe(
      404,
    );
  });
});

describe('清单 8：标题不含个人数据', () => {
  it('标题与待办只显示审批类型，不含员工姓名', async () => {
    const w = await approvalWorld(database().db, 'apv-title');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect(view.title).toBe('调动申请');
    const todos = await w.json<{ items: { title: string }[] }>(
      await w.request(s.outHead.userId, 'GET', '/api/tenant/approval/todos'),
    );
    expect(todos.items.map((item) => item.title)).toEqual(['调动申请']);
  });
});
