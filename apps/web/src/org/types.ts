/** 组织详情按查看人的字段权限裁剪：name / remarks / parents 可能缺省（不可见即不可编辑，S1-P2-05）。 */
export interface Organization {
  id: string;
  name?: string;
  revision: number;
  remarks?: string | null;
  parents?: { admin?: { parentId: string | null; sequence?: number | null } };
}
export interface ChangeModel {
  name: string;
  parentId: string;
  remarks: string;
  addEmployment: '' | 'yes' | 'no';
}
