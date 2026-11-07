/**
 * F-474-4b #20：GET /api/tenant/self-service/development-channel 的真实响应形状（含各级标准卡，DEC-778①）。
 * 后端验收（AC-QL-08）断言真实响应的键结构与本样例一致；前端渲染测试（AC-QL-F474-4b-profile-ui）用本样例当接口夹具。
 */
export const CARD_SAMPLE = {
  asOf: '2026-11-03',
  current: {
    categoryId: '50000000-0000-4000-8000-0000000004b1',
    categoryName: '合成研发类',
    levelId: '50000000-0000-4000-8000-0000000004b3',
    levelName: 'P20',
    startDate: '2026-01-01',
  },
  vertical: [
    { levelId: '50000000-0000-4000-8000-0000000004b2', levelName: 'P10', displayOrder: 10, isCurrent: false },
    { levelId: '50000000-0000-4000-8000-0000000004b3', levelName: 'P20', displayOrder: 20, isCurrent: true },
  ],
  horizontal: [
    {
      fromLevelId: '50000000-0000-4000-8000-0000000004b2',
      targetCategoryId: '50000000-0000-4000-8000-0000000004b4',
      targetCategoryName: '合成产品类',
      targetLevelId: '50000000-0000-4000-8000-0000000004b3',
      targetLevelName: 'P20',
    },
  ],
  standard: {
    standardId: '50000000-0000-4000-8000-0000000004b5',
    name: '合成研发类标准',
    levels: [
      {
        levelId: '50000000-0000-4000-8000-0000000004b2',
        levelName: 'P10',
        displayOrder: 10,
        isCurrent: false,
        description: null,
        targets: [],
      },
      {
        levelId: '50000000-0000-4000-8000-0000000004b3',
        levelName: 'P20',
        displayOrder: 20,
        isCurrent: true,
        description: '合成二级描述',
        targets: [
          {
            targetId: '50000000-0000-4000-8000-0000000004b6',
            targetName: '合成指标',
            targetValue: '90',
            weight: 40,
            abilities: [{ content: '合成二级能力', targetValue: null, weight: null }],
          },
        ],
      },
    ],
  },
};

/** 键结构：对象递归取排序后的键，数组取首项的结构（样例数组都非空），标量取 null。 */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, shapeOf(child)]),
    );
  return null;
}
