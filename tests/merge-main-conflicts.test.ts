/**
 * F-133（DEC-491④）：pnpm merge:main 对三类冲突的自动重生成，在临时 git 仓库里真实运行 scripts/merge-main.mjs。
 * 三类各 1 例：
 *   ① F-039 登记：required/declared/<模块>.ts 声明集合与 declared/index.ts 注册表，两边都加条目 → 取并集；
 *   ② 路由登记：apps/api/src/app.ts 的模块挂载与 packages/db/src/schema/index.ts 的导出，两边都加 → 两边都保留；
 *   ③ 生成文件：required/digests、baseline 等白名单内的文件 → 取 main 版本（随后重算，这里用 --no-regen 跳过）。
 * 另加一例不可自动处理的业务代码冲突：脚本停下并列出，退出码非 0，由人工解决后 --continue。
 * 重算命令（pnpm test …）在临时仓库里跑不了，端到端见 PR 描述里在真实仓库上的演练。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');
const ROUTE_POLICY = 'tests/acceptance/support/route-policy';
const DECLARED = `${ROUTE_POLICY}/required/declared`;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Files = Record<string, string>;

function sh(root: string, ...args: string[]) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function put(root: string, files: Files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

const MIGRATIONS = 'packages/db/migrations';
const BASE_MIGRATIONS: Files = {
  [`${MIGRATIONS}/meta/_journal.json`]: JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 100, tag: '0000_init', breakpoints: true }],
    },
    null,
    2,
  ),
  [`${MIGRATIONS}/0000_init.sql`]: 'CREATE TABLE init (id int);\n',
  [`${MIGRATIONS}/meta/0000_snapshot.json`]: JSON.stringify(
    { id: 'id-init', prevId: 'root', version: '7', tables: {} },
    null,
    2,
  ),
};

/** 造仓库：base 提交后分出 main 与 branch，各自在 base 上改文件；origin/main 指向 main，结束时停在 branch。 */
function buildRepo(opts: { base: Files; main: Files; branch: Files }) {
  const root = mkdtempSync(path.join(tmpdir(), `merge-main-conflicts-${randomUUID()}-`));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'));
  for (const file of readdirSync(path.join(REPO, 'scripts')).filter((f) => /^merge-main.*\.mjs$/.test(f)))
    copyFileSync(path.join(REPO, 'scripts', file), path.join(root, 'scripts', file));
  copyFileSync(path.join(REPO, '.prettierrc.json'), path.join(root, '.prettierrc.json'));
  symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'config', 'user.name', 'test');
  sh(root, 'config', 'core.autocrlf', 'false');
  put(root, { ...BASE_MIGRATIONS, ...opts.base });
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  sh(root, 'checkout', '-q', '-b', 'branch');
  put(root, opts.branch);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'branch');
  sh(root, 'checkout', '-q', 'main');
  put(root, opts.main);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'main');
  sh(root, 'update-ref', 'refs/remotes/origin/main', 'main');
  sh(root, 'checkout', '-q', 'branch');
  return root;
}

