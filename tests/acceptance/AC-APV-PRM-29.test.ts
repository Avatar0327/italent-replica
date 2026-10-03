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
  transferScene,
  type InstanceView,
} from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('AC-PRM-29 审批人最小披露', () => {
  it('B 只看本节点表单字段（且按字段权限裁剪），对员工档案 / 履历 / 子集 / 附件的请求按无数据权限处理', async () => {
    const db = database().db;
    const w = await approvalWorld(db, 'apv-disclosure');
    const s = await transferScene(w);
    const world = await permissionAdmin(w);
    // B = 调入部门负责人：能看 部门、地点、备注 字段，但没有任何数据范围。
    await grantVisibleFields(world, s.inHead.userId, ['id', 'departmentId', 'place', 'remarks']);
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
