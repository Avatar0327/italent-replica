/**
 * AC-PRM-F075b（DEC-373①）去掉的 18 项冗余授权调用确实不再发生，并且**只**去掉这 18 项：
 * 发现探测的冻结事实（逐字节与重新探测相等，见 AC-PRM-FW-08.discovery）里，9 个入口的授权轨迹恰好等于去掉两个
 * Activity 键之后的样子（精确相等，不是“少了 18 项”）；其余仍真正消费活动权限的 360 入口照常询问；冗余观测账本精确清空，
 * 已知缺口账本不动。“返回完全一致”由 AC-PRM-F075b-survey360 的对照转录证明。
 */
import { describe, expect, it } from 'vitest';
import { readFrozenProbes } from './support/route-policy/discovery.js';
import { KNOWN_GAPS } from './support/route-policy/probe-known-gaps.js';
import { REDUNDANT_OBSERVATIONS } from './support/route-policy/probe-redundant.js';

const P = '/api/tenant/survey360';
const VIEW = 'obj:Survey360.Activity:view';
const VIEW_ALL = 'btn:Survey360.Activity#viewAll@list';

/** 9 个入口 → 去掉两个 Activity 键之后应剩下的授权轨迹（精确）。 */
const REMAINING: readonly (readonly [string, readonly string[]])[] = [
  [`GET ${P}/questionnaire-templates`, ['obj:Survey360.Questionnaire:view']],
  [
    `POST ${P}/questionnaire-templates`,
    ['btn:Survey360.Questionnaire#create@list', 'obj:Survey360.Questionnaire:create'],
  ],
  [`GET ${P}/questionnaire-templates/:id`, ['obj:Survey360.Questionnaire:view']],
  [
    `PUT ${P}/questionnaire-templates/:id`,
    ['btn:Survey360.Questionnaire#update@detail', 'obj:Survey360.Questionnaire:update'],
  ],
  [
    `DELETE ${P}/questionnaire-templates/:id`,
    ['btn:Survey360.Questionnaire#delete@detail', 'obj:Survey360.Questionnaire:delete'],
  ],
  [
    `POST ${P}/questionnaire-templates/:id/instantiate`,
    ['btn:Survey360.Questionnaire#create@list', 'obj:Survey360.Questionnaire:create'],
  ],
  [
    `POST ${P}/questionnaires/:id/save-as-template`,
    ['btn:Survey360.Questionnaire#create@list', 'obj:Survey360.Questionnaire:create'],
  ],
  [`GET ${P}/report-template`, ['obj:Survey360.Settings:view']],
  [`PUT ${P}/report-template`, ['btn:Survey360.Settings#update@detail', 'obj:Survey360.Settings:update']],
];

describe('AC-PRM-F075b 去掉的 18 项冗余授权调用不再发生', () => {
  const probes = readFrozenProbes();

  it('9 个入口 × 2 个请求键：授权轨迹恰好是去掉两个 Activity 键后的样子（精确相等）', () => {
    expect(REMAINING).toHaveLength(9);
    for (const [endpoint, remaining] of REMAINING) {
      const found = probes[endpoint];
      expect(found, endpoint).toBeDefined();
      expect(found!.trace, endpoint).not.toContain(VIEW);
      expect(found!.trace, endpoint).not.toContain(VIEW_ALL);
      expect([...found!.trace].sort(), endpoint).toEqual([...remaining].sort());
    }
  });

  it('只去掉这 9 个入口：其余 360 入口里仍询问 Activity 键的恰好 48 个（查看权与 viewAll 各 48），没有多删', () => {
    const nine = new Set(REMAINING.map(([endpoint]) => endpoint));
    const asking = (key: string) =>
      Object.entries(probes)
        .filter(([endpoint, found]) => endpoint.includes(`${P}/`) && found.trace.includes(key))
        .map(([endpoint]) => endpoint);
    for (const key of [VIEW, VIEW_ALL]) {
      const endpoints = asking(key);
      expect(
        endpoints.filter((e) => nine.has(e)),
        key,
      ).toEqual([]);
      expect(endpoints, key).toHaveLength(48);
    }
    // 真正消费活动 / 人员 / 报告结果权限的入口照常询问
    for (const endpoint of [
      `GET ${P}/activities`,
      `GET ${P}/activities/:id`,
      `GET ${P}/people`,
      `GET ${P}/activities/:id/reports`,
      `GET ${P}/activities/:id/score-tables`,
    ]) {
      expect(probes[endpoint]?.trace, endpoint).toContain(VIEW);
    }
  });

  it('冗余观测账本精确清空（原 #125 套卷 / 报告模板 18 项），已知缺口账本不动（29 项）；18 对不在任何账里', () => {
    expect(REDUNDANT_OBSERVATIONS).toEqual([]);
    expect(KNOWN_GAPS.flatMap((g) => g.pairs)).toHaveLength(29);
    const accounted = new Set(KNOWN_GAPS.flatMap((g) => g.pairs.map(([e, k]) => `${e}\t${k}`)));
    for (const [endpoint] of REMAINING)
      for (const key of [VIEW, VIEW_ALL])
        expect(accounted.has(`${endpoint}\t${key}`), `${endpoint} ${key}`).toBe(false);
  });
});