function run(root: string, ...flags: string[]) {
  const result = spawnSync(process.execPath, ['scripts/merge-main.mjs', '--no-fetch', '--no-regen', ...flags], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (root: string, file: string) => readFileSync(path.join(root, file), 'utf8');
const mergeInProgress = (root: string) => existsSync(path.join(root, '.git/MERGE_HEAD'));
const noMarkers = (text: string) => expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);

// ---------------------------------------------------------------------------------------------
// 夹具：与真实仓库同一写法（prettier 格式、单引号、尾逗号）

const declaredFile = (sections: Record<string, string[]>) => {
  const body = Object.entries(sections)
    .map(([key, items]) => `  /** ${key} 说明 */\n  ${key}: [\n${items.map((i) => `    '${i}',`).join('\n')}\n  ],\n`)
    .join('');
  return [
    "import type { ModuleDeclared } from '../../module-declared.js';",
    '',
    '/** talent 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */',
    `export const TALENT_DECLARED: ModuleDeclared = {${body ? `\n${body}` : ''}};`,
    '',
  ].join('\n');
};

const declaredIndex = (modules: string[]) =>
  [
    "import type { ModuleDeclared } from '../../module-declared.js';",
    ...modules.map((m) => `import { ${m.toUpperCase()}_DECLARED } from './${m}.js';`),
    '',
    '/** 键 = 模块名 */',
    'export const DECLARED: Readonly<Record<string, ModuleDeclared>> = {',
    ...modules.map((m) => `  ${m}: ${m.toUpperCase()}_DECLARED,`),
    '};',
    '',
  ].join('\n');

const appFile = (modules: string[]) =>
  [
    ...modules.map((m) => `import { register${m}Routes } from './modules/${m.toLowerCase()}/routes.js';`),
    '',
    'const TENANT_MODULES = [',
    ...modules.map((m) => `  register${m}Routes, // ${m} 路由`),
    '];',
    '',
  ].join('\n');

const schemaIndex = (names: string[]) => `${names.map((n) => `export * from './${n}.js';`).join('\n')}\n`;

const A = 'POST /api/tenant/talent/a';
const B = 'POST /api/tenant/talent/b';
const C = 'POST /api/tenant/talent/c';
const D = 'GET /api/tenant/talent/d';

describe('merge:main 自动重生成：三类冲突各 1 例', () => {
  const base: Files = {
    [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A] }),
    [`${DECLARED}/index.ts`]: declaredIndex(['approval']),
    'apps/api/src/app.ts': appFile(['Tenant']),
    'packages/db/src/schema/index.ts': schemaIndex(['tenancy']),
    [`${ROUTE_POLICY}/required/digests/nodes.ts`]: "export const NODES = ['base'];\n",
    [`${ROUTE_POLICY}/baseline/endpoint-counts.json`]: '{"total":10}\n',
    'apps/api/src/modules/org/service.ts': "export const LIMIT = 10;\nexport const NAME = 'org';\n",
  };

  it('① F-039 登记：声明集合各加条目与各加新种类、注册表各加模块，结果取并集且无冲突标记', () => {
    const root = buildRepo({
      base,
      main: {
        [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A, B], branchInputEndpoints: [D] }),
        [`${DECLARED}/index.ts`]: declaredIndex(['approval', 'audit']),
      },
      branch: {
        [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A, C], multiCarrierAdmission: [C] }),
        [`${DECLARED}/index.ts`]: declaredIndex(['approval', 'avatar']),
      },
    });
    const check = run(root, '--check');
    expect(check.status, check.out).toBe(0);
    expect(check.out).toContain(`${DECLARED}/talent.ts`);

    const result = run(root);
    expect(result.status, result.out).toBe(0);
    expect(mergeInProgress(root)).toBe(false);
    const talent = read(root, `${DECLARED}/talent.ts`);
    noMarkers(talent);
    for (const entry of [A, B, C, D]) expect(talent, entry).toContain(`'${entry}'`);
    // 每个种类只出现一次，条目不重复
    expect(talent.match(/'POST \/api\/tenant\/talent\/a'/g)).toHaveLength(1);
    expect(talent).toContain('sameStatusInvalidId');
    expect(talent).toContain('branchInputEndpoints');
    expect(talent).toContain('multiCarrierAdmission');
    const index = read(root, `${DECLARED}/index.ts`);
    noMarkers(index);
    for (const module of ['approval', 'audit', 'avatar']) {
      expect(index, module).toContain(`import { ${module.toUpperCase()}_DECLARED } from './${module}.js';`);
      expect(index, module).toContain(`  ${module}: ${module.toUpperCase()}_DECLARED,`);
    }
    expect(sh(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  }, 60_000);

  it('② 路由登记：模块挂载与 schema 导出各加一项，两边都保留，导入与挂载成对', () => {
    const root = buildRepo({
      base,
      main: {
        'apps/api/src/app.ts': appFile(['Tenant', 'Idp']),
        'packages/db/src/schema/index.ts': schemaIndex(['tenancy', 'idp']),
      },
      branch: {
        'apps/api/src/app.ts': appFile(['Tenant', 'Succession']),
        'packages/db/src/schema/index.ts': schemaIndex(['tenancy', 'succession']),
      },
    });
    const result = run(root);
    expect(result.status, result.out).toBe(0);
    const app = read(root, 'apps/api/src/app.ts');
    noMarkers(app);
    for (const m of ['Idp', 'Succession']) {
      expect(app).toContain(`import { register${m}Routes } from './modules/${m.toLowerCase()}/routes.js';`);
      expect(app).toContain(`  register${m}Routes, // ${m} 路由`);
    }
    // 挂载顺序有语义：本分支一侧在前，main 一侧追加在后，且稳定（重跑结果不变）
    expect(app.indexOf('registerSuccessionRoutes, //')).toBeLessThan(app.indexOf('registerIdpRoutes, //'));
    const schema = read(root, 'packages/db/src/schema/index.ts');
    noMarkers(schema);
    expect(schema).toContain("export * from './idp.js';");
    expect(schema).toContain("export * from './succession.js';");
    expect(run(root).status).toBe(0);
    expect(read(root, 'apps/api/src/app.ts')).toBe(app);
  }, 60_000);

  it('③ 生成文件：证据登记与冻结基准两边都改，取 main 版本并提示随后重算', () => {
    const root = buildRepo({
      base,
      main: {
        [`${ROUTE_POLICY}/required/digests/nodes.ts`]: "export const NODES = ['main'];\n",
        [`${ROUTE_POLICY}/baseline/endpoint-counts.json`]: '{"total":11}\n',
      },
      branch: {
        [`${ROUTE_POLICY}/required/digests/nodes.ts`]: "export const NODES = ['branch'];\n",
        [`${ROUTE_POLICY}/baseline/endpoint-counts.json`]: '{"total":12}\n',
      },
    });
    const result = run(root);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('生成物冲突取 main 版本');
    expect(read(root, `${ROUTE_POLICY}/required/digests/nodes.ts`)).toBe("export const NODES = ['main'];\n");
    expect(read(root, `${ROUTE_POLICY}/baseline/endpoint-counts.json`)).toBe('{"total":11}\n');
  }, 60_000);

  it('三类同时冲突：全部自动处理，一次合并提交，没有遗漏任何一方的登记项', () => {
    const root = buildRepo({
      base,
      main: {
        [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A, B] }),
        'apps/api/src/app.ts': appFile(['Tenant', 'Idp']),
        [`${ROUTE_POLICY}/required/digests/nodes.ts`]: "export const NODES = ['main'];\n",
      },
      branch: {
        [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A, C] }),
        'apps/api/src/app.ts': appFile(['Tenant', 'Succession']),
        [`${ROUTE_POLICY}/required/digests/nodes.ts`]: "export const NODES = ['branch'];\n",
      },
    });
    const result = run(root);
    expect(result.status, result.out).toBe(0);
    expect(sh(root, 'log', '-1', '--format=%s')).toBe('merge: 合入 main 并重算生成物');
    expect(sh(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    const talent = read(root, `${DECLARED}/talent.ts`);
    for (const entry of [A, B, C]) expect(talent).toContain(`'${entry}'`);
  }, 60_000);
});

