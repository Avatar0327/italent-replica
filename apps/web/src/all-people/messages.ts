import { EMPLOYEE_STATUS_LABELS } from '@italent/domain';

export const m = {
  title: '全部人员',
  employee: '员工',
  employeeHint: '请选择员工',
  name: '姓名',
  nameHint: '请输入姓名',
  email: '邮箱',
  emailHint: '请输入邮箱',
  employmentForm: '用工形式',
  employType: '雇佣关系',
  serviceType: '任职类型',
  primary: '主职',
  employeeStatus: '人员状态',
  reset: '清空筛选',
  total: (total: number) => `共${total}条`,
  employTypes: { internal: '内部员工', intern: '实习生', external: '外部人员' } as Readonly<Record<string, string>>,
  statuses: EMPLOYEE_STATUS_LABELS as Readonly<Record<number, string>>,
};
