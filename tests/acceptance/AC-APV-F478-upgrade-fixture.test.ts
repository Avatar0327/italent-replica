/**
 * AC-APV-F478 升级类用例夹具守卫（F-478 S1，CI 第 3 轮）：migrateBefore 的用例停在旧表结构上，若在升级前经当前审批接口
 * 发布流程、发起或办理审批，就会读 approval_node_exit_routes、写节点激活台账和 decision_exit 列，而它们在迁移 0197 才建，
 * 报 42P01。凡是这样的用例必须套 support/pre-exit-routes-schema.ts（生产代码不判断表是否存在，DEC-402）。
 * 这是静态检查：新增升级用例漏套时在本地就红，不必等合并队列的完整 CI。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname);

/** 升级前会走当前审批接口的标志：引入审批夹具（造流程 / 发起 / 办理），或直接调审批路由。 */
const USES_APPROVAL_API = [
  /from '\.\/AC-APV-support\.js'/,
  /from '\.\/AC-EXIT-F316-support\.js'/,
  /\/api\/tenant\/approval/,
  /installApprovalFallbacks/,
];

const upgradeTests = () =>
  readdirSync(DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))
    .filter(({ text }) => text.includes('migrateBefore:'));

describe('AC-APV-F478 升级用例的 pre-exit-routes 夹具', () => {
  it('找得到升级类用例（守卫自身没有失效）', () => {
    expect(upgradeTests().length).toBeGreaterThanOrEqual(15);
  });

  it('升级前经当前审批接口造数据的 migrateBefore 用例，都套了 withPreExitRoutesSchema', () => {
    const missing = upgradeTests()
      .filter(({ text }) => USES_APPROVAL_API.some((marker) => marker.test(text)))
      .filter(({ text }) => !/withPreExitRoutesSchema|addPreExitRoutesObjects/.test(text))
      .map(({ name }) => name);
    expect(missing).toEqual([]);
  });
});
