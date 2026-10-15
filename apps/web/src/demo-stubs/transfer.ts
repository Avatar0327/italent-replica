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
  beforeOrganization: string;
  organization: string;
  beforeOrgFullName: string;
  orgFullName: string;
  beforeJob: string;
  job: string;
  beforeLevelCategory: string;
  levelCategory: string;
  place: string;
  handover: string;
  approver: string;
  status: 'running' | 'approved' | 'effective';
}
const company = '合成集团';
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
      beforeOrganization: company,
      organization: company,
      beforeOrgFullName: `${company}/产品研发中心`,
      orgFullName: `${company}/企业服务事业部`,
      beforeJob: '产品岗',
      job: '产品管理岗',
      beforeLevelCategory: '专业类',
      levelCategory: '专业类',
      place: '合成工作地 A',
      handover: '未发起',
      approver: '合成审批人甲',
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
      beforeOrganization: company,
      organization: company,
      beforeOrgFullName: `${company}/市场部`,
      orgFullName: `${company}/市场部`,
      beforeJob: '市场岗',
      job: '市场管理岗',
      beforeLevelCategory: '专业类',
      levelCategory: '管理类',
      place: '合成工作地 B',
      handover: '进行中',
      approver: '—',
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
      beforeOrganization: company,
      organization: company,
      beforeOrgFullName: `${company}/运营中心`,
      orgFullName: `${company}/客户成功部`,
      beforeJob: '运营岗',
      job: '客户成功岗',
      beforeLevelCategory: '专业类',
      levelCategory: '专业类',
      place: '合成工作地 A',
      handover: '已完成',
      approver: '—',
      status: 'effective',
    },
  ];
}
