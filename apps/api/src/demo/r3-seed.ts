/**
 * 演示租户的 R3 权限与样例（F-198）：系统管理员补授人才管理下 6 个模块的标准身份与数据范围（任职资格由 F-141 已授），
 * 再逐模块灌少量名称以 ZZ 开头的样例；HR 专员只补与其身份相符的入口。写法同 world.ts：全部走公开租户接口，
 * 授权与对象都按“自然键先查后建”（身份 + 用户、管理单元编码、样例名称），重复运行不重复写。
 */
import {
  EVALUATION_APP,
  EVALUATION_OBJECTS,
  IDP_APP,
  QUALIFICATION_APP,
  SUCCESSION_APP,
  TALENT_APP,
  TALENT_REVIEW_APP,
  TALENT_REVIEW_OBJECTS,
} from '@italent/domain';
import { type Json, listAll } from './client.js';
import { DEMO_ORGS } from './data.js';
import { DEMO_R3, DEMO_R3_DATES, DEMO_R3_MOU } from './r3-data.js';
import { DEMO_STAFF } from './scale-data.js';
import { DemoSeedIncompleteError, type DemoWorld } from './world.js';

const str = (row: Json, key: string): string => String(row[key]);

/** 一级组织（含下级）= 演示租户全部组织。 */
const topOrgRanges = (world: DemoWorld) =>
  DEMO_ORGS.filter((org) => !org.parent).map((org) => ({
    orgId: world.orgs.get(org.key)!.id,
    includeDescendants: true,
  }));

/** 按名称先查后建：列表里已有同名的就复用，返回 ID。 */
async function ensureByName(
  world: DemoWorld,
  listPath: string,
  name: string,
  create: () => Promise<Json>,
  paged = true,
): Promise<string> {
  const rows = paged
    ? await listAll(world.call, world.admin, `/api/tenant/${listPath}`)
    : (((await world.as(listPath, 'GET')).items ?? []) as Json[]);
  const found = rows.find((row) => row.name === name);
  if (found) return str(found, 'id');
  const created = await create();
  await world.wrote('r3', `${listPath}:${name}`);
  return str(created, 'id');
}

export async function seedR3(world: DemoWorld): Promise<void> {
  await grantSystemAdminRole(world);
  for (const code of R3_ADMIN_PROFILES) await world.grant(world.admin, code);
  await grantAdminScopes(world);
  const mouId = await ensureMou(world);
  await assignMou(world, world.admin, TALENT_APP, mouId);
  await assignMou(world, world.admin, QUALIFICATION_APP, mouId);
  await assignMou(world, world.admin, IDP_APP, mouId);
  const rd = world.orgs.get('rd')!.id;
  const qualification = await seedQualification(world, rd);
  await seedTalent(world, rd);
  await seedEvaluation(world, rd, qualification);
  await seedSurvey360(world);
  await seedTalentReview(world, rd);
  await seedSuccession(world);
  await seedIdp(world, rd);
  await setupHrEntries(world, mouId);
}

/** 系统管理员要补授的 R3 标准身份（任职资格管理员已由 seedQualificationLayers 授予）。 */
const R3_ADMIN_PROFILES = [
  'standard_talent_admin',
  'standard_evaluation_admin',
  'standard_360_system_admin',
  'standard_talent_review_admin',
  'standard_succession_admin',
  'standard_idp_admin',
] as const;

/**
 * 评定三个字典（活动类型、活动周期、通用评分项）的“看全部 + 新建”只给企业设置层的 system_admin（DEC-503）；演示管理员在库里
 * 是 tenant_admin，所以按其“系统管理员”人设补一个 system_admin 管理员角色，经管理员接口授予（已持有则跳过）。
 */
async function grantSystemAdminRole(world: DemoWorld): Promise<void> {
  const admins = await listAll(world.call, world.admin, '/api/tenant/permission/admins');
  if (admins.some((row) => row.userId === world.admin && row.role === 'system_admin')) return;
  const body = { userId: world.admin, role: 'system_admin', grantableAdminRoles: [], grantableProfileIds: [] };
  await world.as('permission/admins', 'POST', body);
  await world.wrote('r3', 'admin-system-role');
}

