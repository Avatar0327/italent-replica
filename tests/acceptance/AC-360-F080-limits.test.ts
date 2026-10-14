/**
 * F-080（DEC-375②）：报表 300 行、PDF 80 页、PNG 像素预算三类上限保留，超限提示文案统一为“数据过多，请分批导出”，
 * 错误码不变（413 PAYLOAD_TOO_LARGE，details.reason = EXPORT_TOO_LARGE）；分页 / 异步导出以后另开任务。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configureExport,
  EXPORT_PAGE_LIMIT,
  EXPORT_ROW_LIMIT,
  paginate,
  renderPng,
  resetExport,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { errorOf, key, reports, sceneB } from './AC-360-B-support.js';

const testDb = useTestDb();
const MESSAGE = '数据过多，请分批导出';

afterEach(() => resetExport());

const tooLarge = (limit: number) =>
  expect.objectContaining({
    code: 'PAYLOAD_TOO_LARGE',
    message: MESSAGE,
    details: expect.objectContaining({ reason: 'EXPORT_TOO_LARGE', limit }),
  });

describe('AC-360-F080 超限文案统一', () => {
  it('上限值保留：报表 300 行、PDF 80 页', () => {
    expect(EXPORT_ROW_LIMIT).toBe(300);
    expect(EXPORT_PAGE_LIMIT).toBe(80);
  });

  it('报表超过 300 行：版面阶段拒绝，文案统一', () => {
    const items = Array.from({ length: EXPORT_ROW_LIMIT + 1 }, (_, i) => ({ objectName: `对象${i}`, values: [1] }));
    expect(() => scoreTableDocument({ level: 'questionnaire', columns: [{ scope: 'self' }], items }, {})).toThrowError(
      tooLarge(EXPORT_ROW_LIMIT),
    );
    // 恰好 300 行不拒绝
    expect(() =>
      scoreTableDocument({ level: 'questionnaire', columns: [{ scope: 'self' }], items: items.slice(0, 300) }, {}),
    ).not.toThrow();
  });

  it('报告超过 80 页：排版阶段拒绝，文案统一', () => {
    const blocks = Array.from({ length: 12_000 }, (_, i) => ({ kind: 'text' as const, text: `行${i}` }));
    expect(() => paginate({ title: '大文档', blocks }, 'a4')).toThrowError(tooLarge(EXPORT_PAGE_LIMIT));
  });

  it('PNG 超过像素预算：渲染前拒绝，文案统一', async () => {
    configureExport({ pixelBudget: 50_000 });
    const items = Array.from({ length: 60 }, (_, i) => ({ objectName: `对象${i}`, values: [1] }));
    const doc = scoreTableDocument({ level: 'questionnaire', columns: [{ scope: 'self' }], items }, {});
    await expect(renderPng(doc)).rejects.toThrowError(tooLarge(50_000));
  });

  it('HTTP：PNG 超预算返回 413，错误码与原因不变，文案是“数据过多，请分批导出”', async () => {
    const s = await sceneB(testDb().db, 'f080-limit');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '建议' });
    await s.w.transition(s.activity.id, 'disable');
    await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
    expect((await reports(s)).length).toBeGreaterThan(0);
    configureExport({ pixelBudget: 50_000 });
    const res = await s.w.request('GET', `${s.path}/score-tables/download?level=question`);
    expect(res.status).toBe(413);
    const error = await errorOf(res);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.details?.reason).toBe('EXPORT_TOO_LARGE');
    expect(error.message).toBe(MESSAGE);
  });
});