describe('merge:main 不可自动处理的冲突保持人工', () => {
  const base: Files = {
    [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A] }),
    'apps/api/src/app.ts': appFile(['Tenant']),
    'apps/api/src/modules/org/service.ts': "export const LIMIT = 10;\nexport const NAME = 'org';\n",
  };

  it('业务代码冲突：列出文件、退出码非 0、不提交；同时能自动处理的登记照常合并，人工解决后 --continue 完成', () => {
    const root = buildRepo({
      base,
      main: {
        [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A, B] }),
        'apps/api/src/modules/org/service.ts': "export const LIMIT = 20;\nexport const NAME = 'org';\n",
      },
      branch: {
        [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: [A, C] }),
        'apps/api/src/modules/org/service.ts': "export const LIMIT = 30;\nexport const NAME = 'org';\n",
      },
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    const check = run(root, '--check');
    expect(check.status).not.toBe(0);
    expect(check.out).toContain('apps/api/src/modules/org/service.ts');

    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('业务文件冲突（须人工处理）');
    expect(result.out).toContain('apps/api/src/modules/org/service.ts');
    // 须人工清单里只有业务文件，能自动处理的登记不在其中
    const after = result.out.split('业务文件冲突（须人工处理）：\n')[1]!.split('\n');
    const manual = after.slice(
      0,
      after.findIndex((l) => !l.startsWith('  ')),
    );
    expect(manual.map((l) => l.trim())).toEqual(['apps/api/src/modules/org/service.ts']);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(mergeInProgress(root)).toBe(true);
    // 能自动处理的已处理并暂存，不夹带冲突标记
    const talent = read(root, `${DECLARED}/talent.ts`);
    noMarkers(talent);
    for (const entry of [A, B, C]) expect(talent).toContain(`'${entry}'`);
    // 业务冲突原样留给人工
    expect(read(root, 'apps/api/src/modules/org/service.ts')).toMatch(/^<{7} /m);

    writeFileSync(
      path.join(root, 'apps/api/src/modules/org/service.ts'),
      "export const LIMIT = 30;\nexport const NAME = 'org';\n",
    );
    sh(root, 'add', 'apps/api/src/modules/org/service.ts');
    const done = run(root, '--continue');
    expect(done.status, done.out).toBe(0);
    expect(mergeInProgress(root)).toBe(false);
    expect(read(root, `${DECLARED}/talent.ts`)).toContain(`'${B}'`);
  }, 60_000);

  it('登记文件里一侧改了已有条目（不是纯新增）：不猜测，留给人工并列出', () => {
    const root = buildRepo({
      base,
      main: { 'apps/api/src/app.ts': appFile(['Tenant', 'Idp']) },
      branch: {
        'apps/api/src/app.ts': appFile(['Tenant']).replace('Tenant 路由', 'Tenant 路由（改了说明）'),
      },
    });
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('业务文件冲突（须人工处理）');
    expect(result.out).toContain('apps/api/src/app.ts');
    expect(read(root, 'apps/api/src/app.ts')).toMatch(/^<{7} /m);
  }, 60_000);

  it('声明文件写法超出已知形状（不是字符串数组）：不自动处理', () => {
    const odd = (extra: string) =>
      declaredFile({ sameStatusInvalidId: [A] }).replace(
        '  ],\n};',
        `  ],\n  /** 特殊 */\n  knownGapPairs: [...OTHER, ${extra}],\n};`,
      );
    const root = buildRepo({
      base,
      main: { [`${DECLARED}/talent.ts`]: odd("['x', 'y']") },
      branch: { [`${DECLARED}/talent.ts`]: odd("['p', 'q']") },
    });
    const result = run(root);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain(`${DECLARED}/talent.ts`);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 第 1 轮审查返工（DEC-431①）：自动合并 / 提交前核对不能被绕过。四个 P2 是同一类问题——
// 按整行比较、只看单行形状、文件缺失被排除——统一改成按条目身份核对，下面每个反例都走真实入口。

const SERVICE = 'apps/api/src/modules/org/service.ts';
const SCHEMA = 'packages/db/src/schema/index.ts';
const INDEX = `${DECLARED}/index.ts`;
const service = (limit: number) => `export const LIMIT = ${limit};\nexport const NAME = 'org';\n`;

/** 登记冲突与一个业务冲突同时存在：先停在业务冲突上，再由测试模拟人工的各种“解决”方式。 */
function stopAtBusinessConflict(opts: { base: Files; main: Files; branch: Files }) {
  const withService = (files: Files, limit: number): Files => ({ ...files, [SERVICE]: service(limit) });
  const root = buildRepo({
    base: withService(opts.base, 10),
    main: withService(opts.main, 20),
    branch: withService(opts.branch, 30),
  });
  const head = sh(root, 'rev-parse', 'HEAD');
  const first = run(root);
  expect(first.status, first.out).not.toBe(0);
  expect(mergeInProgress(root)).toBe(true);
  return { root, head, first };
}

function resolveBusinessAndContinue(root: string) {
  put(root, { [SERVICE]: service(30) });
  sh(root, 'add', SERVICE);
  return run(root, '--continue');
}

const expectRefused = (root: string, head: string, result: { status: number | null; out: string }) => {
  expect(result.status, result.out).not.toBe(0);
  expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
  expect(mergeInProgress(root)).toBe(true);
};

describe('第 1 轮审查 P2-1：只处理纯新增，删除或改动分叉点已有条目转人工', () => {
  const baseDeclared = (items: string[]) => ({
    [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: items }),
  });

  it('分叉点 [A,B]：本分支删 A 加 C、main 加 D → 非零退出、不提交、冲突留给人工', () => {
    const root = buildRepo({
      base: baseDeclared([A, B]),
      branch: baseDeclared([B, C]),
      main: baseDeclared([A, B, D]),
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(mergeInProgress(root)).toBe(true);
    expect(result.out).toContain(`${DECLARED}/talent.ts`);
    expect(result.out).toContain('分叉点已有登记项');
  }, 60_000);

  it('两边分别把原有 A 改成 B、C → 非零退出、不提交', () => {
    const root = buildRepo({ base: baseDeclared([A]), branch: baseDeclared([B]), main: baseDeclared([C]) });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(result.out).toContain(`${DECLARED}/talent.ts`);
  }, 60_000);

  it('预演 --check 同样把这类文件列为须人工并以非零退出', () => {
    const root = buildRepo({ base: baseDeclared([A, B]), branch: baseDeclared([B, C]), main: baseDeclared([A, B, D]) });
    const check = run(root, '--check');
    expect(check.status, check.out).not.toBe(0);
    expect(check.out).toContain(`${DECLARED}/talent.ts`);
  }, 60_000);
});

describe('第 1 轮审查 P2-2：按条目身份识别同名异值与重复挂载', () => {
  const idx = (entries: string[], imports: string[]) =>
    [
      "import type { ModuleDeclared } from '../../module-declared.js';",
      ...imports,
      '',
      'export const DECLARED: Readonly<Record<string, ModuleDeclared>> = {',
      ...entries,
      '};',
      '',
    ].join('\n');
  const imp = (name: string, file: string) => `import { ${name} } from './${file}.js';`;
  const baseIdx = idx(
    ['  approval: APPROVAL_DECLARED,', '  audit: AUDIT_DECLARED,', '  avatar: AVATAR_DECLARED,'],
    [imp('APPROVAL_DECLARED', 'approval'), imp('AUDIT_DECLARED', 'audit'), imp('AVATAR_DECLARED', 'avatar')],
  );

  it('同一注册键两边加不同的值（同一位置，冲突处）→ 非零退出、不提交', () => {
    const withTalent = (value: string, file: string, at: 'top' | 'bottom') =>
      idx(
        at === 'top'
          ? [
              `  talent: ${value},`,
              '  approval: APPROVAL_DECLARED,',
              '  audit: AUDIT_DECLARED,',
              '  avatar: AVATAR_DECLARED,',
            ]
          : [
              '  approval: APPROVAL_DECLARED,',
              '  audit: AUDIT_DECLARED,',
              '  avatar: AVATAR_DECLARED,',
              `  talent: ${value},`,
            ],
        [
          imp('APPROVAL_DECLARED', 'approval'),
          imp('AUDIT_DECLARED', 'audit'),
          imp('AVATAR_DECLARED', 'avatar'),
          imp(value, file),
        ],
      );
    const root = buildRepo({
      base: { [INDEX]: baseIdx },
      branch: { [INDEX]: withTalent('TALENT_DECLARED', 'talent', 'bottom') },
      main: { [INDEX]: withTalent('TALENT_V2_DECLARED', 'talent-v2', 'bottom') },
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(result.out).toContain(INDEX);
  }, 60_000);

  it('同一注册键两边加不同的值，放在不同位置使 Git 无冲突自动合并 → 提交前核对非零退出、不提交', () => {
    const mk = (value: string, file: string, at: 'top' | 'bottom') =>
      idx(
        at === 'top'
          ? [
              `  talent: ${value},`,
              '  approval: APPROVAL_DECLARED,',
              '  audit: AUDIT_DECLARED,',
              '  avatar: AVATAR_DECLARED,',
            ]
          : [
              '  approval: APPROVAL_DECLARED,',
              '  audit: AUDIT_DECLARED,',
              '  avatar: AVATAR_DECLARED,',
              `  talent: ${value},`,
            ],
        [
          imp('APPROVAL_DECLARED', 'approval'),
          imp('AUDIT_DECLARED', 'audit'),
          imp('AVATAR_DECLARED', 'avatar'),
          imp(value, file),
        ],
      );
    const root = buildRepo({
      base: { [INDEX]: baseIdx },
      branch: { [INDEX]: mk('TALENT_DECLARED', 'talent', 'top') },
      main: { [INDEX]: mk('TALENT_V2_DECLARED', 'talent-v2', 'bottom') },
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(result.out).toContain('登记项重复');
    expect(result.out).toContain('talent');
  }, 60_000);

  const appWith = (comment: string, at: 'top' | 'bottom') => {
    const entries = ['  registerTenantRoutes, // Tenant 路由', '  registerIdpRoutes, // Idp 路由'];
    const avatar = `  registerAvatarRoutes, // ${comment}`;
    return [
      "import { registerTenantRoutes } from './modules/tenant/routes.js';",
      "import { registerIdpRoutes } from './modules/idp/routes.js';",
      "import { registerAvatarRoutes } from './modules/avatar/routes.js';",
      '',
      'const TENANT_MODULES = [',
      ...(at === 'top' ? [avatar, ...entries] : [...entries, avatar]),
      '];',
      '',
    ].join('\n');
  };
  const appBase = appWith('', 'top')
    .split('\n')
    .filter((l) => !l.includes('registerAvatarRoutes'))
    .join('\n');

  it('同一个挂载函数只是尾注释不同（同一位置，冲突处）→ 不保留两份，非零退出', () => {
    const root = buildRepo({
      base: { 'apps/api/src/app.ts': appBase },
      branch: { 'apps/api/src/app.ts': appWith('甲', 'bottom') },
      main: { 'apps/api/src/app.ts': appWith('乙', 'bottom') },
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(result.out).toContain('apps/api/src/app.ts');
  }, 60_000);

  it('同一个挂载函数只是尾注释不同，放在不同位置使 Git 无冲突自动合并 → 提交前核对非零退出、不提交', () => {
    const root = buildRepo({
      base: { 'apps/api/src/app.ts': appBase },
      branch: { 'apps/api/src/app.ts': appWith('甲', 'top') },
      main: { 'apps/api/src/app.ts': appWith('乙', 'bottom') },
    });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(result.out).toContain('登记项重复');
    expect(result.out).toContain('registerAvatarRoutes');
  }, 60_000);
});

describe('第 1 轮审查 P2-3：登记区里无法识别的形状不能被静默忽略', () => {
  const multiLine = (name: string, file: string) => `export {\n  ${name}One,\n  ${name}Two,\n} from './${file}.js';\n`;
  const schemaWith = (extra: string) => `export * from './tenancy.js';\n${extra}`;

  it('两边各加多行 export { … } from：自动处理不了，人工只删掉两边新增后 --continue 必须失败', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaWith('') },
      branch: { [SCHEMA]: schemaWith(multiLine('alpha', 'alpha')) },
      main: { [SCHEMA]: schemaWith(multiLine('beta', 'beta')) },
    });
    put(root, { [SCHEMA]: schemaWith('') });
    sh(root, 'add', SCHEMA);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('登记项丢失');
    expect(done.out).toMatch(/alphaOne|alphaTwo/);
  }, 60_000);

  it('多行 export 两边都在、人工也保留了：核对通过并提交（解析而不是一概拒绝）', () => {
    const { root } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaWith('') },
      branch: { [SCHEMA]: schemaWith(multiLine('alpha', 'alpha')) },
      main: { [SCHEMA]: schemaWith(multiLine('beta', 'beta')) },
    });
    put(root, { [SCHEMA]: schemaWith(multiLine('alpha', 'alpha') + multiLine('beta', 'beta')) });
    sh(root, 'add', SCHEMA);
    const done = resolveBusinessAndContinue(root);
    expect(done.status, done.out).toBe(0);
    expect(mergeInProgress(root)).toBe(false);
  }, 60_000);

  it('登记区里混进无法识别的语句（不是 export … from）：提交前核对失败', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaWith('') },
      branch: { [SCHEMA]: schemaWith("export * from './alpha.js';\n") },
      main: { [SCHEMA]: schemaWith("export * from './beta.js';\n") },
    });
    put(root, { [SCHEMA]: `${schemaWith("export * from './alpha.js';\nexport * from './beta.js';\n")}const x = 1;\n` });
    sh(root, 'add', SCHEMA);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain(SCHEMA);
  }, 60_000);
});