/** 身份级“看全部”：读到已是看全部就不写；entity 目标按对象，app 目标覆盖整个应用。 */
async function profileSeeAll(world: DemoWorld, profileCode: string, appCode: string, entity?: string): Promise<void> {
  const path = `permission/profiles/${world.profileId(profileCode)}/data-scopes/${appCode}`;
  const target = entity ? { targetKind: 'entity', targetCode: entity } : { targetKind: 'app', targetCode: '' };
  const query = entity ? `?targetKind=entity&targetCode=${entity}` : '';
  const current = await world.as(`${path}${query}`, 'GET');
  if (current.seeAll === true) return;
  await world.as(path, 'PUT', { ...target, seeAll: true }, Number(current.revision ?? 0));
  await world.wrote('r3', `${profileCode}:${appCode}:scope`);
}

/**
 * 管理员的数据范围：评定活动、盘点项目按对象看全部；继任按应用看全部（标准身份不预置，硬规则默认空）。
 * 人才标准、任职资格、IDP 不支持组织范围，改按命名管理单元授（assignMou；IDP 的管理单元范围与 F-154 的 seedIdpInfo 同法）。
 */
async function grantAdminScopes(world: DemoWorld): Promise<void> {
  await profileSeeAll(world, 'standard_evaluation_admin', EVALUATION_APP, EVALUATION_OBJECTS.evaluationActivity.code);
  await profileSeeAll(world, 'standard_talent_review_admin', TALENT_REVIEW_APP, TALENT_REVIEW_OBJECTS.project.code);
  await profileSeeAll(world, 'standard_succession_admin', SUCCESSION_APP);
}

async function ensureMou(world: DemoWorld): Promise<string> {
  const rows = (((await world.as('permission/mous?limit=200', 'GET')).items ?? []) as Json[]).filter(
    (row) => row.code === DEMO_R3_MOU.code,
  );
  if (rows[0]) return str(rows[0], 'id');
  const created = await world.as('permission/mous', 'POST', { ...DEMO_R3_MOU, orgRanges: topOrgRanges(world) }, 0);
  await world.wrote('r3', `mou:${DEMO_R3_MOU.code}`);
  return str(created, 'id');
}

/** 用户 × 应用的数据范围指向命名管理单元（身份撤销不连带删除范围，DEC-043）。 */
async function assignMou(world: DemoWorld, userId: string, appCode: string, mouId: string): Promise<void> {
  const path = `permission/scopes/${userId}/${appCode}`;
  const current = await world.as(path, 'GET');
  if (current.kind === 'mou' && current.mouId === mouId) return;
  await world.as(path, 'PUT', { kind: 'mou', mouId }, Number(current.revision ?? 0));
  await world.wrote('r3', `${userId}:${appCode}:mou`);
}

// ---- 任职资格：分类 → 类别、两个级别（评定活动引用类别 / 级别） ----
interface QualificationRefs {
  readonly categoryId: string;
  readonly levelIds: string[];
}

async function seedQualification(world: DemoWorld, rd: string): Promise<QualificationRefs> {
  const q = DEMO_R3.qualification;
  const classId = await ensureByName(world, 'qualification/category-classes', q.className, () =>
    world.as('qualification/category-classes', 'POST', { code: q.classCode, name: q.className, ownerOrgId: rd }, 0),
  );
  const categoryId = await ensureByName(world, 'qualification/categories', q.categoryName, () =>
    world.as(
      'qualification/categories',
      'POST',
      { code: q.categoryCode, name: q.categoryName, classId, ownerOrgId: rd },
      0,
    ),
  );
  const levelIds: string[] = [];
  for (const level of q.levels)
    levelIds.push(
      await ensureByName(world, 'qualification/levels', level.name, () =>
        world.as('qualification/levels', 'POST', { ...level, ownerOrgId: rd }, 0),
      ),
    );
  return { categoryId, levelIds };
}

