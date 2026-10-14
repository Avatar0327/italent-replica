/// <reference types="vite/client" />
import { compareText, moduleName } from '../foundation/page-registry.js';

export interface DecisionAnnotation {
  original: string;
  decision: string;
  decisions: readonly string[];
  level: 'L1' | 'L2' | 'L3';
}
type Notes = Record<string, DecisionAnnotation>;

/**
 * 注释自注册（F-125 / DEC-476）：各模块在 `src/<模块>/annotations.ts` 导出 `notes`，这里汇总给根 Provider。
 * 键重复直接报错，不再靠展开顺序静默覆盖；结果按键排序，与文件遍历顺序无关。
 */
export function collectAnnotations(modules: Record<string, unknown>) {
  const notes: Notes = {};
  const owners: Record<string, string> = {};
  const found = Object.keys(modules)
    .sort(compareText)
    .flatMap((key) => {
      const module = moduleName(key);
      const items = (modules[key] as { notes?: Notes } | undefined)?.notes;
      if (!items || typeof items !== 'object')
        throw new Error(`注释登记缺少导出：${module}/annotations.ts 须导出 notes`);
      return Object.entries(items).map(([id, note]) => ({ id, note, module }));
    })
    .sort((a, b) => compareText(a.id, b.id));
  for (const { id, note, module } of found) {
    if (owners[id] !== undefined) throw new Error(`注释登记重复：${id}（${owners[id]} 与 ${module}）`);
    notes[id] = note;
    owners[id] = module;
  }
  return { notes, owners };
}

const collected = collectAnnotations(import.meta.glob('../*/annotations.ts', { eager: true }));
export const annotations: Notes = collected.notes;
export const annotationOwners: Readonly<Record<string, string>> = collected.owners;
