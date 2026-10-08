/**
 * R3-T07 PR-B 第 3 轮 R2-3（DEC-318 K-35 补充；DEC-080 字段权限）：模板关键信息模块的 keyInfoSources 与 keyInfoBlocks
 * 是同一份区块配置的两种表示，读写权限必须一起满足——
 * - 写：改其中任一个都要两个字段都可编辑（只读一边时用另一边绕过 → 403，配置不变）；
 * - 读：任一个看不到，两个都不输出（隐藏 sources 时不能从 blocks[].block 还原）。模板详情、模块写响应、计划详情的
 *   modules、模板模块审计一律如此。
 */
import { randomUUID } from 'node:crypto';
import { IDP_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { idpOperator, type OperatorOptions } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, PLAN_NOW, type PlanWorld } from './AC-IDP-plan-support.js';
import type { TemplateView } from './AC-IDP-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

async function draftTemplate(w: PlanWorld) {
  const current = await w.ok<TemplateView>(await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`));
  return w.ok<TemplateView>(
    await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/unpublish`, { ifMatch: current.revision }),
  );
}

async function operatorWith(w: PlanWorld, options: OperatorOptions) {
  return idpOperator(await permissionWorldOf(w), { ...options, orgId: w.dept });
}

const keyInfoOf = (view: TemplateView, w: PlanWorld) =>
  view.modules.find((m) => m.id === w.keyInfoModule.id) as Record<string, unknown>;

describe('R2-3：keyInfoSources 与 keyInfoBlocks 的权限一起满足', () => {
  it('sources 只读：用 blocks 改配置 403；blocks 只读：用 sources 清空 403；配置都不变', async () => {
    for (const [locked, body] of [
      ['keyInfoSources', { keyInfoBlocks: [{ block: 'career' }] }],
      ['keyInfoBlocks', { keyInfoSources: [] }],
    ] as const) {
      const w = await planWorld(testDb().db, `idp-kil-${locked}`);
      const before = keyInfoOf(await draftTemplate(w), w);
      const op = await operatorWith(w, { readonly: { templateModule: [locked] } });
      const draft = await w.ok<TemplateView>(await op.request('GET', `/templates/${w.template.id}`));
      const response = await op.request('PATCH', `/templates/${w.template.id}/modules/${w.keyInfoModule.id}`, {
        ifMatch: draft.revision,
        body,
      });
      expect(response.status, `${locked}: ${await response.clone().text()}`).toBe(403);
      const after = await w.ok<TemplateView>(await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`));
      expect(keyInfoOf(after, w), locked).toMatchObject({
        keyInfoSources: before.keyInfoSources,
        keyInfoBlocks: before.keyInfoBlocks,
      });
    }
  });

  it('隐藏 sources：模板详情、模块写响应、计划详情 modules、模板模块审计都不输出 blocks', async () => {
    const w = await planWorld(testDb().db, 'idp-kil-hidden');
    const plan = await w.startedPlan();
    const pw = await permissionWorldOf(w);
    const viewer = await memberWithAdminRole(pw, 'audit_admin', `idp-kil-${randomUUID().slice(0, 4)}`);
    const op = await idpOperator(pw, {
      orgId: w.dept,
      user: viewer.user,
      hidden: { templateModule: ['keyInfoSources'] },
    });
    const hidden = (value: unknown, where: string) => {
      const text = JSON.stringify(value);
      expect(text, where).not.toContain('keyInfoBlocks');
      expect(text, where).not.toContain('keyInfoSources');
      expect(text, where).not.toContain('work_shift');
    };

    const detail = await w.ok<TemplateView>(await op.request('GET', `/templates/${w.template.id}`));
    hidden(keyInfoOf(detail, w), '模板详情');
    const planView = await w.ok<{ modules: Record<string, unknown>[] }>(await op.request('GET', `/plans/${plan.id}`));
    hidden(
      planView.modules.find((m) => m.id === w.keyInfoModule.id),
      '计划详情',
    );

    // 模块写响应：另建一个未被引用的模板，改模块名称
    const fresh = await planWorld(testDb().db, 'idp-kil-write');
    const writer = await operatorWith(fresh, { hidden: { templateModule: ['keyInfoSources'] } });
    const draft = await draftTemplate(fresh);
    const written = await writer.request('PATCH', `/templates/${fresh.template.id}/modules/${fresh.keyInfoModule.id}`, {
      ifMatch: draft.revision,
      body: { name: '关键信息（改）' },
    });
    hidden(keyInfoOf(await fresh.ok<TemplateView>(written), fresh), '模块写响应');

    const audit = auditApi(w.db, PLAN_NOW, { authorize: undefined });
    const list = await audit.dataChanges(op.as, { objectType: IDP_OBJECTS.templateModule.code, limit: '50' });
    const created = list.items.find((i) => i.objectId === w.keyInfoModule.id);
    expect(created, JSON.stringify(list.items)).toBeTruthy();
    hidden(created, '审计列表');
    hidden(await audit.dataChange(op.as, created!.id), '审计详情');
  });
});
