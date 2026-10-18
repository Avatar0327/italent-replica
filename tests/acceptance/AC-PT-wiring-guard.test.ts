/**
 * AC-PT-wiring 依赖图守卫的 AST 实现自测（PT-3a 审查 P3①）：负例用虚拟文件系统构造各种绕路引用 index.ts / @italent/api，
 * 旧实现（按 `from|import(` 的正则）认不出裸 `import './index.js'`、`export * from`、`require`、目录入口，这些用例在旧实现下是红的；
 * 反例保证注释 / 字符串 / 类型导入不误报。
 */
import { describe, expect, it } from 'vitest';
import { importChainTo, runtimeSpecifiers, type SourceHost } from './support/import-graph.js';

const ROOT = '/repo/apps/api/src';
const INDEX = `${ROOT}/index.ts`;

function host(files: Record<string, string>): SourceHost {
  return { read: (file) => files[file] };
}
const chain = (files: Record<string, string>, entry = '/repo/tests/entry.ts') =>
  importChainTo(entry, { files: [INDEX], packages: ['@italent/api'] }, host(files));

describe('runtimeSpecifiers：只认运行时模块引用', () => {
  it.each([
    ["import './index.js';", ['./index.js']],
    ["import { a } from './a.js';", ['./a.js']],
    ["export * from './b.js';", ['./b.js']],
    ["export { c } from './c.js';", ['./c.js']],
    ["const m = await import('./d.js');", ['./d.js']],
    ["import e = require('./e.js');", ['./e.js']],
    ["const f = require('./f.js');", ['./f.js']],
    ["import type { T } from './t.js'; export type * from './u.js';", []],
    ["// import './x.js'\nconst s = \"from './y.js'\"; const t = `import('./z.js')`;", []],
    ["/* export * from './w.js' */ const n = 1;", []],
  ])('%s', (text, expected) => {
    expect(runtimeSpecifiers('/repo/a.ts', text)).toEqual(expected);
  });
});

describe('importChainTo：沿静态依赖图找 index.ts / @italent/api', () => {
  const entry = '/repo/tests/entry.ts';
  it.each([
    ['直接 from', "import { x } from '../apps/api/src/index.js';"],
    ['裸 import（无 from）', "import '../apps/api/src/index.js';"],
    ['再导出', "export * from '../apps/api/src/index.js';"],
    ['动态 import', "export const load = () => import('../apps/api/src/index.js');"],
    ['require', "const api = require('../apps/api/src/index.js');"],
    ['目录入口', "import '../apps/api/src';"],
    ['包名', "import '@italent/api';"],
  ])('%s → 命中', (_name, text) => {
    expect(chain({ [entry]: text, [INDEX]: '' })).not.toBeNull();
  });

  it('多层绕路：入口 → 夹具 → 辅助 → 裸 import index；返回完整链', () => {
    const found = chain({
      [entry]: "import './support/a.js';",
      '/repo/tests/support/a.ts': "import { h } from './b.js';",
      '/repo/tests/support/b.ts': "import '../../apps/api/src/index.js';",
      [INDEX]: '',
    });
    expect(found).toEqual([entry, '/repo/tests/support/a.ts', '/repo/tests/support/b.ts', INDEX]);
  });

  it('不命中：只引用 app.ts；注释 / 字符串 / 类型导入里的 index 不算；循环引用能结束', () => {
    expect(
      chain({
        [entry]: [
          "import { createApp } from '../apps/api/src/app.js';",
          "import type { Api } from '../apps/api/src/index.js';",
          "// import '../apps/api/src/index.js'",
          'const note = "from \'../apps/api/src/index.js\'";',
        ].join('\n'),
        [`${ROOT}/app.ts`]: "import './app.js'; import './loop.js';",
        [`${ROOT}/loop.ts`]: "import './app.js';",
        [INDEX]: '',
      }),
    ).toBeNull();
  });
});
