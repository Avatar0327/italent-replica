export interface Row {
  id: string;
  revision: number;
  name?: string;
  [key: string]: unknown;
}
export interface Field {
  key: string;
  label: string;
  kind?: 'number' | 'text' | 'boolean' | 'select' | 'targets' | 'references' | 'grades';
  required?: boolean;
  /** 创建请求必须包含此字段；与数组是否允许为空的值校验分开。 */
  createRequiresEdit?: boolean;
  nullable?: boolean;
  createOnly?: boolean;
  multiple?: boolean;
  max?: number;
  options?: { value: string | boolean; label: string }[];
  source?: string;
}
export interface Resource {
  key: string;
  title: string;
  module: 'talent' | 'qualification';
  object: string;
  owner?: string;
  form?: string;
  fields: Field[];
  columns: string[];
  note: string;
}