describe('第 1 轮审查 P2-4：应核对的登记文件缺失判失败', () => {
  it('两边都新增 schema 导出，业务冲突停下后 git rm 该文件再 --continue → 非零退出、不提交', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
      main: { [SCHEMA]: schemaIndex(['tenancy', 'beta']) },
    });
    sh(root, 'rm', '-qf', SCHEMA);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain(SCHEMA);
    expect(done.out).toContain('缺失');
  }, 60_000);

  it('声明文件被删同样失败', () => {
    const talent = (items: string[]) => ({ [`${DECLARED}/talent.ts`]: declaredFile({ sameStatusInvalidId: items }) });
    const { root, head } = stopAtBusinessConflict({
      base: talent([A]),
      branch: talent([A, C]),
      main: talent([A, B]),
    });
    sh(root, 'rm', '-qf', `${DECLARED}/talent.ts`);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('缺失');
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 第 2 轮审查返工（DEC-431①，同类第 2 次）：提交前核对必须是无条件的最终不变式——对每个登记文件，
// 应有身份集合 = 分叉点保留项 ∪ 本分支新增 ∪ main 新增，结果里每个身份都必须存在且恰好一份；
// 人工决定的同键异值只放宽“值等于哪一边”，不放宽“必须存在”；应有集合非空而文件缺失判失败。
// 下面每条对应脚本里一个“读取结果之前就判通过 / 跳过”的出口。

describe('第 2 轮审查 P2-1：人工决定同键异值，只放宽值，不放宽存在', () => {
  const idxOnly = (entries: string[]) =>
    ['export const DECLARED: Readonly<Record<string, unknown>> = {', ...entries, '};', ''].join('\n');
  const withTalent = (value?: string) =>
    idxOnly(['  approval: APPROVAL_DECLARED,', ...(value ? [`  talent: ${value},`] : [])]);

  it('两边各加 talent: A / talent: B，人工把 DECLARED 恢复成没有 talent → --continue 失败、不提交', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [INDEX]: withTalent() },
      branch: { [INDEX]: withTalent('A_DECLARED') },
      main: { [INDEX]: withTalent('B_DECLARED') },
    });
    put(root, { [INDEX]: withTalent() });
    sh(root, 'add', INDEX);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('登记项丢失');
    expect(done.out).toContain('talent');
  }, 60_000);

  it('人工在两个值里选一个保留：通过并提交（值可自由决定，存在且恰好一份）', () => {
    const { root } = stopAtBusinessConflict({
      base: { [INDEX]: withTalent() },
      branch: { [INDEX]: withTalent('A_DECLARED') },
      main: { [INDEX]: withTalent('B_DECLARED') },
    });
    put(root, { [INDEX]: withTalent('B_DECLARED') });
    sh(root, 'add', INDEX);
    const done = resolveBusinessAndContinue(root);
    expect(done.status, done.out).toBe(0);
    expect(mergeInProgress(root)).toBe(false);
  }, 60_000);

  it('人工写成别的值（两个值之外）也可以；写成两份则重复失败', () => {
    const mk = () =>
      stopAtBusinessConflict({
        base: { [INDEX]: withTalent() },
        branch: { [INDEX]: withTalent('A_DECLARED') },
        main: { [INDEX]: withTalent('B_DECLARED') },
      });
    const dup = mk();
    put(dup.root, {
      [INDEX]: idxOnly(['  approval: APPROVAL_DECLARED,', '  talent: A_DECLARED,', '  talent: B_DECLARED,']),
    });
    sh(dup.root, 'add', INDEX);
    const refused = resolveBusinessAndContinue(dup.root);
    expectRefused(dup.root, dup.head, refused);
    expect(refused.out).toContain('登记项重复');
  }, 60_000);
});

