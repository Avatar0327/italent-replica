import { useTestDb } from '@italent/testkit';
import { TRANSFER_DETAIL_VIEW } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';

const database = useTestDb();
describe('DEC-118 / DEC-057 调动详情映射', () => {
  it('类型原因来自业务元数据，只出现在节点白名单中，合同仍延期', async () => {
    const w = await approvalWorld(database().db, 'trfb-detail');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'review',
          approver: 'latest_record_department_head',
          formFields: ['departmentId', 'effectiveDate', 'transferTypeCode', 'isStoreManager'],
          editableFields: [],
        },
      ],
    });
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
    );
    const response = await w.request(
      w.hr.id,
      'POST',
      `/api/tenant/employment/transfers/employees/${s.subject.employeeId}`,
      {
        ifMatch: employee.revision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          reasonCode: 'lateral',
          mode: 'application',
          effectiveDate: '2026-10-10',
          fields: { departmentId: s.to, isStoreManager: true, addedSubordinateIds: [s.outHead.employeeId] },
        },
      },
    );
    const draft = await w.json<{ id: string; revision: number }>(response, 201);
    const submitted = await w.submit(draft);
    const detail = await w.detail(submitted.id, s.outHead.userId);
    expect(detail.form.values).toHaveProperty('transferTypeCode', 'cross_department');
    expect(detail.form.values).not.toHaveProperty('reasonCode');
    expect(detail.form.values).toHaveProperty('isStoreManager', true);
    expect(detail.form.values).not.toHaveProperty('addedSubordinateIds');
    expect(TRANSFER_DETAIL_VIEW.find((item) => item.code === 'AddSubordinate')).toMatchObject({
      status: 'delivered',
      field: 'addedSubordinateIds',
    });
    expect(TRANSFER_DETAIL_VIEW.find((item) => item.code === 'ChangeReason')).toMatchObject({
      status: 'delivered',
      field: 'reasonCode',
    });
    expect(TRANSFER_DETAIL_VIEW.find((item) => item.code === 'IsChangeContract')).toMatchObject({
      status: 'deferred',
      deferredTo: 'R1-T10',
    });
  });
});
