/**
 * K-25 / IDP-R12（第 2 轮 P3）：模板被发展计划引用后不能增删模块、只能改 基本信息 / 关键信息 / 发展目标 模块，不能换流程、
 * 不能删除；通用目标仍可维护（只对之后新发起的计划生效）。计划表随 PR-B，这里经端口注入“被引用”的判定。
 * 负向用例前后各读一次，证明模板未被改动。
 */
import { useTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTemplateReferenceGuard } from '../../apps/api/src/modules/idp/references.js';
import { idpWorld, type TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();
const referenced = new Set<string>();

beforeAll(() => registerTemplateReferenceGuard(async (_tx, _tenantId, templateId) => referenced.has(templateId)));
afterAll(() => registerTemplateReferenceGuard(async () => false));

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error.code, reason: body.error.details?.reason };
}

describe('K-25 被计划引用的模板', () => {
  it('不能增删模块、不能改其他模块、不能换流程、不能删除（409 IDP_TEMPLATE_REFERENCED），模板不变', async () => {
    const w = await idpWorld(testDb().db, 'idpref');
    const process = await w.process();
    const other = await w.process({ name: '另一条流程' });
    let template = await w.template(process.id);
    for (const [moduleType, name] of [
      ['goal', '发展目标'],
      ['analysis', '综述'],
      ['key_info', '关键信息'],
    ]) {
      template = await w.addModule(template, { moduleType, name });
    }
    referenced.add(template.id);
    const before = await w.read<TemplateView>(`/templates/${template.id}`);
    expect(before.referenced).toBe(true);
    const analysis = before.modules.find((m) => m.moduleType === 'analysis')!;

    const attempts = [
      w.request('POST', `/templates/${template.id}/modules`, {
        ifMatch: before.revision,
        body: { moduleType: 'review', name: '新模块' },
      }),
      w.request('DELETE', `/templates/${template.id}/modules/${analysis.id}`, { ifMatch: before.revision }),
      w.request('PATCH', `/templates/${template.id}/modules/${analysis.id}`, {
        ifMatch: before.revision,
        body: { name: '改综述' },
      }),
      w.request('PATCH', `/templates/${template.id}`, { ifMatch: before.revision, body: { processId: other.id } }),
      w.request('DELETE', `/templates/${template.id}`, { ifMatch: before.revision }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(await reasonOf(response)).toEqual({ status: 409, code: 'CONFLICT', reason: 'IDP_TEMPLATE_REFERENCED' });
    }
    expect(await w.read<TemplateView>(`/templates/${template.id}`)).toEqual(before);
  });

  it('仍可改 基本信息 / 关键信息 / 发展目标 模块与通用目标（改动实时生效，G-056a）', async () => {
    const w = await idpWorld(testDb().db, 'idpref2');
    const process = await w.process();
    let template = await w.template(process.id);
    template = await w.addModule(template, { moduleType: 'goal', name: '发展目标' });
    template = await w.addModule(template, { moduleType: 'key_info', name: '关键信息' });
    referenced.add(template.id);
    for (const moduleType of ['basic', 'key_info', 'goal']) {
      const module = template.modules.find((m) => m.moduleType === moduleType)!;
      const response = await w.request('PATCH', `/templates/${template.id}/modules/${module.id}`, {
        ifMatch: template.revision,
        body: { description: `${moduleType} 说明` },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      template = (await response.json()) as TemplateView;
    }
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const added = await w.request('POST', `/templates/${template.id}/common-goals`, {
      ifMatch: template.revision,
      body: { moduleId: goal.id, name: '引用后新增的通用目标' },
    });
    expect(added.status, await added.clone().text()).toBe(201);
  });
});