describe('第 2 轮审查 P2-2：两边新增相同文件也要核对实际结果', () => {
  const FRESH = `${DECLARED}/fresh.ts`;
  const fresh = (items: string[]) => declaredFile({ sameStatusInvalidId: items });

  it('git rm 该文件 → --continue 失败、不提交', () => {
    const { root, head } = stopAtBusinessConflict({
      base: {},
      branch: { [FRESH]: fresh([A, B]) },
      main: { [FRESH]: fresh([A, B]) },
    });
    sh(root, 'rm', '-qf', FRESH);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain(FRESH);
    expect(done.out).toContain('缺失');
  }, 60_000);

  it('保留文件但清空其声明 → --continue 失败、不提交', () => {
    const { root, head } = stopAtBusinessConflict({
      base: {},
      branch: { [FRESH]: fresh([A, B]) },
      main: { [FRESH]: fresh([A, B]) },
    });
    put(root, { [FRESH]: declaredFile({}) });
    sh(root, 'add', FRESH);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('登记项丢失');
  }, 60_000);

  it('文件原样保留：通过并提交', () => {
    const { root } = stopAtBusinessConflict({
      base: {},
      branch: { [FRESH]: fresh([A, B]) },
      main: { [FRESH]: fresh([A, B]) },
    });
    const done = resolveBusinessAndContinue(root);
    expect(done.status, done.out).toBe(0);
  }, 60_000);
});

