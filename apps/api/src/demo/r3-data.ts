/**
 * 演示租户的 R3 样例数据（F-198）：人才管理下 7 个模块各 1～3 条，名称一律以“ZZ”开头，便于识别与清理。
 * 全部是合成数据；种子经公开租户接口创建，并只让对象停在合法的非终态（草稿 / 新建 / 未开始）。
 */

/** 前缀：所有 R3 样例的名称都以它开头（继任记录没有名称字段，用手工来源的记录标识）。 */
export const ZZ = 'ZZ';

/** 一个覆盖三个一级组织（含下级）的命名管理单元：人才标准、任职资格按管理单元授范围（不支持组织范围），HR 也用它。 */
export const DEMO_R3_MOU = { code: 'ZZ-DEMO', name: 'ZZ演示管理单元' } as const;

export const DEMO_R3 = {
  qualification: {
    classCode: 'ZZ-CLS-01',
    className: 'ZZ任职分类',
    categoryCode: 'ZZ-CAT-01',
    categoryName: 'ZZ任职类别',
    levels: [
      { code: 'ZZ-L1', name: 'ZZ初级', displayOrder: 1 },
      { code: 'ZZ-L2', name: 'ZZ中级', displayOrder: 2 },
    ],
  },
  talent: {
    libraryName: 'ZZ能力指标库',
    dimensionCode: 'ZZ_DIM_01',
    dimensionName: 'ZZ客户导向',
    dimensionDefinition: '以客户价值为中心',
    criterionCategoryName: 'ZZ标准分类',
    criterionName: 'ZZ销售经理人才标准',
  },
  evaluation: {
    typeName: 'ZZ样例活动类型',
    cycleName: 'ZZ样例活动周期',
    activityName: 'ZZ样例-年度晋升评定',
    approvalProcessCode: 'QUAL_APPLY',
  },
  survey360: { activityName: 'ZZ样例-360评估' },
  talentReview: { code: 'ZZ_PRJ_001', name: 'ZZ样例盘点项目', period: '年度' },
  idp: {
    processName: 'ZZ样例发展流程',
    templateName: 'ZZ样例发展计划模板',
    planName: 'ZZ样例发展计划',
    moduleName: 'ZZ个人信息综述',
  },
  /** 继任样例：目标组织与参与员工取自生成员工（法务行政部，不在任何调动场景里）。 */
  succession: { targetOrg: 'admin', staffOrg: 'legal', startDate: '2026-01-01' },
} as const;

/** 种子里使用的日期：都不晚于任何运行日（继任记录的起始日不得晚于今天）。 */
export const DEMO_R3_DATES = { year: 2026, start: '2026-01-01', end: '2026-12-31', effective: '2027-01-01' } as const;
