/**
 * R3-T02 P0 契约 ①（拆分方案 docs/08_设计/R3-T02_实现拆分方案.md 第 3 节；设计 §1.3、§3.3、§5.1、§8）：
 * - 评定流程对象目录先冻结、登记在 TEvaluation 应用：员工评定数据、指标明细、评审场次 / 明细、评委评审记录 / 明细；
 *   字段按设计 §3.3 列名，系统维护的列是系统字段（编辑不可授）；按钮按规格 24 已知入口（提名、转入、提前通知、
 *   发布结果、撤销；评定活动的发布 / 取消发布 / 完成；评委记录的弃权 EV-R31）；
 * - 流程对象与配置对象分开：配置对象的审计规则（字典 / 所属组织）不套到流程对象上；
 * - 身份可以配置流程对象（C1-2 装评定专员身份时不会因“未登记的对象”失败）；
 * - 审计：流程对象登记了对象名（人才评定）与查看规则位；规则体由 C2-1a 注入，未注入时一律不返回（fail-closed）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { auditObjectMeta, type ObjectDefinition } from '@italent/domain';
import * as domain from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import * as visibility from '../../apps/api/src/audit/visibility.js';
import { scopeAppOf } from '../../apps/api/src/modules/permission/module-access.js';
import { objectCatalog } from '../../apps/api/src/modules/permission/catalog.js';
import { auditApi } from './AC-AUD-support.js';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';

const testDb = useTestDb();
const EV_APP = 'TEvaluation';
const NOW = '2026-10-09T02:00:00.000Z';

const FLOW_CODES = {
  staffEvaluation: 'TEvaluation.StaffEvaluationData',
  indicatorItem: 'TEvaluation.EvaluationIndicatorsDetail',
  session: 'TEvaluation.EvaluationSessions',
  sessionSlot: 'TEvaluation.EvaluationSessionsDetail',
  judgeRecord: 'TEvaluation.EvaluationRecord',
  judgeScore: 'TEvaluation.EvaluationRecordDetail',
} as const;

const LABELS: Readonly<Record<string, string>> = {
  [FLOW_CODES.staffEvaluation]: '员工评定数据',
  [FLOW_CODES.indicatorItem]: '指标明细',
  [FLOW_CODES.session]: '评审场次',
  [FLOW_CODES.sessionSlot]: '评审场次明细',
  [FLOW_CODES.judgeRecord]: '评委评审记录',
  [FLOW_CODES.judgeScore]: '评委评审明细',
};

type Catalog = Readonly<Record<string, ObjectDefinition>>;
const catalogOf = (name: string): Catalog => {
  const value = (domain as Record<string, unknown>)[name];
  expect(value, name).toBeTruthy();
  return value as Catalog;
};
const flow = () => catalogOf('EVALUATION_FLOW_OBJECTS');
const byCode = (code: string) => {
  const definition = Object.values(flow()).find((item) => item.code === code);
  expect(definition, code).toBeTruthy();
  return definition!;
};
const fieldOf = (definition: ObjectDefinition, code: string) => definition.fields.find((field) => field.code === code);
const buttonsOf = (definition: ObjectDefinition) => definition.buttons.map((b) => `${b.code}@${b.level}`);

type FlowRule = ((...args: unknown[]) => unknown) | null;
const registerFlowRule = (rule: FlowRule) => {
  const register = (visibility as Record<string, unknown>)['registerEvaluationFlowAuditRule'];
  expect(typeof register, 'registerEvaluationFlowAuditRule').toBe('function');
  (register as (rule: FlowRule) => void)(rule);
};

describe('AC-EV-contract P0 ①：评定流程对象目录（DEC-331②、DEC-365③；设计 §3.3）', () => {
  it('六个流程对象登记在 TEvaluation 应用，数据范围按该应用解析，权限目录里查得到', () => {
    const codes = Object.values(flow()).map((definition) => definition.code);
    expect(codes.sort()).toEqual(Object.values(FLOW_CODES).sort());
    for (const definition of Object.values(flow())) {
      expect(definition.application, definition.code).toBe(EV_APP);
      expect(scopeAppOf(definition.code), definition.code).toBe(EV_APP);
      expect(objectCatalog.get(definition.code), definition.code).toEqual(definition);
    }
  });

  it('流程对象不混进配置对象目录（配置对象的字典 / 所属组织审计规则不套到流程对象）', () => {
    const configCodes = Object.values(catalogOf('EVALUATION_OBJECTS')).map((definition) => definition.code);
    for (const code of Object.values(FLOW_CODES)) expect(configCodes, code).not.toContain(code);
  });

  it('员工评定数据：申请与评价字段可授编辑；人员、周期、目标版本、分阶段状态、流程实例、终止与发布是系统字段', () => {
    const data = byCode(FLOW_CODES.staffEvaluation);
    for (const code of [
      'activityId',
      'employeeId',
      'applyCategoryId',
      'applyLevelId',
      'exception',
      'exceptionReason',
      'selfEvaluation',
      'managerEvaluation',
      'hrbpEvaluation',
      'defenseMaterial',
      'finalScore',
      'finalResult',
      'strengths',
      'suggestions',
      'effectiveDate',
    ]) {
      expect(fieldOf(data, code), code).toMatchObject({ system: false });
    }
    for (const code of [
      'cycleId',
      'targetVersion',
      'source',
      'initiatorUserId',
      'nominatorEmployeeId',
      'appliedAt',
      'originalCategoryId',
      'originalLevelId',
      'lastResult',
      'experience',
      'standardId',
      'conditionResult',
      'currentStage',
      'applyStatus',
      'materialStatus',
      'defenseStatus',
      'resultStatus',
      'qualificationInstanceId',
      'materialInstanceId',
      'passVotes',
      'terminatedAt',
      'terminatedReason',
      'publishedAt',
      'id',
      'revision',
    ]) {
      expect(fieldOf(data, code), code).toMatchObject({ system: true });
    }
  });

  it('下级对象：评分项、场次、时段、评委记录与逐项分的主要列都在，归属与状态列是系统字段', () => {
    const expectFields = (code: string, business: readonly string[], system: readonly string[]) => {
      const definition = byCode(code);
      for (const field of business)
        expect(fieldOf(definition, field), `${code}.${field}`).toMatchObject({ system: false });
      for (const field of system)
        expect(fieldOf(definition, field), `${code}.${field}`).toMatchObject({ system: true });
    };
    expectFields(
      FLOW_CODES.indicatorItem,
      ['selfScore', 'selfComment', 'managerScore', 'managerComment', 'presetScore', 'presetComment'],
      ['staffEvaluationId', 'chainId', 'itemKey', 'snapshot', 'frozenAt', 'targetVersion'],
    );
    expectFields(
      FLOW_CODES.session,
      ['name', 'reviewGroupId', 'judgeEmployeeIds', 'followerEmployeeId', 'startAt', 'minutesPerPerson', 'location'],
      ['activityId', 'chainId', 'status'],
    );
    expectFields(
      FLOW_CODES.sessionSlot,
      ['staffEvaluationId', 'seq', 'startAt', 'endAt', 'minutes'],
      ['sessionId', 'defenseState'],
    );
    expectFields(
      FLOW_CODES.judgeRecord,
      ['totalScore', 'result', 'strengths', 'suggestions', 'abstainReason'],
      ['slotId', 'staffEvaluationId', 'targetVersion', 'judgeEmployeeId', 'status', 'abstainBy', 'submittedAt'],
    );
    expectFields(FLOW_CODES.judgeScore, ['score', 'comment'], ['judgeRecordId', 'itemKey']);
  });

  it('按钮按规格 24 已知入口登记：提名 / 转入 / 提前通知 / 发布结果 / 撤销、弃权；活动的发布 / 取消发布 / 完成', () => {
    expect(buttonsOf(byCode(FLOW_CODES.staffEvaluation))).toEqual(
      expect.arrayContaining([
        'nominate@list',
        'transfer@list',
        'advanceNotice@list',
        'publishResult@list',
        'revoke@list',
      ]),
    );
    expect(byCode(FLOW_CODES.staffEvaluation).buttons.find((b) => b.code === 'nominate')).toMatchObject({
      requires: 'create',
    });
    // 规格 24 EV-R31 🟢：TEvaluation.EvaluationRecord / Abstain（原站编码，大小写照抄）
    expect(buttonsOf(byCode(FLOW_CODES.judgeRecord))).toContain('Abstain@detail');
    const activity = Object.values(catalogOf('EVALUATION_OBJECTS')).find(
      (definition) => definition.code === 'TEvaluation.EvaluationActivity',
    )!;
    expect(buttonsOf(activity)).toEqual(
      expect.arrayContaining(['publish@list_row', 'unpublish@list_row', 'complete@list_row']),
    );
  });

  it('审计：六个流程对象都登记了对象名（人才评定应用）与查看规则位', () => {
    for (const code of Object.values(FLOW_CODES)) {
      expect(visibility.auditObjectRegistered(code), code).toBe(true);
      expect(auditObjectMeta(code), code).toMatchObject({ app: '人才评定', label: LABELS[code] });
    }
  });
});

describe('AC-EV-contract P0 ①：身份配置与审计规则位（DEC-197 fail-closed；真实授权器）', () => {
  it('身份可配置流程对象与弃权按钮；审计查看规则未注入时一律不返回，注入后按注入的规则返回', async () => {
    const world = await seedPermissionWorld(testDb().db);
    const profile = await createProfile(world, `ev-flow-${randomUUID().slice(0, 8)}`, { apps: [EV_APP] });
    for (const definition of Object.values(flow())) {
      const response = await setObjectPermission(
        world,
        profile,
        {
          dataOperations: { create: true, update: true, delete: true },
          fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: !field.system })),
          buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
        },
        definition.code,
      );
      expect(response.status, `${definition.code}: ${await response.clone().text()}`).toBe(200);
    }
    // 弃权按钮用固定载荷（原站编码 Abstain，规格 24 EV-R31），不从目录生成，防止目录与载荷同错同过
    const abstain = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: true, delete: false },
        fields: [{ fieldCode: 'abstainReason', view: true, edit: true }],
        buttons: [{ buttonCode: 'Abstain', level: 'detail' }],
      },
      FLOW_CODES.judgeRecord,
    );
    expect(abstain.status, await abstain.clone().text()).toBe(200);
    const seeAll = await world.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/${EV_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(seeAll.status, await seeAll.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, 'ev-auditor');
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const auditor = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: user.id, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(auditor.status, await auditor.clone().text()).toBe(201);

    const objectId = randomUUID();
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO audit_events (tenant_id,actor_user_id,action,object_type,object_id,after,occurred_at)
        VALUES (${world.tenant.id},${world.admin.id},'evaluation.staff-evaluation.update',
          ${FLOW_CODES.staffEvaluation},${objectId},'{"finalScore":80}'::jsonb,${NOW})`),
    );
    const audit = auditApi(world.db, NOW, { authorize: undefined });
    const as = { user: user.id, tenant: world.tenant.id };
    const query = { objectType: FLOW_CODES.staffEvaluation, objectId, limit: '100' };
    try {
      // 看全部 + 对象查看权 + 日志审计，仍不返回：规则体未注入（C2-1a 前）一律 fail-closed
      expect((await audit.dataChanges(as, query)).items).toEqual([]);
      registerFlowRule(() => sql`true`);
      expect((await audit.dataChanges(as, query)).items.map((item) => item.objectId)).toEqual([objectId]);
      registerFlowRule(() => sql`false`);
      expect((await audit.dataChanges(as, query)).items).toEqual([]);
    } finally {
      registerFlowRule(null);
    }
  });
});