describe('第 2 轮审查：出口清单——不再有“读取结果之前就判通过”的分支', () => {
  it('出口：只有一边改过的登记文件不核对（旧：必须两边都改过才核对）——本分支新增的导出被人工删掉', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
      main: {},
    });
    put(root, { [SCHEMA]: schemaIndex(['tenancy']) });
    sh(root, 'add', SCHEMA);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('登记项丢失');
    expect(done.out).toContain('alpha');
  }, 60_000);

  it('出口：只有 main 一边改过的登记文件，人工 git rm → 失败', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      branch: {},
      main: { [SCHEMA]: schemaIndex(['tenancy', 'beta']) },
    });
    sh(root, 'rm', '-qf', SCHEMA);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('缺失');
  }, 60_000);

  it('出口：分支已包含 main 时只检查迁移与重算——登记文件里已有的重复挂载也要被查出', () => {
    const app = (lines: string[]) =>
      [
        "import { registerTenantRoutes } from './modules/tenant/routes.js';",
        '',
        'const TENANT_MODULES = [',
        ...lines,
        '];',
        '',
      ].join('\n');
    const root = buildRepo({
      base: { 'apps/api/src/app.ts': app(['  registerTenantRoutes, // 甲']) },
      main: { 'docs/note.md': '更新\n' },
      branch: { 'apps/api/src/app.ts': app(['  registerTenantRoutes, // 甲', '  registerTenantRoutes, // 乙']) },
    });
    sh(root, 'merge', '-q', '--no-edit', 'origin/main');
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('登记项重复');
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);

  it('出口：没有任何登记类文件（四侧都不存在）时核对不需要 typescript，也不拦合并', () => {
    const root = buildRepo({
      base: {},
      main: { 'apps/api/src/modules/org/service.ts': service(20) },
      branch: { 'apps/api/src/modules/org/other.ts': 'export const X = 1;\n' },
    });
    const result = run(root);
    expect(result.status, result.out).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 第 3 轮审查返工（DEC-431① / DEC-434，同类第 3 次）：核对的对象必须就是提交的对象。
// `git commit` 提交的是索引，重算（pnpm test）读的是工作区：提交前工作区必须与索引一致（含未跟踪文件），
// 登记核对读 `git write-tree` 写出的待提交树，文件枚举 = HEAD ∪ main ∪ 分叉点 ∪ 待提交树。

describe('第 3 轮审查 P2-1：核对读工作区、提交读索引——两者不一致必须停下', () => {
  const schemaSides = {
    base: { [SCHEMA]: schemaIndex(['tenancy']) },
    branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
    main: { [SCHEMA]: schemaIndex(['tenancy', 'beta']) },
  };

  it('暂存丢掉 alpha 的版本，工作区恢复完整但不重新暂存 → --continue 失败、不提交，列出不一致的文件', () => {
    const { root, head } = stopAtBusinessConflict(schemaSides);
    const full = read(root, SCHEMA);
    expect(full).toContain('alpha');
    put(root, { [SCHEMA]: schemaIndex(['tenancy', 'beta']) });
    sh(root, 'add', SCHEMA);
    put(root, { [SCHEMA]: full });
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('工作区与索引不一致');
    expect(done.out).toContain(SCHEMA);
  }, 60_000);

  it('反过来：索引完整、工作区丢项未暂存 → 同样失败（不以任何一边为准，由人决定提交哪份）', () => {
    const { root, head } = stopAtBusinessConflict(schemaSides);
    put(root, { [SCHEMA]: schemaIndex(['tenancy', 'beta']) });
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('工作区与索引不一致');
    expect(done.out).toContain(SCHEMA);
  }, 60_000);

  it('登记以外的已跟踪文件改了没暂存（重算会读到、提交不含）→ 失败', () => {
    const { root, head } = stopAtBusinessConflict(schemaSides);
    const done = (() => {
      put(root, { [SERVICE]: service(30) });
      sh(root, 'add', SERVICE);
      put(root, { [SERVICE]: service(40) });
      return run(root, '--continue');
    })();
    expectRefused(root, head, done);
    expect(done.out).toContain('工作区与索引不一致');
    expect(done.out).toContain(SERVICE);
  }, 60_000);

  it('未跟踪的登记文件（重算会读到、提交不含）→ 失败', () => {
    const { root, head } = stopAtBusinessConflict(schemaSides);
    put(root, { [`${DECLARED}/fresh.ts`]: declaredFile({ sameStatusInvalidId: [A] }) });
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('未跟踪');
    expect(done.out).toContain(`${DECLARED}/fresh.ts`);
  }, 60_000);

  it('开始合并前工作区有未跟踪文件 → 不开始合并（以免停在合并中途才发现）', () => {
    const root = buildRepo({ ...schemaSides, main: { 'docs/note.md': '更新\n' } });
    const head = sh(root, 'rev-parse', 'HEAD');
    put(root, { 'notes.md': '草稿\n' });
    const result = run(root);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('notes.md');
    expect(mergeInProgress(root)).toBe(false);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);

  it('一致时照常通过：提交的树里就是核对过的内容', () => {
    const { root } = stopAtBusinessConflict(schemaSides);
    const done = resolveBusinessAndContinue(root);
    expect(done.status, done.out).toBe(0);
    const committed = sh(root, 'show', `HEAD:${SCHEMA}`);
    for (const name of ['tenancy', 'alpha', 'beta']) expect(committed).toContain(`./${name}.js`);
  }, 60_000);
});

describe('第 3 轮审查 P2-2：待提交树里独有的登记文件也要核对（按空来源）', () => {
  const FRESH = `${DECLARED}/fresh.ts`;

  it('新增并暂存三侧都没有的 declared/fresh.ts、写入声明 → --continue 失败、不提交，报多出的登记项', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
      main: { [SCHEMA]: schemaIndex(['tenancy', 'beta']) },
    });
    put(root, { [FRESH]: declaredFile({ sameStatusInvalidId: [A, B] }) });
    sh(root, 'add', FRESH);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain(FRESH);
    expect(done.out).toContain('多出的登记项');
  }, 60_000);

  it('Git 无冲突合并后由人在提交前加进待提交树的登记文件同样核对（已包含 main 的路径）', () => {
    const root = buildRepo({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      main: { 'docs/note.md': '更新\n' },
      branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
    });
    sh(root, 'merge', '-q', '--no-edit', 'origin/main');
    const head = sh(root, 'rev-parse', 'HEAD');
    put(root, { [FRESH]: declaredFile({ sameStatusInvalidId: [C] }) });
    sh(root, 'add', FRESH);
    const result = run(root, '--continue');
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain(FRESH);
    expect(result.out).toContain('多出的登记项');
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);
});

// 临时仓库跑不了真实重算：package.json 的 test 脚本换成假重算，merge:main 照常用 pnpm test <文件> 调它
const fakeRegen = (body: string): Files => ({
  'package.json': `${JSON.stringify({ type: 'module', scripts: { test: 'node fake-regen.mjs' } })}\n`,
  'fake-regen.mjs': `import { mkdirSync, writeFileSync } from 'node:fs';\n${body}\n`,
});
const regenRun = (root: string, ...flags: string[]) => {
  const result = spawnSync(process.execPath, ['scripts/merge-main.mjs', '--no-fetch', ...flags], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};
const regenSides = (regen: string) => ({
  base: {
    [SCHEMA]: schemaIndex(['tenancy']),
    // 真实仓库里两个生成物目录总是存在（regenerate 对它们 git add -A）
    [`${ROUTE_POLICY}/required/digests/nodes.ts`]: "export const NODES = ['base'];\n",
    [`${ROUTE_POLICY}/baseline/endpoint-counts.json`]: '{"total":10}\n',
    ...fakeRegen(regen),
  },
  main: { 'docs/note.md': '更新\n' },
  branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
});

describe('第 3 轮审查：重算之后、提交之前再核对一次（重算读到的 = 提交的）', () => {
  it('重算写进生成物目录：随重算一起暂存并提交（对照）', () => {
    const digest = `${ROUTE_POLICY}/required/digests/nodes.ts`;
    const root = buildRepo(
      regenSides(
        `mkdirSync('${ROUTE_POLICY}/required/digests', { recursive: true });\n` +
          `writeFileSync('${digest}', "export const NODES = ['regen'];\\n");`,
      ),
    );
    const result = regenRun(root);
    expect(result.status, result.out).toBe(0);
    expect(sh(root, 'show', `HEAD:${digest}`)).toContain('regen');
    expect(sh(root, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('重算过程中登记文件在工作区被改（未暂存）→ 提交前失败、不提交', () => {
    const root = buildRepo(regenSides(`writeFileSync('${SCHEMA}', "export * from './tenancy.js';\\n");`));
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = regenRun(root);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('工作区与索引不一致');
    expect(result.out).toContain(SCHEMA);
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(mergeInProgress(root)).toBe(true);
  }, 60_000);

  it('重算在生成物目录以外留下未跟踪文件 → 提交前失败、不提交', () => {
    const root = buildRepo(regenSides(`writeFileSync('stray.txt', 'x\\n');`));
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = regenRun(root);
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain('未跟踪');
    expect(result.out).toContain('stray.txt');
    expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// 第 4 轮审查返工（DEC-501，同类第 4 次）：“工作区 = 索引”的检查证明不了“重算读到的 = 提交的”，
// git commit 又会在核对之后跑 hook。改为：重算只在从待提交树逐字节写出的临时目录里做；产物按内容比对后写进新树再核对；
// 用 commit-tree + update-ref 提交那棵固定的树；无法证明一致的配置直接拒绝；被忽略的新生成物报出并退出 1。
// 每条反例在 cfd6c505 上都是行为失败（退出 0 并提交了与核对不同的内容）。

/** 分支加一个 schema 导出、main 只改文档：Git 无冲突，合并后直接提交（最简单的“能走到提交”的场景）。 */
const plainMerge = (extra: Files = {}) =>
  buildRepo({
    base: { [SCHEMA]: schemaIndex(['tenancy']), [SERVICE]: service(10), ...extra },
    main: { 'docs/note.md': '更新\n' },
    branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
  });

const expectRefusedBeforeCommit = (root: string, head: string, result: { status: number | null; out: string }) => {
  expect(result.status, result.out).not.toBe(0);
  expect(sh(root, 'rev-parse', 'HEAD')).toBe(head);
};

describe('第 4 轮审查 P2-1 / DEC-501④：无法证明“读到的 = 提交的”的配置直接拒绝', () => {
  it('assume-unchanged：工作区改了、git diff 仍为空 → 拒绝并说明', () => {
    const root = plainMerge();
    const head = sh(root, 'rev-parse', 'HEAD');
    sh(root, 'update-index', '--assume-unchanged', SERVICE);
    put(root, { [SERVICE]: service(20) });
    const result = run(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('assume-unchanged');
    expect(result.out).toContain(SERVICE);
  }, 60_000);

  it('skip-worktree：同上 → 拒绝并说明', () => {
    const root = plainMerge();
    const head = sh(root, 'rev-parse', 'HEAD');
    sh(root, 'update-index', '--skip-worktree', SERVICE);
    put(root, { [SERVICE]: service(20) });
    const result = run(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('skip-worktree');
    expect(result.out).toContain(SERVICE);
  }, 60_000);

  it('clean filter：工作区是 20、索引是 10、status 干净 → 拒绝并说明', () => {
    const root = plainMerge();
    const head = sh(root, 'rev-parse', 'HEAD');
    sh(root, 'config', 'filter.hide.clean', 'sed s/LIMIT\\ =\\ 20/LIMIT\\ =\\ 10/');
    writeFileSync(path.join(root, '.git/info/attributes'), `${SERVICE} filter=hide\n`);
    put(root, { [SERVICE]: service(20) });
    sh(root, 'add', SERVICE);
    expect(sh(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    const result = run(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('filter');
    expect(result.out).toContain(SERVICE);
  }, 60_000);

  it('指向仓库外的符号链接 → 拒绝并说明', () => {
    const root = plainMerge();
    const outside = mkdtempSync(path.join(tmpdir(), `merge-main-outside-${randomUUID()}-`));
    roots.push(outside);
    writeFileSync(path.join(outside, 'limit.ts'), 'export const LIMIT = 99;\n');
    const link = 'apps/api/src/modules/org/limit.ts';
    symlinkSync(path.join(outside, 'limit.ts'), path.join(root, link));
    sh(root, 'add', link);
    sh(root, 'commit', '-qm', 'link');
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('符号链接');
    expect(result.out).toContain(link);
  }, 60_000);

  it('sparse-checkout → 拒绝并说明', () => {
    const root = plainMerge();
    const head = sh(root, 'rev-parse', 'HEAD');
    sh(root, 'sparse-checkout', 'set', '--no-cone', '/*', '!/docs/');
    const result = run(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('sparse');
  }, 60_000);

  it('ignore=all 的脏子模块 → 拒绝并说明', () => {
    const sub = mkdtempSync(path.join(tmpdir(), `merge-main-sub-${randomUUID()}-`));
    roots.push(sub);
    sh(sub, 'init', '-q', '-b', 'main');
    sh(sub, 'config', 'user.email', 'test@example.com');
    sh(sub, 'config', 'user.name', 'test');
    put(sub, { 'lib.ts': 'export const V = 1;\n' });
    sh(sub, 'add', '-A');
    sh(sub, 'commit', '-qm', 'sub');
    const root = plainMerge();
    sh(root, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'vendor/sub');
    sh(root, 'config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all');
    sh(root, 'add', '.gitmodules');
    sh(root, 'commit', '-qm', 'submodule');
    put(root, { 'vendor/sub/lib.ts': 'export const V = 2;\n' });
    expect(sh(root, 'status', '--porcelain')).toBe('');
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = run(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('子模块');
    expect(result.out).toContain('vendor/sub');
  }, 60_000);

  it('--continue 时 origin/main 已不是开始合并时的 main（MERGE_HEAD ≠ origin/main）→ 拒绝', () => {
    const { root, head } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
      main: { [SCHEMA]: schemaIndex(['tenancy', 'beta']) },
    });
    const moved = sh(
      root,
      'commit-tree',
      `${sh(root, 'rev-parse', 'origin/main')}^{tree}`,
      '-p',
      'origin/main',
      '-m',
      'x',
    );
    sh(root, 'update-ref', 'refs/remotes/origin/main', moved);
    const done = resolveBusinessAndContinue(root);
    expectRefused(root, head, done);
    expect(done.out).toContain('MERGE_HEAD');
  }, 60_000);
});

describe('第 4 轮审查 P2-1 / DEC-501①⑤：重算在隔离目录里做，被忽略的新生成物报出', () => {
  it('重算读不到用户工作区里被忽略的本地文件（只读待提交树）', () => {
    const digest = `${ROUTE_POLICY}/required/digests/nodes.ts`;
    const sides = regenSides(
      "import { existsSync } from 'node:fs';\n" +
        "const seen = existsSync('local.json') ? 'local' : 'tree';\n" +
        `writeFileSync('${digest}', \`export const NODES = ['\${seen}'];\\n\`);`,
    );
    const root = buildRepo({ ...sides, base: { ...sides.base, '.gitignore': 'node_modules\nlocal.json\n' } });
    put(root, { 'local.json': '{"v":"local"}\n' });
    const result = regenRun(root);
    expect(result.status, result.out).toBe(0);
    expect(sh(root, 'show', `HEAD:${digest}`)).toContain("'tree'");
  }, 60_000);

  it('重算新生成了被 .gitignore 忽略的文件 → 列出并退出 1，不提交（不能静默留在工作区、缺在提交里）', () => {
    const probe = `${ROUTE_POLICY}/baseline/probe/new-generated.json`;
    const sides = regenSides(
      `mkdirSync('${ROUTE_POLICY}/baseline/probe', { recursive: true });\nwriteFileSync('${probe}', '{}\\n');`,
    );
    const root = buildRepo({ ...sides, base: { ...sides.base, '.gitignore': 'node_modules\nnew-generated.json\n' } });
    const head = sh(root, 'rev-parse', 'HEAD');
    const result = regenRun(root);
    expectRefusedBeforeCommit(root, head, result);
    expect(result.out).toContain('被忽略');
    expect(result.out).toContain(probe);
  }, 60_000);
});

describe('第 4 轮审查 P2-2 / DEC-501③：提交用核对过的固定树，hook 改不了', () => {
  it('pre-commit hook 删掉 alpha 导出并 git add → 提交里仍有 alpha，HEAD 的树就是核对过的树', () => {
    const root = plainMerge();
    const hook = path.join(root, '.git/hooks/pre-commit');
    writeFileSync(hook, `#!/bin/sh\nprintf "export * from './tenancy.js';\\n" > ${SCHEMA}\ngit add ${SCHEMA}\n`, {
      mode: 0o755,
    });
    const result = run(root);
    expect(result.status, result.out).toBe(0);
    expect(sh(root, 'show', `HEAD:${SCHEMA}`)).toContain('./alpha.js');
    expect(sh(root, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(mergeInProgress(root)).toBe(false);
    expect(sh(root, 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('业务冲突后 --continue 同样：提交里是核对过的三方并集，合并状态清掉，工作区与提交一致', () => {
    const { root } = stopAtBusinessConflict({
      base: { [SCHEMA]: schemaIndex(['tenancy']) },
      branch: { [SCHEMA]: schemaIndex(['tenancy', 'alpha']) },
      main: { [SCHEMA]: schemaIndex(['tenancy', 'beta']) },
    });
    writeFileSync(
      path.join(root, '.git/hooks/pre-commit'),
      `#!/bin/sh\nprintf "export * from './tenancy.js';\\n" > ${SCHEMA}\ngit add ${SCHEMA}\n`,
      { mode: 0o755 },
    );
    const done = resolveBusinessAndContinue(root);
    expect(done.status, done.out).toBe(0);
    const committed = sh(root, 'show', `HEAD:${SCHEMA}`);
    for (const name of ['tenancy', 'alpha', 'beta']) expect(committed).toContain(`./${name}.js`);
    expect(mergeInProgress(root)).toBe(false);
    expect(sh(root, 'status', '--porcelain')).toBe('');
  }, 60_000);
});