// ---- 人才标准：指标库 → 指标，标准分类 → 人才标准 ----
async function seedTalent(world: DemoWorld, rd: string): Promise<void> {
  const t = DEMO_R3.talent;
  const libraryId = await ensureByName(world, 'talent/libraries', t.libraryName, () =>
    world.as('talent/libraries', 'POST', { name: t.libraryName, type: 'ability', ownerOrgId: rd }, 0),
  );
  const dimensionId = await ensureByName(world, 'talent/dimensions', t.dimensionName, () =>
    world.as(
      'talent/dimensions',
      'POST',
      { libraryId, code: t.dimensionCode, name: t.dimensionName, definition: t.dimensionDefinition, ownerOrgId: rd },
      0,
    ),
  );
  const categoryId = await ensureByName(world, 'talent/criterion-categories', t.criterionCategoryName, () =>
    world.as('talent/criterion-categories', 'POST', { name: t.criterionCategoryName, ownerOrgId: rd }, 0),
  );
  await ensureByName(world, 'talent/criteria', t.criterionName, () =>
    world.as(
      'talent/criteria',
      'POST',
      { categoryId, name: t.criterionName, dimensions: [{ dimensionId }], ownerOrgId: rd },
      0,
    ),
  );
}

// ---- 人才评定：字典（类型、周期）→ 活动（草稿） ----
async function seedEvaluation(world: DemoWorld, rd: string, qualification: QualificationRefs): Promise<void> {
  const e = DEMO_R3.evaluation;
  const d = DEMO_R3_DATES;
  const typeId = await ensureByName(world, 'evaluation/activity-types', e.typeName, () =>
    world.as('evaluation/activity-types', 'POST', { name: e.typeName }, 0),
  );
  const cycleId = await ensureByName(world, 'evaluation/activity-cycles', e.cycleName, () =>
    world.as('evaluation/activity-cycles', 'POST', { name: e.cycleName }, 0),
  );
  await ensureByName(world, 'evaluation/activities', e.activityName, () =>
    world.as(
      'evaluation/activities',
      'POST',
      {
        name: e.activityName,
        typeId,
        cycleId,
        year: d.year,
        startDate: d.start,
        endDate: d.end,
        ownerOrgId: rd,
        orgRange: [{ orgId: rd, includeDescendants: true }],
        managerEmployeeId: world.employees.get('hr')!,
        applicants: ['self'],
        categoryIds: [qualification.categoryId],
        levelIds: qualification.levelIds,
        effectiveDate: d.effective,
        chains: [
          {
            type: 'apply',
            name: '资格申报',
            startDate: '2026-01-10',
            endDate: '2026-03-31',
            approvalProcessCode: e.approvalProcessCode,
          },
          { type: 'result', name: '结果发布', startDate: '2026-09-01', endDate: d.end },
        ],
      },
      0,
    ),
  );
}

// ---- 360：活动（草稿；启用要求评价对象与套卷，样例不启用） ----
async function seedSurvey360(world: DemoWorld): Promise<void> {
  const name = DEMO_R3.survey360.activityName;
  // 360 活动列表不分页（固定上限），不能用 listAll
  await ensureByName(
    world,
    'survey360/activities',
    name,
    () => world.as('survey360/activities', 'POST', { name, scene: '年度评估', form: 'single' }, 0),
    false,
  );
}

// ---- 人才盘点：项目（新建，不启动） ----
async function seedTalentReview(world: DemoWorld, rd: string): Promise<void> {
  const p = DEMO_R3.talentReview;
  const d = DEMO_R3_DATES;
  await ensureByName(world, 'talent-review/projects', p.name, () =>
    world.as(
      'talent-review/projects',
      'POST',
      {
        code: p.code,
        name: p.name,
        ownerOrgId: rd,
        year: d.year,
        period: p.period,
        periodStartDate: d.start,
        periodEndDate: d.end,
      },
      0,
    ),
  );
}

/** 法务行政部的生成员工（不参与任何调动场景），按工号顺序取，入职日早于样例起始日。 */
function legalStaffIds(world: DemoWorld, count: number): string[] {
  return DEMO_STAFF.filter(
    (staff) => staff.org === DEMO_R3.succession.staffOrg && !staff.isHead && staff.hired < DEMO_R3.succession.startDate,
  )
    .slice(0, count)
    .map((staff) => world.employees.get(staff.code)!);
}

