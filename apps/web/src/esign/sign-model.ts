// F-481 §8.2、§8.3：签署记录与我的签署共用的展示口径。界面只显示中文，不露 status / currentNode / scene 英文码。
import { m } from './messages.js';

export interface Named {
  readonly id?: string;
  readonly name?: string;
}
/** 签署中按当前节点细分（待员工签署 / 待企业确认）；其余状态与识别不了的值按字典取，取不到显示占位。 */
export function statusText(status: unknown, node: unknown): string {
  if (status === 'signing' && typeof node === 'string' && m.signingAt[node]) return m.signingAt[node];
  return (typeof status === 'string' && m.status[status]) || m.missing;
}
export const sceneText = (scene: unknown) => (typeof scene === 'string' && m.sceneLabels[scene]) || m.missing;
export const nameText = (value?: Named | null) => value?.name || m.missing;
export const fileText = (names: readonly (string | undefined)[]) =>
  names.filter(Boolean).join(m.fileSeparator) || m.missing;

/** 行必须带 id 与非负整数版本：写命令要用它们，缺了就当读取结果无效，不让无效行进入勾选或确认。 */
export function rowsOf<T extends { id: string; revision: number }>(items: unknown): T[] {
  if (!Array.isArray(items)) throw new Error(m.invalidList);
  return items.map((item: Partial<T> | null) => {
    if (typeof item?.id !== 'string' || !item.id || !Number.isSafeInteger(item.revision) || item.revision! < 0)
      throw new Error(m.invalidList);
    return item as T;
  });
}
