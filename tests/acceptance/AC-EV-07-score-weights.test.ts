/**
 * AC-EV-07 评分项权重纯函数（EV-R4 / EV-R40，R3-T02 设计 §7.2；拆分方案 B2）。
 * 评价表“标准 80（指标 A 40%、B 60%）+ 现场表现 20”加权后：A 32%、B 48%、现场 20%。
 */
import { computeScoreWeights, type ScoreItemInput } from '@italent/domain';
import { describe, expect, it } from 'vitest';

const indicator = (id: string, weight: number | null, flags: { hidden?: boolean; capabilityEmpty?: boolean } = {}) => ({
  id,
  weight,
  hidden: flags.hidden ?? false,
  capabilityStandardEmpty: flags.capabilityEmpty ?? false,
});

const standard = (weight: number | null, ...indicators: ReturnType<typeof indicator>[]): ScoreItemInput => ({
  kind: 'standard',
  id: 'std',
  weight,
  indicators,
});
const general = (id: string, weight: number | null): ScoreItemInput => ({ kind: 'general', id, weight });

const weightsOf = (result: ReturnType<typeof computeScoreWeights>) => {
  if (!result.ok) throw new Error(`权重计算失败：${result.code}`);
  return result.weights.map((w) => [w.indicatorId ?? w.itemId, w.weight] as const);
};

describe('AC-EV-07 加权（weighted）：标准整体权重 × 明细权重%，通用项取自身权重', () => {
  it('标准 80（A 40%、B 60%）+ 现场表现 20 → A 32、B 48、现场 20', () => {
    const result = computeScoreWeights('weighted', [
      standard(80, indicator('A', 40), indicator('B', 60)),
      general('现场表现', 20),
    ]);
    expect(weightsOf(result)).toEqual([
      ['A', 32],
      ['B', 48],
      ['现场表现', 20],
    ]);
  });

  it('明细权重为空按 0%；标准整体权重为空按 0', () => {
    expect(
      weightsOf(computeScoreWeights('weighted', [standard(80, indicator('A', null), indicator('B', 100))])),
    ).toEqual([
      ['A', 0],
      ['B', 80],
    ]);
    expect(weightsOf(computeScoreWeights('weighted', [standard(null, indicator('A', 50))]))).toEqual([['A', 0]]);
  });

  it('权重小数不出现浮点尾差（33.3% × 30 = 9.99）', () => {
    expect(weightsOf(computeScoreWeights('weighted', [standard(30, indicator('A', 33.3))]))).toEqual([['A', 9.99]]);
  });

  it('不显示的指标、能力标准为空的指标不参与，也不把权重分给别的指标', () => {
    const result = computeScoreWeights('weighted', [
      standard(
        80,
        indicator('A', 40),
        indicator('B', 30, { hidden: true }),
        indicator('C', 30, { capabilityEmpty: true }),
      ),
    ]);
    expect(weightsOf(result)).toEqual([['A', 32]]);
  });

  it.each([-1, 100.5, Number.NaN, Number.POSITIVE_INFINITY])('权重 %s 不合法 → WEIGHT_INVALID', (bad) => {
    expect(computeScoreWeights('weighted', [general('G', bad)])).toMatchObject({ ok: false, code: 'WEIGHT_INVALID' });
    expect(computeScoreWeights('weighted', [standard(bad, indicator('A', 10))])).toMatchObject({
      ok: false,
      code: 'WEIGHT_INVALID',
    });
    expect(computeScoreWeights('weighted', [standard(80, indicator('A', bad))])).toMatchObject({
      ok: false,
      code: 'WEIGHT_INVALID',
      indicatorId: 'A',
    });
  });
});

describe('AC-EV-07 平均（average）：100% ÷ 参与评分项数，剔除不显示与能力标准为空的指标', () => {
  it('2 个通用项 + 标准里 3 个指标（1 个隐藏、1 个能力标准为空）→ 共 3 项各 100/3', () => {
    const result = computeScoreWeights('average', [
      standard(
        80,
        indicator('A', 40),
        indicator('B', 30, { hidden: true }),
        indicator('C', 30, { capabilityEmpty: true }),
      ),
      general('G1', 10),
      general('G2', null),
    ]);
    const weights = weightsOf(result);
    expect(weights.map(([id]) => id)).toEqual(['A', 'G1', 'G2']);
    for (const [, weight] of weights) expect(weight).toBeCloseTo(100 / 3, 10);
  });

  it('输入权重被忽略（含不合法值），4 项各 25', () => {
    const result = computeScoreWeights('average', [
      general('G1', 99),
      general('G2', -5),
      general('G3', null),
      general('G4', 0),
    ]);
    expect(weightsOf(result).map(([, weight]) => weight)).toEqual([25, 25, 25, 25]);
  });

  it('没有参与项时返回空列表，不除以 0', () => {
    expect(weightsOf(computeScoreWeights('average', []))).toEqual([]);
    expect(weightsOf(computeScoreWeights('average', [standard(100, indicator('A', 100, { hidden: true }))]))).toEqual(
      [],
    );
  });
});

describe('AC-EV-07 求和（sum）：不加权', () => {
  it('参与项权重为 null，隐藏 / 能力标准为空的指标同样剔除', () => {
    const result = computeScoreWeights('sum', [
      standard(80, indicator('A', 40), indicator('B', 30, { hidden: true })),
      general('G1', 20),
    ]);
    expect(weightsOf(result)).toEqual([
      ['A', null],
      ['G1', null],
    ]);
  });
});

describe('AC-EV-07 输出带来源，调用方可按评分项定位', () => {
  it('标准项下的指标带 itemId，通用项 indicatorId 为 null', () => {
    const result = computeScoreWeights('weighted', [standard(80, indicator('A', 100)), general('G', 20)]);
    expect(result).toEqual({
      ok: true,
      weights: [
        { itemId: 'std', indicatorId: 'A', weight: 80 },
        { itemId: 'G', indicatorId: null, weight: 20 },
      ],
    });
  });
});