// ---- 继任：继任地图由组织树、关键职位与继任记录派生，不能直接创建，所以灌一条组织继任记录 ----
async function seedSuccession(world: DemoWorld): Promise<void> {
  const [successorEmployeeId] = legalStaffIds(world, 1);
  const targetOrgId = world.orgs.get(DEMO_R3.succession.targetOrg)!.id;
  const query = `status=all&successorEmployeeId=${successorEmployeeId}&targetOrgId=${targetOrgId}`;
  const existing = await world.as(`succession/records?${query}`, 'GET');
  if (((existing.items ?? []) as Json[]).length > 0) return;
  await world.as('succession/records', 'POST', {
    successionType: 'org',
    targetOrgId,
    successorEmployeeId,
    startDate: DEMO_R3.succession.startDate,
  });
  await world.wrote('r3', 'succession:record');
}

// ---- IDP：流程 → 模板（含综述模块，发布）→ 计划（未开始） ----
async function seedIdp(world: DemoWorld, rd: string): Promise<void> {
  const i = DEMO_R3.idp;
  const d = DEMO_R3_DATES;
  const approvals = ((await world.as('idp/approval-processes?approvalType=idp_plan', 'GET')).items ?? []) as Json[];
  const approval = approvals[0];
  if (!approval) throw new DemoSeedIncompleteError('IDP 计划审批流程缺失');
  const processId = await ensureByName(world, 'idp/processes', i.processName, () =>
    world.as(
      'idp/processes',
      'POST',
      {
        name: i.processName,
        orgId: rd,
        publicDown: true,
        enabled: true,
        subProcesses: [
          {
            name: '制定计划',
            category: 'plan',
            approvalType: 'idp_plan',
            approvalProcessId: str(approval, 'id'),
            startMode: 'manual',
          },
        ],
      },
      0,
    ),
  );
  const templateId = await ensureByName(world, 'idp/templates', i.templateName, () =>
    world.as('idp/templates', 'POST', { name: i.templateName, orgId: rd, processId, publicDown: true }, 0),
  );
  await publishTemplate(world, templateId);
  const [employeeId, tutorEmployeeId] = legalStaffIds(world, 3).slice(1);
  await ensureByName(world, 'idp/plans', i.planName, () =>
    world.as(
      'idp/plans',
      'POST',
      {
        name: i.planName,
        employeeId,
        templateId,
        startDate: d.start,
        endDate: d.end,
        tutorRole: 'other',
        tutorEmployeeId,
      },
      0,
    ),
  );
}

/** 草稿模板补一个非基本信息模块后发布（草稿模板不能建计划；没有可见模块时计划详情对所有人 403）。 */
async function publishTemplate(world: DemoWorld, templateId: string): Promise<void> {
  const path = `idp/templates/${templateId}`;
  const template = await world.as(path, 'GET');
  if (template.status === 'published') return;
  const modules = (template.modules ?? []) as Json[];
  if (!modules.some((module) => module.moduleType === 'analysis')) {
    const body = { moduleType: 'analysis', name: DEMO_R3.idp.moduleName };
    await world.as(`${path}/modules`, 'POST', body, Number(template.revision));
  }
  const latest = await world.as(path, 'GET');
  await world.as(`${path}/publish`, 'POST', undefined, Number(latest.revision));
  await world.wrote('r3', `idp:template-publish`);
}

/**
 * HR 专员（人力资源专员）：评定专员（评定过程 / 记录，不含活动设置）、继任 HR（记录与地图，不含规则配置）、360 一般管理员
 * （只看自己建的和被授权的活动，无“同步人员”）。系统管理员级别的身份（人才标准、盘点、IDP、任职资格管理员）不授。
 * 评定、继任按命名管理单元（覆盖全部组织）授范围，360 不取组织范围。
 */
async function setupHrEntries(world: DemoWorld, mouId: string): Promise<void> {
  const hr = world.accounts.get('hr')!;
  for (const code of ['standard_evaluation_specialist', 'standard_succession_hr', 'standard_360_general_admin'])
    await world.grant(hr, code);
  await assignMou(world, hr, EVALUATION_APP, mouId);
  await assignMou(world, hr, SUCCESSION_APP, mouId);
}
