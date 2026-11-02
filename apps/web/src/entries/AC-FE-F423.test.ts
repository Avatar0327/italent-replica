/**
 * F-423 办理入职表单合同区（docs/02_业务建模/34 末尾「补充：F-434」）：
 * 北森入职表单从待入职合同预填「法人公司」；操作人把它清掉、合同区全空时照样能办理入职，不生成合同、不校验终止日期；
 * 合同区有任一值时，公司 / 类型 / 期限类型必填，固定期限再要求终止日期。
 * 预填来源是待入职列表行的 contractCompanyId（entry-views.ts，BE-14b2）；夹具按后端响应形状（smoke/entry-fixtures.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient, PageResult } from '../foundation/client.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { completeBody, contractFields, contractRequired, editable, readEntry, type Row } from './model.js';

const entryId = '71000000-0000-4000-8000-000000000001';
const personId = '71000000-0000-4000-8000-000000000002';
const departmentId = '71000000-0000-4000-8000-000000000003';
const companyId = '71000000-0000-4000-8000-000000000004';
const typeId = '71000000-0000-4000-8000-000000000005';
const otherCompanyId = '71000000-0000-4000-8000-000000000007';

/** 待入职列表行（GET pending-entries，EntryViewItem 全字段）。 */
const listRow = (revision: number, contractCompanyId: string | null): Row => ({
  id: entryId,
  employeeId: personId,
  code: 'SYN-ENTRY-001',
  name: '合成入职甲',
  kind: 'hire',
  effectiveDate: '2026-10-15',
  employeeStatus: 1,
  entryStatus: 0,
  departmentId,
  revision,
  probation: null,
  contractStartDate: '2026-10-15',
  contractEndDate: null,
  contractCompanyId,
  probationMonths: null,
  cancelRemark: null,
});

function fakeApi(revision: number, list: Row[] = []): ApiClient {
  const fields = { departmentId, employType: 'internal' };
  const responses: Record<string, unknown> = {
    [`/api/tenant/employment/businesses/${entryId}`]: {
      id: entryId,
      employeeId: personId,
      revision,
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2026-10-15',
      fields,
      customFields: {},
      employeeStatus: 1,
      entryStatus: 0,
    },
    [`/api/tenant/employment/records/${entryId}`]: {
      id: entryId,
      employeeId: personId,
      revision,
      effectiveDate: '2026-10-15',
      fields,
      customFields: {},
    },
    [`/api/tenant/employment/employees/${personId}`]: { id: personId, name: '合成入职甲', code: 'SYN-ENTRY-001' },
  };
  const request = (path: string) => {
    if (path.startsWith('/api/tenant/employment/pending-entries?'))
      return Promise.resolve({ items: list, total: list.length } satisfies PageResult<Row>);
    if (!(path in responses)) throw new Error(`unexpected ${path}`);
    return Promise.resolve(responses[path]);
  };
  return { request } as unknown as ApiClient;
}

const blankContract: Values = { companyId: null, typeId: null, termType: null, termMonths: null, endDate: null };

describe('F-423 入职表单法人公司预填自待入职合同', () => {
  it('待入职合同带公司：表单初值的法人公司 = 待入职合同公司', async () => {
    const data = await readEntry(fakeApi(4), listRow(4, companyId));
    expect(data.companyId).toBe(companyId);
    expect(projectFields(data, editable)).toMatchObject({ companyId, typeId: null, termType: null, endDate: null });
  });

  it('没有待入职合同 / 公司为空：不预填', async () => {
    const data = await readEntry(fakeApi(4), listRow(4, null));
    expect(data.companyId ?? null).toBeNull();
  });

  it('列表版本落后时重读：用最新行的待入职合同公司，不拿旧行的值', async () => {
    const data = await readEntry(fakeApi(5, [listRow(5, otherCompanyId)]), listRow(4, companyId));
    expect(data.revision).toBe(5);
    expect(data.companyId).toBe(otherCompanyId);
  });
});

describe('F-423 合同区全空 / 部分填写（锁定现有规则）', () => {
  const fields = ['probation', ...contractFields, 'probationStartDate'];

  it('清掉预填公司、合同区全空：提交体不带 contract，任何合同字段都不必填', () => {
    const values = { probation: false, ...blankContract };
    expect(completeBody(values, '2026-10-15', fields)).toEqual({ probation: false });
    for (const name of contractFields) expect(contractRequired(name, values)).toBe(false);
  });

  it('只留预填公司：合同类型、期限类型必填；未选固定期限时终止日期不必填', () => {
    const values = { ...blankContract, companyId };
    expect(contractRequired('typeId', values)).toBe(true);
    expect(contractRequired('termType', values)).toBe(true);
    expect(contractRequired('companyId', values)).toBe(true);
    expect(contractRequired('endDate', values)).toBe(false);
    expect(contractRequired('endDate', { ...values, termType: 'fixed' })).toBe(true);
  });

  it('保留预填公司并补全：提交体带公司，不带生效日（生效日由后端取入职日）', () => {
    const values = { probation: false, ...blankContract, companyId, typeId, termType: 'indefinite' };
    const body = completeBody(values, '2026-10-15', fields);
    expect(body).toEqual({ probation: false, contract: { companyId, typeId, termType: 'indefinite' } });
  });
});
