/**
 * AC-PRM-F075（DEC-369）IDP 列表 11 项：发展计划列表（GET /plans）对目标 / 任务 / 目标回顾 / 个人综述 / 回顾 / 模板模块 /
 * 指导 / 职业 / 轮岗 9 个嵌套对象预取查看权，模板列表（GET /templates）对模板模块 / 通用目标 2 个嵌套对象预取查看权，
 * 但列表只输出计划（或模板）自身与阶段，不输出这些嵌套内容。本文件在改动前的代码上全绿，改动后原样保持全绿：
 *   - 真实授权器下，操作人只授计划 / 流程 / 子流程 / 模板（完全没有被去掉预取的嵌套对象的授权）与全授权的操作人，
 *     两个列表的返回完全相同；
 *   - 全允许的 HR 身份的转录与改动前的黄金文件逐字节相等。
 */
import { IDP_OBJECTS } from '@italent/domain';
import type { Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { IDP, otherTutor, permissionWorldOf, planWorld, grantTenantBaseView } from './AC-IDP-plan-support.js';
import { type IdpObjectKey, idpOperator } from './AC-IDP-permission-support.js';
import { expectGolden, expectSameTranscript, step, type Step } from './support/f075-equivalence.js';

const testDb = useTestDb();

const KEPT: readonly IdpObjectKey[] = ['process', 'subProcess', 'template', 'plan'];
const ALL = Object.keys(IDP_OBJECTS) as IdpObjectKey[];
const scrub = (text: string) => text.replace(/模板[0-9a-f]{6}/g, '模板<x>');

type Send = (method: string, path: string) => Promise<Response>;

/** 两个列表的固定场景：成功、筛选、分页、非法参数。 */
async function lists(label: string, send: Send, processId: string): Promise<Step[]> {
  const steps: Step[] = [];
  const get = async (name: string, path: string) => steps.push(await step(`${label} ${name}`, await send('GET', path)));
  await get('GET /plans', `${IDP}/plans`);
  await get('GET /plans 按状态', `${IDP}/plans?status=not_started`);
  await get('GET /plans 另一状态', `${IDP}/plans?status=running`);
  await get('GET /plans 分页', `${IDP}/plans?page=2&pageSize=1`);
  await get('GET /plans 非法状态', `${IDP}/plans?status=bogus`);
  await get('GET /templates', `${IDP}/templates`);
  await get('GET /templates 草稿', `${IDP}/templates?status=draft`);
  await get('GET /templates 已发布', `${IDP}/templates?status=published`);
  await get('GET /templates 按流程', `${IDP}/templates?processId=${processId}`);
  await get('GET /templates 分页', `${IDP}/templates?page=2&pageSize=1`);
  await get('GET /templates 非法状态', `${IDP}/templates?status=bogus`);
  return steps;
}

/** 一个租户：已发布模板 + 一个已开始的计划 + 一个未开始的计划。 */
async function world(label: string) {
  const w = await planWorld(testDb().db as Db, label);
  // 两个计划的创建时间错开：列表按 createdAt、id 排序，时间相同时由随机 id 决定顺序，分页步骤会不稳定
  await w.startedPlan({ name: '甲计划' });
  w.setNow('2026-03-01T05:00:00.000Z');
  await w.createPlan({ ...otherTutor(w), name: '乙计划' }, w.hrUser, w.outsider);
  return w;
}

describe('AC-PRM-F075 IDP 计划 / 模板列表：去掉嵌套对象预取前后返回完全一致（DEC-369）', () => {
  it('真实授权器：只授计划 / 流程 / 子流程 / 模板的操作人，与授全部 IDP 对象的操作人返回完全相同，也等于黄金文件', async () => {
    const run = async (kept: readonly IdpObjectKey[]) => {
      const w = await world('f075idp');
      const pw = await permissionWorldOf(w);
      const op = await idpOperator(pw, { objects: kept, orgId: w.dept });
      await grantTenantBaseView(pw, op.user.id, [w.dept]);
      return lists('操作人', (method, path) => op.request(method, path.slice(IDP.length)), w.process.id);
    };
    const full = await run(ALL);
    const limited = await run(KEPT);
    expect(full.length).toBe(11);
    expect(full.filter((s) => s.status === 200).length).toBeGreaterThan(8);
    expectSameTranscript(limited, full, '没有嵌套对象授权时两个列表应与全授权时完全一致', scrub);
    expectGolden('idp-operator', full, scrub);
  }, 300_000);

  it('全允许的 HR 身份：转录等于改动前的黄金文件', async () => {
    const w = await world('f075idp');
    const steps = await lists('HR', (method, path) => w.http(w.hrUser, method, path), w.process.id);
    expect(steps.filter((s) => s.status === 200).length).toBeGreaterThan(8);
    expectGolden('idp-hr', steps, scrub);
  }, 300_000);
});
