export interface Organization {
  id: string;
  name: string;
  revision: number;
  remarks: string | null;
  parents: { admin?: { parentId: string | null; sequence?: number | null } };
}
export interface ChangeModel {
  name: string;
  parentId: string;
  remarks: string;
  addEmployment: '' | 'yes' | 'no';
}
