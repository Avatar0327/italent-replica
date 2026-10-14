import type { Values } from './store.js';

/** 复合字段部分转只读时，以服务端结构为准；只把仍可编辑的子字段从同一稳定行的草稿投影回来。 */
export function editableRows(latest: Values[], draft: Values[], key: string, fields: readonly string[]): Values[] {
  return latest.map((row) => ({
    ...row,
    ...Object.fromEntries(
      Object.entries(draft.find((item) => row[key] !== undefined && item[key] === row[key]) ?? {}).filter(([field]) =>
        fields.includes(field),
      ),
    ),
  }));
}
