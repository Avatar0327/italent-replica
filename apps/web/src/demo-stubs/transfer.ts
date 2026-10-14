export interface TransferListRow {
  id: string;
  name: string;
  code: string;
  effectiveDate: string;
  type: string;
  beforeDepartment: string;
  department: string;
  beforePosition: string;
  position: string;
  status: 'running' | 'approved' | 'effective';
}
// DEC-456：现有任职 API 没有跨员工调动列表。合成展示数据不可作为真实业务命令的输入。
export function transferExamples(): TransferListRow[] {
  return [
    {
      id: 'demo-transfer-1',
      name: '林晓（合成）',
      code: 'DEMO-001',
      effectiveDate: '2026-11-01',
      type: '部门间调动',
      beforeDepartment: '产品研发中心',
      department: '企业服务事业部',
      beforePosition: '产品专员',
      position: '产品经理',
      status: 'running',
    },
    {
      id: 'demo-transfer-2',
      name: '陈安（合成）',
      code: 'DEMO-002',
      effectiveDate: '2026-11-01',
      type: '职务职位调整',
      beforeDepartment: '市场部',
      department: '市场部',
      beforePosition: '市场专员',
      position: '市场主管',
      status: 'approved',
    },
    {
      id: 'demo-transfer-3',
      name: '周宁（合成）',
      code: 'DEMO-003',
      effectiveDate: '2026-10-01',
      type: '部门间调动',
      beforeDepartment: '运营中心',
      department: '客户成功部',
      beforePosition: '运营专员',
      position: '客户成功专员',
      status: 'effective',
    },
  ];
}
