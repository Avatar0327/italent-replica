import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, grantFieldAccess, permissionAdmin, transferScene } from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const url = '/api/tenant/approval/instances';
interface Detail {
  form: { values: Record<string, unknown>; originals?: Record<string, unknown> };
}

async function transferWithReason(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      {
        key: 'review',
        approver: { type: 'department', value: 'latest_record_department_head' },
        formFields: ['effectiveDate', 'transferTypeCode', 'reasonCode', 'departmentId', 'directManagerId'],
      },
    ],
  });
  const newManager = await w.person('合成新经理', s.to);
  const business = await w.application(s.subject.employeeId, {
    departmentId: s.to,
    directManagerId: newManager.employeeId,
  });
  // 与调动模块创建时一致：调动元数据行带真实的调动类型与原因编码
  await withTenant(database().db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO transfer_requests
      (tenant_id,business_id,employee_id,initiator,transfer_type_code,reason_code,process_code)
      VALUES (${w.tenant.id},${business.id}::uuid,${s.subject.employeeId}::uuid,'hr','promotion','promotion',
        'TransferProcessNew')`),
  );
  const instance = await w.submit(business);
  return { w, s, newManager, instance };
}

describe('AC-APV-F474-3b 详情引用字段名称（P2-2）', () => {
  it('当前值与原值都并列下发原因 / 调动类型 / 部门 / 经理名称，ID 与编码保持不变', async () => {
    const { w, s, newManager, instance } = await transferWithReason('f474b-names');
    const detail = await w.json<Detail>(await w.request(s.outHead.userId, 'GET', `${url}/${instance.id}`));
    expect(detail.form.values).toMatchObject({
      reasonCode: 'promotion',
      reasonCodeName: '升职',
      transferTypeCode: 'promotion',
      transferTypeCodeName: '晋升',
      departmentId: s.to,
      departmentIdName: '调入部门',
      directManagerId: newManager.employeeId,
      directManagerIdName: '合成新经理',
    });
    expect(detail.form.originals).toMatchObject({
      departmentId: s.from,
      departmentIdName: '调出部门',
      directManagerId: s.manager.employeeId,
      directManagerIdName: '直线经理',
    });
  });

  it('只给已下发（字段可见）的引用字段附名称；看不到的字段既没有值也没有名称', async () => {
    const { w, s, instance } = await transferWithReason('f474b-names-hidden');
    const world = await permissionAdmin(w);
    await grantFieldAccess(world, s.outHead.userId, { view: ['departmentId'] });
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const detail = await w.json<Detail>(await api.request('GET', `${url}/${instance.id}`, w.as(s.outHead.userId)));
    expect(detail.form.values).toMatchObject({ departmentId: s.to, departmentIdName: '调入部门' });
    for (const key of ['directManagerId', 'directManagerIdName', 'reasonCode', 'reasonCodeName']) {
      expect(detail.form.values, key).not.toHaveProperty(key);
      expect(detail.form.originals ?? {}, key).not.toHaveProperty(key);
    }
  });
});
