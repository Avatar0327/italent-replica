import { s } from '../succession/messages.js';
// DEC-456②：关键岗位库与卡片字段配置后端未提供，只作独立示意；禁止充当真实接口失败后的回退结果。
const sample = s.demoSamples;
export const successionDemo = {
  keyPositions: sample.keyPositions.map((name, index) => ({
    id: `demo-key-${index + 1}`,
    name,
    category: sample.category,
    org: sample.org,
    downward: index === 0 ? s.settings.yes : s.settings.no,
    enabled: s.settings.yes,
    createdAt: '2026-10-01',
  })),
  cardFields: [
    { key: 'org', target: s.settings.org, fields: sample.orgFields },
    { key: 'position', target: s.settings.position, fields: sample.positionFields },
  ],
};
