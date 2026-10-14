/**
 * F-080（DEC-375①）：内置字体是二进制资源，不属于 F-039 的证据闭包——闭包 / 摘要只认 TypeScript 源码单元：
 * - 字体 / 图片等资源文件的 import 说明符被显式当作资源跳过：不展开、不进摘要、也不记 import-unresolvable；
 * - 真实登记表 required/digests.ts 里没有任何非 .ts 文件、也没有 assets/ 下的路径；
 * - 导出文件相关的真实单元（renderPng / renderPdf）的闭包只含 .ts 依赖，且没有未解析项。
 */
import { describe, expect, it } from 'vitest';
import { closureOf, createClosureEnv, type SourceReader } from './support/route-policy/evidence-closure.js';
import { EVIDENCE_BOUNDARY } from './support/route-policy/evidence-boundary.js';
import { findUnitNode, repoSource } from './support/route-policy/evidence.js';
import { DIGESTS, GRAPH, NODE_DIGESTS } from './support/route-policy/required/digests/index.js';

const FILES: Record<string, string> = {
  'apps/api/src/modules/x/a.ts': [
    "import fontFile from './font.ttf';",
    "import { helper } from './b.js';",
    'export function unit() {',
    '  return [fontFile, helper()];',
    '}',
  ].join('\n'),
  'apps/api/src/modules/x/b.ts': 'export function helper() {\n  return 1;\n}\n',
};
const reader: SourceReader = (file) => {
  const text = FILES[file];
  if (text === undefined) throw new Error(`没有文件 ${file}`);
  return text;
};
const fileOf = (id: string) => id.slice(0, id.indexOf('#'));

describe('AC-PRM-FW-F080 字体等二进制资源不进 F-039 闭包', () => {
  it('资源文件的 import 被跳过：既不展开成依赖，也不记 import-unresolvable', () => {
    const env = createClosureEnv(reader, EVIDENCE_BOUNDARY, findUnitNode);
    const closure = closureOf(env, 'apps/api/src/modules/x/a.ts#unit');
    expect([...closure.deps.keys()]).toEqual(['apps/api/src/modules/x/b.ts#helper']);
    expect(closure.unresolved).toEqual([]);
  });

  it('真实登记表（图存储：单元摘要、节点摘要、直接依赖图）里只有 .ts 源码，没有 assets/ 下的任何文件', () => {
    const files = new Set<string>(Object.keys(DIGESTS));
    for (const id of Object.keys(NODE_DIGESTS)) files.add(fileOf(id));
    for (const [id, deps] of Object.entries(GRAPH)) {
      files.add(fileOf(id));
      for (const dep of deps) if (!dep.startsWith('#')) files.add(fileOf(dep));
    }
    expect(files.size).toBeGreaterThan(100);
    for (const file of files) {
      expect(file, file).toMatch(/\.ts$/);
      expect(file, file).not.toMatch(/(^|\/)assets\//);
    }
  });

  it('导出文件的真实单元闭包只含 .ts 依赖，没有未解析项', () => {
    const env = createClosureEnv(repoSource, EVIDENCE_BOUNDARY, findUnitNode);
    for (const unit of ['renderPng', 'renderPdf']) {
      const closure = closureOf(env, `apps/api/src/modules/survey360/export-files.ts#${unit}`);
      expect(closure.deps.size, unit).toBeGreaterThan(3);
      expect(closure.unresolved, unit).toEqual([]);
      for (const id of closure.deps.keys()) expect(fileOf(id), `${unit} → ${id}`).toMatch(/\.ts$/);
    }
  });
});
