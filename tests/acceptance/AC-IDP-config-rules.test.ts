/**
 * R3-T07 PR-A 配置规则（docs/02_业务建模/28 §2.1、§2.2 与 Q-M0-115 补充；DEC-296④⑤）：
 * - 子流程（IDP-R1/R2）：引用审批中心已发布、类型一致的 IDP 审批流程；开启方式 自动 / 手动，自动开启的规则按 Q-M0-115 枚举
 *   （无规则 / 固定时间 / 相对时间：参照时间点 + 当天 / 前 N 天 / 后 N 天），统一在凌晨 2 点开启并生成说明文本；
 * - 模板（IDP-R6/R7/R10/R12）：名称不重复、只能选启用的流程、基本信息模块固定、可复制与发布；发展目标模块按流程节点配置可用
 *   按钮（DEC-296④，Q-M0-115④ activitySettings），节点必须是该子流程所引用审批流程已发布版本里的节点。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpApprovalProcess, idpWorld, type ProcessView, subProcessBody, type TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } };
  return { code: body.error.code, reason: body.error.details?.reason };
}

describe('子流程开启规则与说明文本（Q-M0-115 ②，DEC-296⑤ 凌晨 2 点）', () => {
  it('各种开启规则生成原站同款说明文本', async () => {
    const w = await idpWorld(testDb().db, 'idpr1');
    const { plan, mid, final } = w.approvals;
    const process = await w.process({
      subProcesses: [
        subProcessBody(plan.id),
        subProcessBody(mid.id, { approvalType: 'idp_mid_review', category: 'review', name: '中期回顾' }),
        subProcessBody(final.id, {
          approvalType: 'idp_final_review',
          category: 'evaluation',
          name: '期末回顾',
          startTimeType: 'relative',
          referencePoint: 'plan_end',
          startFrom: 'before',
          days: 5,
        }),
        subProcessBody(mid.id, {
          approvalType: 'idp_mid_review',
          category: 'review',
          name: '季度回顾',
          startTimeType: 'relative',
          referencePoint: 'plan_start',
          startFrom: 'same_day',
        }),
        subProcessBody(mid.id, {
          approvalType: 'idp_mid_review',
          category: 'review',
          name: '定点回顾',
          startTimeType: 'fixed',
          fixedDate: '2026-12-01',
        }),
        subProcessBody(final.id, { approvalType: 'idp_final_review', name: '手动总结', startMode: 'manual' }),
      ],
    });
    expect(process.subProcesses.map((s) => [s.seq, s.ruleText])).toEqual([
      [1, '发展计划开始后自动开启'],
      [2, '上一流程结束后自动开启'],
      [3, '于发展计划结束时间前5天的凌晨2点自动开启'],
      [4, '于发展计划开始时间当天的凌晨2点自动开启'],
      [5, '于2026-12-01的凌晨2点自动开启'],
      [6, '手动开启'],
    ]);
    // 名称与类别不必一致（Q-M0-115 样本：“期末回顾”的类别是“制定计划”）
    expect(process.subProcesses[5]).toMatchObject({ name: '手动总结', category: 'plan' });
  });

  it('规则字段不完整或互相矛盾 → 400，不落库', async () => {
    const w = await idpWorld(testDb().db, 'idpr2');
    const { plan, mid } = w.approvals;
    const second = (extra: Record<string, unknown>) =>
      subProcessBody(mid.id, { approvalType: 'idp_mid_review', category: 'review', name: '回顾', ...extra });
    const invalid = [
      // 相对时间缺参照时间点
      [subProcessBody(plan.id), second({ startTimeType: 'relative', startFrom: 'after', days: 3 })],
      // 前 / 后 N 天缺天数或天数为 0
      [subProcessBody(plan.id), second({ startTimeType: 'relative', referencePoint: 'plan_end', startFrom: 'before' })],
      [
        subProcessBody(plan.id),
        second({ startTimeType: 'relative', referencePoint: 'plan_end', startFrom: 'after', days: 0 }),
      ],
      // 当天不带天数
      [
        subProcessBody(plan.id),
        second({ startTimeType: 'relative', referencePoint: 'plan_end', startFrom: 'same_day', days: 2 }),
      ],
      // 固定时间缺日期
      [subProcessBody(plan.id), second({ startTimeType: 'fixed' })],
      // 手动开启不能带规则
      [subProcessBody(plan.id), second({ startMode: 'manual', startTimeType: 'fixed', fixedDate: '2026-12-01' })],
      // 第一段没有“上一阶段”
      [subProcessBody(plan.id, { startTimeType: 'relative', referencePoint: 'previous_end', startFrom: 'same_day' })],
      // 至少一段
      [],
    ];
    for (const subProcesses of invalid) {
      const response = await w.request('POST', '/processes', {
        ifMatch: 0,
        body: { name: '非法流程', orgId: w.orgId, subProcesses },
      });
      expect(response.status, JSON.stringify(subProcesses)).toBe(400);
      expect((await reasonOf(response)).code).toBe('VALIDATION_FAILED');
    }
    const list = await w.read<{ items: unknown[] }>('/processes');
    expect(list.items).toEqual([]);
  });

  it('引用的审批流程须已发布且审批类型一致（409），不存在 404', async () => {
    const w = await idpWorld(testDb().db, 'idpr3');
    const draft = await idpApprovalProcess(testDb().db, w.as, 'idp_plan', { publish: false });
    const cases: [Record<string, unknown>, number, string | undefined][] = [
      [subProcessBody(draft.id), 409, 'IDP_APPROVAL_PROCESS_UNAVAILABLE'],
      [subProcessBody(w.approvals.mid.id), 409, 'IDP_APPROVAL_TYPE_MISMATCH'],
      [subProcessBody('00000000-0000-4000-8000-000000000001'), 404, undefined],
    ];
    for (const [sub, status, reason] of cases) {
      const response = await w.request('POST', '/processes', {
        ifMatch: 0,
        body: { name: '引用校验', orgId: w.orgId, subProcesses: [sub] },
      });
      expect(response.status).toBe(status);
      if (reason) expect((await reasonOf(response)).reason).toBe(reason);
    }
  });

  it('子流程候选审批流程：只列已发布的 IDP 三类流程及其节点', async () => {
    const w = await idpWorld(testDb().db, 'idpr4');
    await idpApprovalProcess(testDb().db, w.as, 'idp_plan', { publish: false });
    const candidates = await w.read<{
      items: { id: string; approvalType: string; nodes: { nodeKey: string; name: string }[] }[];
    }>('/approval-processes?approvalType=idp_plan');
    expect(candidates.items).toEqual([
      expect.objectContaining({
        id: w.approvals.plan.id,
        approvalType: 'idp_plan',
        nodes: [
          { nodeKey: 'set_goals', name: '制定发展目标', seq: 1 },
          { nodeKey: 'approve_plan', name: '审批发展计划', seq: 2 },
        ],
      }),
    ]);
  });
});

describe('发展计划模板（IDP-R6 / R7 / R10，DEC-296④）', () => {
  it('新建模板自带固定的基本信息模块，缺省向下公开、草稿；名称不能重复（409）', async () => {
    const w = await idpWorld(testDb().db, 'idpt1');
    const process = await w.process();
    const template = await w.template(process.id, { name: '年度发展模板' });
    expect(template).toMatchObject({ name: '年度发展模板', publicDown: true, status: 'draft', referenced: false });
    expect(template.modules.map((m) => [m.moduleType, m.name])).toEqual([['basic', '基本信息']]);

    const duplicate = await w.request('POST', '/templates', {
      ifMatch: 0,
      body: { name: '年度发展模板', orgId: w.orgId, processId: process.id },
    });
    expect(duplicate.status).toBe(409);
    expect(await reasonOf(duplicate)).toEqual({ code: 'CONFLICT', reason: 'IDP_TEMPLATE_NAME_TAKEN' });
  });

  it('只能选启用的流程（409）；发布前流程须启用', async () => {
    const w = await idpWorld(testDb().db, 'idpt2');
    const disabled = await w.process({ enabled: false });
    const rejected = await w.request('POST', '/templates', {
      ifMatch: 0,
      body: { name: '停用流程模板', orgId: w.orgId, processId: disabled.id },
    });
    expect(rejected.status).toBe(409);
    expect(await reasonOf(rejected)).toEqual({ code: 'CONFLICT', reason: 'IDP_PROCESS_DISABLED' });

    const process = await w.process();
    const template = await w.template(process.id);
    const published = await w.request('POST', `/templates/${template.id}/publish`, { ifMatch: template.revision });
    expect(published.status, await published.clone().text()).toBe(200);
    expect(((await published.json()) as TemplateView).status).toBe('published');
  });

  it('基本信息模块不能删除，也不能再加一个（409）；其他模块可增删', async () => {
    const w = await idpWorld(testDb().db, 'idpt3');
    const process = await w.process();
    const template = await w.template(process.id);
    const basic = template.modules[0]!;
    const del = await w.request('DELETE', `/templates/${template.id}/modules/${basic.id}`, {
      ifMatch: template.revision,
    });
    expect(del.status).toBe(409);
    expect(await reasonOf(del)).toEqual({ code: 'CONFLICT', reason: 'IDP_BASIC_MODULE_FIXED' });
    const again = await w.request('POST', `/templates/${template.id}/modules`, {
      ifMatch: template.revision,
      body: { moduleType: 'basic', name: '第二个基本信息' },
    });
    expect(again.status).toBe(409);
    expect(await reasonOf(again)).toEqual({ code: 'CONFLICT', reason: 'IDP_MODULE_DUPLICATE' });

    let current = template;
    for (const [moduleType, name] of [
      ['key_info', '关键信息'],
      ['analysis', '个人信息综述'],
      ['talent_review', '盘点结果'],
      ['goal', '发展目标'],
      ['review', '中期回顾'],
      ['summary', '年度总结'],
    ]) {
      current = await w.addModule(current, { moduleType, name });
    }
    expect(current.modules.map((m) => m.moduleType)).toEqual([
      'basic',
      'key_info',
      'analysis',
      'talent_review',
      'goal',
      'review',
      'summary',
    ]);
    const review = current.modules.find((m) => m.moduleType === 'review')!;
    const removed = await w.request('DELETE', `/templates/${template.id}/modules/${review.id}`, {
      ifMatch: current.revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(((await removed.json()) as TemplateView).modules.map((m) => m.moduleType)).not.toContain('review');
  });

  it('发展目标模块：从胜任力库引用必须选来源；无目标校验等开关落库', async () => {
    const w = await idpWorld(testDb().db, 'idpt4');
    const process = await w.process();
    const template = await w.template(process.id);
    const missing = await w.request('POST', `/templates/${template.id}/modules`, {
      ifMatch: template.revision,
      body: { moduleType: 'goal', name: '发展目标', allowLibraryGoal: true },
    });
    expect(missing.status).toBe(400);
    const saved = await w.addModule(template, {
      moduleType: 'goal',
      name: '发展目标',
      allowLibraryGoal: true,
      competencySource: 'current_position',
      checkNoneGoal: true,
      taskEnabled: true,
      goalReviewEnabled: true,
    });
    expect(saved.modules.find((m) => m.moduleType === 'goal')).toMatchObject({
      allowCustomGoal: true,
      allowLibraryGoal: true,
      competencySource: 'current_position',
      checkNoneGoal: true,
      taskEnabled: true,
      goalReviewEnabled: true,
      nodeSettings: [],
    });
  });

  it('按流程节点配置可用按钮：节点须属于本模板流程的子流程且存在于已发布版本，按钮限于候选集', async () => {
    const w = await idpWorld(testDb().db, 'idpt5');
    const process = await w.process();
    const template = await w.addModule(await w.template(process.id), { moduleType: 'goal', name: '发展目标' });
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    const [planStage, midStage] = process.subProcesses;
    const other = await w.process({ name: '另一条流程' });
    const patch = (nodeSettings: unknown) =>
      w.request('PATCH', `/templates/${template.id}/modules/${goal.id}`, {
        ifMatch: template.revision,
        body: { nodeSettings },
      });

    const unknownNode = await patch([
      { subProcessId: planStage!.id, nodeKey: 'tutor_mid', enabled: true, buttons: ['RowAddIdpGoal'] },
    ]);
    expect(unknownNode.status).toBe(409);
    expect(await reasonOf(unknownNode)).toEqual({ code: 'CONFLICT', reason: 'IDP_NODE_NOT_FOUND' });
    const foreign = await patch([
      { subProcessId: other.subProcesses[0]!.id, nodeKey: 'set_goals', enabled: true, buttons: [] },
    ]);
    expect(foreign.status).toBe(409);
    expect(await reasonOf(foreign)).toEqual({ code: 'CONFLICT', reason: 'IDP_NODE_NOT_FOUND' });
    const badButton = await patch([
      { subProcessId: planStage!.id, nodeKey: 'set_goals', enabled: true, buttons: ['PublishLearning'] },
    ]);
    expect(badButton.status).toBe(400);
    expect(await w.read<TemplateView>(`/templates/${template.id}`)).toEqual(template);

    const ok = await patch([
      {
        subProcessId: planStage!.id,
        nodeKey: 'set_goals',
        enabled: true,
        buttons: ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'],
      },
      { subProcessId: planStage!.id, nodeKey: 'approve_plan', enabled: true, buttons: [] },
      { subProcessId: midStage!.id, nodeKey: 'employee_mid', enabled: false, buttons: [] },
    ]);
    expect(ok.status, await ok.clone().text()).toBe(200);
    const saved = (await ok.json()) as TemplateView;
    expect(saved.modules.find((m) => m.id === goal.id)!.nodeSettings).toEqual([
      {
        subProcessId: planStage!.id,
        nodeKey: 'set_goals',
        enabled: true,
        buttons: ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'],
      },
      { subProcessId: planStage!.id, nodeKey: 'approve_plan', enabled: true, buttons: [] },
      { subProcessId: midStage!.id, nodeKey: 'employee_mid', enabled: false, buttons: [] },
    ]);

    // 已有节点配置的子流程不能换审批流程（节点会对不上），模板也不能换流程（409）
    const latest = await w.read<ProcessView>(`/processes/${process.id}`);
    const input = latest.subProcesses.map(({ ruleText: _ruleText, ...rest }) => rest);
    const replacement = await idpApprovalProcess(testDb().db, w.as, 'idp_plan');
    const swap = await w.request('PATCH', `/processes/${process.id}`, {
      ifMatch: latest.revision,
      body: { subProcesses: input.map((s, i) => (i === 0 ? { ...s, approvalProcessId: replacement.id } : s)) },
    });
    expect(swap.status).toBe(409);
    expect(await reasonOf(swap)).toEqual({ code: 'CONFLICT', reason: 'IDP_NODE_SETTINGS_EXIST' });
    const move = await w.request('PATCH', `/templates/${template.id}`, {
      ifMatch: saved.revision,
      body: { processId: other.id },
    });
    expect(move.status).toBe(409);
    expect(await reasonOf(move)).toEqual({ code: 'CONFLICT', reason: 'IDP_NODE_SETTINGS_EXIST' });
  });

  it('复制模板：带出模块、通用目标与节点配置，新名称、草稿状态、独立的标识', async () => {
    const w = await idpWorld(testDb().db, 'idpt6');
    const process = await w.process();
    let template = await w.addModule(await w.template(process.id), { moduleType: 'goal', name: '发展目标' });
    const goal = template.modules.find((m) => m.moduleType === 'goal')!;
    template = await w.created<TemplateView>(
      `/templates/${template.id}/common-goals`,
      { moduleId: goal.id, name: '通用目标A' },
      w.as,
      template.revision,
    );
    const nodes = await w.request('PATCH', `/templates/${template.id}/modules/${goal.id}`, {
      ifMatch: template.revision,
      body: {
        nodeSettings: [
          {
            subProcessId: process.subProcesses[0]!.id,
            nodeKey: 'set_goals',
            enabled: true,
            buttons: ['RowAddIdpGoal'],
          },
        ],
      },
    });
    template = (await nodes.json()) as TemplateView;
    await w.request('POST', `/templates/${template.id}/publish`, { ifMatch: template.revision });

    const copy = await w.created<TemplateView>(`/templates/${template.id}/copy`, { name: '复制的模板' });
    expect(copy).toMatchObject({ name: '复制的模板', status: 'draft', processId: process.id });
    expect(copy.id).not.toBe(template.id);
    expect(copy.modules.map((m) => [m.moduleType, m.name])).toEqual([
      ['basic', '基本信息'],
      ['goal', '发展目标'],
    ]);
    const copiedGoal = copy.modules.find((m) => m.moduleType === 'goal')!;
    expect(copiedGoal.id).not.toBe(goal.id);
    expect(copiedGoal.nodeSettings).toEqual([
      { subProcessId: process.subProcesses[0]!.id, nodeKey: 'set_goals', enabled: true, buttons: ['RowAddIdpGoal'] },
    ]);
    expect(copy.commonGoals).toEqual([expect.objectContaining({ moduleId: copiedGoal.id, name: '通用目标A' })]);

    const sameName = await w.request('POST', `/templates/${template.id}/copy`, {
      ifMatch: 0,
      body: { name: '复制的模板' },
    });
    expect(sameName.status).toBe(409);
  });

  it('幂等：同键同内容重放同一结果，同键异内容 409', async () => {
    const w = await idpWorld(testDb().db, 'idpt7');
    const body = { name: '幂等流程', orgId: w.orgId, subProcesses: w.threeStages() };
    const first = await w.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-proc-1' });
    expect(first.status).toBe(201);
    const replay = await w.request('POST', '/processes', { ifMatch: 0, body, idempotencyKey: 'idp-proc-1' });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    const conflict = await w.request('POST', '/processes', {
      ifMatch: 0,
      body: { ...body, name: '另一个名字' },
      idempotencyKey: 'idp-proc-1',
    });
    expect(conflict.status).toBe(409);
    expect((await reasonOf(conflict)).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await w.read<{ items: unknown[] }>('/processes')).items).toHaveLength(1);
  });
});
