/**
 * F-080（#174 第 3 轮 P3-1 遗留）：原生栅格化超时后即时取消。以前 sharp 的超时只有整秒精度，PNG 与两个 PDF 入口在
 * 应用层超时（EXPORT_TIMEOUT）后底层渲染还要再跑约 1.5 秒才停下并释放并发名额。现在栅格化放在可终止的子进程里，
 * 超时即终止进程、立即释放名额，并且不留残余进程：
 * - PNG：一张要渲染数秒的大图，超时后名额很快释放（远小于 sharp 整秒超时的 1.5 秒），子进程已退出；
 * - PDF：多页位图 PDF 同理（逐页之间不再需要等“下一页开始前”才检查）；
 * - 取消不影响后续：随后的正常渲染字节与取消前相同；
 * - HTTP 三个入口（PNG、管理端 PDF、收件人 PDF）超时都是 503 EXPORT_TIMEOUT，名额与子进程随即释放。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeRasterProcesses,
  admitted,
  configureExport,
  paginate,
  renderPdf,
  renderPng,
  resetExport,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { errorOf, key, outbox, reportLink, reports, sceneB } from './AC-360-B-support.js';

const testDb = useTestDb();
afterEach(() => resetExport());

/** 约 2200 万像素的报表长图：单次栅格化要数秒（预算 4000 万以内，不触发 413）。 */
const heavyTable = () =>
  scoreTableDocument(
    {
      level: 'question',
      columns: [{ scope: 'self' }, { scope: 'other' }],
      items: Array.from({ length: 280 }, (_, i) => ({
        objectName: `对象${i}`,
        department: '部门'.repeat(8),
        position: '岗位'.repeat(8),
        questionnaireName: '套卷',
        itemName: '题目'.repeat(10),
        values: [1, 2],
      })),
    } as never,
    { activityName: '活动' },
  );
const heavyPdf = () => ({
  title: '取消测试',
  blocks: Array.from({ length: 1_600 }, (_, i) => ({ kind: 'text' as const, text: `第${i}行` })),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 超时发生后，名额与子进程多久释放（毫秒）；10 秒内没释放返回 Infinity。 */
async function releasedAfter(tenant: string, timedOutAt: number): Promise<number> {
  while (Date.now() - timedOutAt < 10_000) {
    try {
      await admitted(tenant, async () => undefined);
      return Date.now() - timedOutAt;
    } catch {
      await sleep(10);
    }
  }
  return Infinity;
}

describe('AC-360-F080 原生栅格化超时后即时取消', () => {
  it('PNG：大图超时（EXPORT_TIMEOUT）后名额在 0.5 秒内释放，不再等 sharp 的整秒超时；子进程已退出', async () => {
    const doc = heavyTable();
    configureExport({ timeoutMs: 300, tenantLimit: 1, globalLimit: 1 });
    const started = Date.now();
    await expect(admitted('取消PNG', (signal) => renderPng(doc, signal))).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: expect.objectContaining({ reason: 'EXPORT_TIMEOUT' }),
    });
    const timedOutAt = Date.now();
    expect(timedOutAt - started).toBeLessThan(1_000);
    expect(await releasedAfter('取消PNG', timedOutAt)).toBeLessThan(500);
    expect(activeRasterProcesses()).toBe(0);
    // 整张图要渲染数秒：释放时仍远早于渲染完成
    expect(Date.now() - started).toBeLessThan(1_400);
  });

  it('PDF：多页位图 PDF 超时后名额在 0.5 秒内释放，子进程已退出', async () => {
    const doc = heavyPdf();
    expect(paginate(doc, 'a4').length).toBeGreaterThan(20);
    configureExport({ timeoutMs: 400, tenantLimit: 1, globalLimit: 1 });
    await expect(admitted('取消PDF', (signal) => renderPdf(doc, signal))).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'EXPORT_TIMEOUT' }),
    });
    expect(await releasedAfter('取消PDF', Date.now())).toBeLessThan(500);
    expect(activeRasterProcesses()).toBe(0);
  });

  it('取消不影响后续：随后的正常渲染成功，且字节与取消前相同（确定性）', async () => {
    const small = scoreTableDocument(
      { level: 'questionnaire', columns: [{ scope: 'self' }], items: [{ objectName: '甲', values: [1] }] },
      { activityName: '活动' },
    );
    const before = await renderPng(small);
    configureExport({ timeoutMs: 200, tenantLimit: 1, globalLimit: 1 });
    await expect(admitted('取消后', (signal) => renderPng(heavyTable(), signal))).rejects.toBeDefined();
    expect(await releasedAfter('取消后', Date.now())).toBeLessThan(500);
    resetExport();
    expect((await renderPng(small)).equals(before)).toBe(true);
    expect(activeRasterProcesses()).toBe(0);
  });

  it('已经中止的 signal：不启动栅格化进程', async () => {
    const controller = new AbortController();
    controller.abort(new Error('已取消'));
    await expect(renderPng(heavyTable(), controller.signal)).rejects.toThrowError('已取消');
    await expect(renderPdf(heavyPdf(), controller.signal)).rejects.toThrowError('已取消');
    expect(activeRasterProcesses()).toBe(0);
  });

  it('HTTP：PNG、管理端 PDF、收件人 PDF 三个入口超时都是 503 EXPORT_TIMEOUT，名额与子进程随即释放', async () => {
    const s = await sceneB(testDb().db, 'f080-timeout');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '建议' });
    await s.w.transition(s.activity.id, 'disable');
    await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
    const [row] = await reports(s);
    await s.w.ok(
      s.w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'reporting', targets: ['self'] },
      }),
    );
    const mail = (await outbox(s.w, 'survey360.report_forward')).find((m) => m.payload.to === s.person.T.email)!;
    const calls: [string, () => Promise<Response>][] = [
      ['PNG', () => s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`)],
      ['PDF', () => s.w.request('GET', `${s.path}/reports/${row!.id}/download`)],
      ['收件人 PDF', () => reportLink(s.w, mail.payload.token)('GET', `/reports/${row!.id}/download`)],
    ];
    for (const [name, call] of calls) {
      configureExport({ timeoutMs: 5, tenantLimit: 1, globalLimit: 1 });
      const res = await call();
      expect(res.status, name).toBe(503);
      expect((await errorOf(res)).details?.reason, name).toBe('EXPORT_TIMEOUT');
      expect(await releasedAfter(s.w.tenantId, Date.now()), name).toBeLessThan(500);
      expect(activeRasterProcesses(), name).toBe(0);
      resetExport();
      expect((await call()).status, name).toBe(200);
    }
  });
});
