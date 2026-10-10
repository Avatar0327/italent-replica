/**
 * F-080 第 1 轮 P2-2（PR #198 审查）：客户端断开要取消导出。三个下载入口（报表 PNG、管理端 PDF、收件人 PDF）以前只传
 * admitted() 的超时 signal，客户端关掉连接后渲染还会占着名额跑到结束。现在请求断开信号（c.req.raw.signal）接入准入与
 * 渲染生命周期：断开即终止栅格化子进程并释放名额（EXPORT_CLIENT_ABORTED），与超时 signal 合并。
 * 用一个“永远不回复”的假 worker 可执行文件让渲染一直挂着，断开是唯一的结束原因（超时设得很长）。
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeRasterProcesses,
  admitted,
  configureExport,
  renderPng,
  resetExport,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { errorOf, key, outbox, reportLink, reports, sceneB } from './AC-360-B-support.js';

const testDb = useTestDb();
afterEach(() => resetExport());

/** 启动后只睡眠、不回复任何消息的“worker”：渲染会一直挂起，直到被终止。 */
function hangingWorker(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'f080-hang-')), 'hang-node');
  writeFileSync(file, '#!/bin/sh\nexec sleep 60\n');
  chmodSync(file, 0o755);
  return file;
}

const until = async (condition: () => boolean, ms = 5_000) => {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await new Promise((resolve) => setTimeout(resolve, 10));
  return condition();
};

const doc = () =>
  scoreTableDocument(
    { level: 'questionnaire', columns: [{ scope: 'self' }], items: [{ objectName: '甲', values: [1] }] },
    { activityName: '活动' },
  );

describe('AC-360-F080 R1 P2-2 admitted 接入断开信号', () => {
  it('已断开的信号：不占名额、不启动子进程', async () => {
    const controller = new AbortController();
    controller.abort();
    configureExport({ globalLimit: 1, tenantLimit: 1 });
    await expect(
      admitted('断开', (signal) => renderPng(doc(), signal), { signal: controller.signal }),
    ).rejects.toMatchObject({ details: expect.objectContaining({ reason: 'EXPORT_CLIENT_ABORTED' }) });
    expect(activeRasterProcesses()).toBe(0);
    expect(await admitted('断开', async () => 'ok')).toBe('ok');
  });

  it('渲染中断开：子进程被终止、名额随即释放（上限 1，断开后下一次准入成功），响应为 EXPORT_CLIENT_ABORTED', async () => {
    configureExport({ globalLimit: 1, tenantLimit: 1, timeoutMs: 120_000, workerExecPath: hangingWorker() });
    const controller = new AbortController();
    const pending = admitted('断开', (signal) => renderPng(doc(), signal), { signal: controller.signal });
    const settled = pending.catch((error: unknown) => error);
    expect(await until(() => activeRasterProcesses() === 1), '假 worker 已启动').toBe(true);
    controller.abort();
    expect(await settled).toMatchObject({ details: expect.objectContaining({ reason: 'EXPORT_CLIENT_ABORTED' }) });
    expect(await until(() => activeRasterProcesses() === 0, 2_000)).toBe(true);
    resetExport();
    configureExport({ globalLimit: 1, tenantLimit: 1 });
    expect(await admitted('断开', async () => 'ok')).toBe('ok');
  });
});

describe('AC-360-F080 R1 P2-2 三个下载入口：客户端断开即取消并释放名额', () => {
  it('PNG、管理端 PDF、收件人 PDF：断开后名额（上限 1）立即可用，没有残余进程', async () => {
    const s = await sceneB(testDb().db, 'f080-disconnect');
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
    const calls: [string, (signal: AbortSignal) => Promise<Response>][] = [
      ['PNG', (signal) => s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`, { signal })],
      ['PDF', (signal) => s.w.request('GET', `${s.path}/reports/${row!.id}/download`, { signal })],
      [
        '收件人 PDF',
        (signal) => reportLink(s.w, mail.payload.token)('GET', `/reports/${row!.id}/download`, { signal }),
      ],
    ];
    for (const [name, call] of calls) {
      configureExport({ globalLimit: 1, tenantLimit: 1, timeoutMs: 120_000, workerExecPath: hangingWorker() });
      const controller = new AbortController();
      const response = call(controller.signal);
      expect(await until(() => activeRasterProcesses() === 1), `${name} 假 worker 已启动`).toBe(true);
      controller.abort();
      const res = await response;
      expect(res.status, name).toBe(503);
      expect((await errorOf(res)).details?.reason, name).toBe('EXPORT_CLIENT_ABORTED');
      expect(await until(() => activeRasterProcesses() === 0, 2_000), `${name} 子进程已退出`).toBe(true);
      resetExport();
      configureExport({ globalLimit: 1, tenantLimit: 1 });
      expect((await call(new AbortController().signal)).status, `${name} 断开后下一次准入成功`).toBe(200);
    }
  });
});
