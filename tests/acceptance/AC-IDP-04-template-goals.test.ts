/**
 * AC-IDP-04（docs/02_业务建模/28 §5、IDP-R9 / IDP-R12）配置侧：模板通用目标由 HR 在模板中统一维护，模板被引用后仍可
 * 增删改（只对之后新发起的计划生效）。“已发起的计划不变、新发起的计划带上该目标”属于计划执行（PR-B）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type CommonGoalView, idpWorld, type TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

describe('AC-IDP-04 模板通用目标（配置侧）', () => {
  it('在发展目标模块下新增、修改、删除通用目标，模板 revision 递增', async () => {
    const w = await idpWorld(testDb().db, 'idp04a');
    const process = await w.process();
    const template = await w.template(process.id);
    const withGoal = await w.addModule(template, { moduleType: 'goal', name: '学习与成长计划' });
    const goalModule = withGoal.modules.find((m) => m.moduleType === 'goal')!;
    expect(withGoal.revision).toBe(template.revision + 1);

    const added = await w.created<TemplateView>(
      `/templates/${template.id}/common-goals`,
      { moduleId: goalModule.id, name: '提升客户沟通', measure: '客户满意度 ≥ 90', suggestion: '参加沟通训练营' },
      w.as,
      withGoal.revision,
    );
    expect(added.revision).toBe(withGoal.revision + 1);
    expect(added.commonGoals).toEqual([
      {
        id: expect.any(String),
        moduleId: goalModule.id,
        name: '提升客户沟通',
        measure: '客户满意度 ≥ 90',
        suggestion: '参加沟通训练营',
        displayOrder: 1,
      } satisfies CommonGoalView,
    ]);
    const goal = added.commonGoals[0]!;

    const patched = await w.request('PATCH', `/templates/${template.id}/common-goals/${goal.id}`, {
      ifMatch: added.revision,
      body: { measure: null },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(((await patched.json()) as TemplateView).commonGoals[0]).toMatchObject({
      name: '提升客户沟通',
      measure: null,
    });

    const current = await w.read<TemplateView>(`/templates/${template.id}`);
    const removed = await w.request('DELETE', `/templates/${template.id}/common-goals/${goal.id}`, {
      ifMatch: current.revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(((await removed.json()) as TemplateView).commonGoals).toEqual([]);
  });

  it('通用目标只能挂在发展目标模块下（409），旧 revision 提交 409，数据不变', async () => {
    const w = await idpWorld(testDb().db, 'idp04b');
    const process = await w.process();
    const template = await w.template(process.id);
    const basic = template.modules.find((m) => m.moduleType === 'basic')!;
    const before = await w.read<TemplateView>(`/templates/${template.id}`);

    const wrongModule = await w.request('POST', `/templates/${template.id}/common-goals`, {
      ifMatch: before.revision,
      body: { moduleId: basic.id, name: '不该挂在基本信息下' },
    });
    expect(wrongModule.status).toBe(409);
    expect(await reasonOf(wrongModule)).toEqual({ code: 'CONFLICT', reason: 'IDP_MODULE_NOT_GOAL' });

    const withGoal = await w.addModule(before, { moduleType: 'goal', name: '发展目标' });
    const goalModule = withGoal.modules.find((m) => m.moduleType === 'goal')!;
    const stale = await w.request('POST', `/templates/${template.id}/common-goals`, {
      ifMatch: before.revision,
      body: { moduleId: goalModule.id, name: '旧版本提交' },
    });
    expect(stale.status).toBe(409);
    expect((await reasonOf(stale)).code).toBe('REVISION_CONFLICT');
    expect(await w.read<TemplateView>(`/templates/${template.id}`)).toEqual(withGoal);
  });
});
