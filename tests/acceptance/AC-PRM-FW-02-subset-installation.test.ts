/** F-081 / DEC-374⑦：策略定义之外，模块安装调用与路由副作用导入也必须有证据。 */
import { describe, expect, it } from 'vitest';
import {
  checkEvidence,
  repoSource,
  syncedRegistry,
  unitText,
  type SourceReader,
} from './support/route-policy/evidence.js';
import { REQUIRED } from './support/route-policy/required/index.js';

const POLICY = 'apps/api/src/modules/qualification/subset-policy.ts';
const ROUTES = 'apps/api/src/modules/qualification/routes.ts';
const SUBSETS = '/api/tenant/personnel/employees/:employeeId/subsets/:kind';
const KEYS = [
  `POST ${SUBSETS}`,
  `PATCH ${SUBSETS}/:id`,
  `DELETE ${SUBSETS}/:id`,
  'POST /api/tenant/personnel/change-requests',
  'POST /api/tenant/approval/instances/:id/resubmit',
];
// 从真实必需项表取策略义务，不能在夹具里补上待验收的安装证据。
const table = Object.fromEntries(
  KEYS.map((key) => [key, REQUIRED[key]!.filter((o) => o.at.some((e) => e.unit.startsWith(`${POLICY}#`)))]),
);
const registry = syncedRegistry(table, repoSource, false);
const check = (read: SourceReader) => checkEvidence(table, { read, registry, branch: false });

function patched(file: string, from: string, to = ''): SourceReader {
  const original = repoSource(file);
  expect(original.split(from), '变异必须准确命中一处').toHaveLength(2);
  const changed = original.replace(from, to);
  return (path) => (path === file ? changed : repoSource(path));
}

describe('AC-PRM-FW-02 F-081 子集策略安装两条边', { timeout: 120_000 }, () => {
  it('真实源码与真实策略义务零发现，五个入口均有策略义务', () => {
    for (const key of KEYS) expect(table[key]!.length, key).toBeGreaterThan(0);
    expect(check(repoSource)).toEqual([]);
  });

  it.each([
    ['模块末尾安装调用', POLICY, '\ninstallQualificationSubsetPolicy();', 'top-call:installQualificationSubsetPolicy'],
    ['路由策略副作用导入', ROUTES, "import './subset-policy.js';", 'top-import:./subset-policy.js'],
  ])('删除%s → 五个入口均报告安装证据缺失', (_name, file, from, selector) => {
    const findings = check(patched(file, from));
    for (const key of KEYS) {
      expect(
        findings.some((f) => f.route === key && f.code === 'EVIDENCE_UNIT' && f.detail.includes(`${file}#${selector}`)),
        key,
      ).toBe(true);
    }
  });

  it('移入未调用函数的同名安装调用不能冒充顶层安装', () => {
    const read = patched(
      POLICY,
      '\ninstallQualificationSubsetPolicy();',
      '\nfunction unusedInstall() { installQualificationSubsetPolicy(); }',
    );
    expect(check(read).some((f) => f.code === 'EVIDENCE_UNIT')).toBe(true);
  });
});

describe('AC-PRM-FW-02 F-081 顶层证据选择器边界', () => {
  const file = 'apps/api/src/modules/qualification/fixture.ts';
  const text = (source: string, selector: string) => unitText(() => source, `${file}#${selector}`);

  it('只选直接顶层调用，函数定义与函数内调用不影响唯一性', () => {
    const source = 'function install() { install(); }\ninstall();';
    expect(text(source, 'top-call:install')).toBe('install();');
  });

  it('重复顶层调用仍报单元不唯一', () => {
    expect(() => text('install();\ninstall();', 'top-call:install')).toThrow('不唯一');
  });

  it('只选指定副作用导入，具名与纯类型导入不能替代', () => {
    expect(text("import './policy.js';", 'top-import:./policy.js')).toBe("import './policy.js';");
    for (const source of ["import { policy } from './policy.js';", "import type { Policy } from './policy.js';"]) {
      expect(() => text(source, 'top-import:./policy.js')).toThrow('不存在');
    }
  });
});
