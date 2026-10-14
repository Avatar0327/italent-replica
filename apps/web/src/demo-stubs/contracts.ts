import type { Filters, Row, View } from '../contracts/model.js';
// DEC-456：独立合成数据，不补入服务端记录，也不声明为原站业务规则。
export const contractTypes = [
  { id: 'demo-labor', code: 'DEMO-LABOR', name: '劳动合同', enabled: true, displayOrder: 1 },
  { id: 'demo-intern', code: 'DEMO-INTERN', name: '实习协议', enabled: true, displayOrder: 2 },
  { id: 'demo-other', code: 'DEMO-OTHER', name: '其他', enabled: false, displayOrder: 3 },
];
export const employmentExample = {
  entryDate: '2025-01-01',
  organization: '合成示例机构',
  department: '合成研发部',
  job: '合成工程师',
  manager: '合成经理甲',
  dottedManager: '合成经理乙',
};
export const historyExample = ['2025-01-01：新建合成合同（版本 1）', '2026-01-01：变更合成合同（版本 2）'];
const rows: Row[] = [
  {
    id: 'demo-contract-a',
    name: '合成甲',
    email: 'demo-a@example.com',
    code: 'DEMO-001',
    employeeId: '合成甲',
    number: 'DEMO-CT-A',
    typeId: 'demo-labor',
    companyId: '合成科技公司',
    termType: 'fixed',
    effectiveDate: '2026-01-01',
    endDate: '2027-06-30',
    signingCount: 2,
    status: 'valid',
    approvalStatus: 'effective',
    location: '合成园区',
    ...employmentExample,
  },
  {
    id: 'demo-contract-b',
    name: '合成乙',
    email: 'demo-b@example.com',
    code: 'DEMO-002',
    employeeId: '合成乙',
    number: 'DEMO-CT-B',
    typeId: 'demo-intern',
    companyId: '合成科技公司',
    termType: 'fixed',
    effectiveDate: '2025-01-01',
    endDate: '2026-01-01',
    signingCount: 1,
    status: 'terminated',
    approvalStatus: 'effective',
    location: '合成园区',
    ...employmentExample,
  },
];
export function previewContracts(filters: Filters, view: View): Row[] {
  const samples =
    view === 'missing'
      ? rows.map(({ name, email, code, ...rest }) => ({
          id: rest.id,
          employeeId: rest.employeeId,
          name,
          email,
          code,
          typeId: rest.typeId,
          ...employmentExample,
        }))
      : rows;
  return samples.filter((row: Row) =>
    Object.entries(filters).every(([key, input]) => {
      if (!input || input.length === 0) return true;
      if (key === 'from') return typeof row.endDate === 'string' && row.endDate >= String(input);
      if (key === 'to') return typeof row.endDate === 'string' && row.endDate <= String(input);
      if (key === 'typeId') return (Array.isArray(input) ? input : [input]).includes(String(row.typeId ?? ''));
      return String(row[key] ?? '').includes(String(input));
    }),
  );
}
export function demoCsv(filters: Filters, view: View) {
  const items = previewContracts(filters, view);
  const keys = Object.keys(items[0] ?? {});
  const cell = (input: unknown) => `"${String(input ?? '').replaceAll('"', '""')}"`;
  return (
    '\uFEFF' +
    [keys, ...items.map((row) => keys.map((key) => row[key]))].map((row) => row.map(cell).join(',')).join('\r\n')
  );
}
