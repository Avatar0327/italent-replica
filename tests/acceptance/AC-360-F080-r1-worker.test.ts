/**
 * F-080 第 1 轮 P2-1（PR #198 审查）：栅格化子进程启动失败不能永久占用导出名额。
 * 计数减少、等待请求拒绝、close() 完成都曾只挂在 exit 事件上；启动失败（可执行文件不存在、PID 限额等）可能只有
 * error / close，没有 exit。现在 error / exit / close 任一到达即终结一次（拒绝等待中的请求、清理会话、计数只减一次）：
 * - 启动失败：渲染以 EXPORT_RENDER_FAILED（503）失败，而不是等到超时；活跃进程计数回到 0；
 * - 连续失败多次不累计占用，全局名额（3 个）不会被耗尽，之后换回正常可执行文件立即能渲染；
 * - 启动后立即退出（退出码非 0、没发回任何回复）同样终结。
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeRasterProcesses,
  admitted,
  configureExport,
  renderPdf,
  renderPng,
  resetExport,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';

afterEach(() => resetExport());

const doc = () =>
  scoreTableDocument(
    { level: 'questionnaire', columns: [{ scope: 'self' }], items: [{ objectName: '甲', values: [1] }] },
    { activityName: '活动' },
  );
const pdfDoc = () => ({ title: '故障注入', blocks: [{ kind: 'text' as const, text: '一页' }] });
const failed = { code: 'SERVICE_UNAVAILABLE', details: expect.objectContaining({ reason: 'EXPORT_RENDER_FAILED' }) };

const EXECUTABLES: [string, string][] = [
  ['可执行文件不存在（只有 error）', '/nonexistent/italent-node'],
  ...(existsSync('/bin/false') ? ([['启动即退出且不回复（退出码 1）', '/bin/false']] as [string, string][]) : []),
];

describe.each(EXECUTABLES)('AC-360-F080 R1 P2-1 worker 启动失败：%s', (_name, execPath) => {
  it('PNG / PDF 以 EXPORT_RENDER_FAILED 很快失败（不等超时），计数回到 0', async () => {
    configureExport({ workerExecPath: execPath, timeoutMs: 20_000 });
    const started = Date.now();
    await expect(renderPng(doc())).rejects.toMatchObject(failed);
    expect(activeRasterProcesses()).toBe(0);
    await expect(renderPdf(pdfDoc())).rejects.toMatchObject(failed);
    expect(activeRasterProcesses()).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('经 admitted 连续失败 6 次（超过全局名额 3 个）都是 EXPORT_RENDER_FAILED，不会变成 EXPORT_BUSY；换回正常后立即成功', async () => {
    configureExport({ workerExecPath: execPath, timeoutMs: 20_000 });
    for (let i = 0; i < 6; i += 1)
      await expect(admitted('故障租户', (signal) => renderPng(doc(), signal))).rejects.toMatchObject(failed);
    expect(activeRasterProcesses()).toBe(0);
    configureExport({ workerExecPath: undefined });
    const png = await admitted('故障租户', (signal) => renderPng(doc(), signal));
    expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect(activeRasterProcesses()).toBe(0);
  });
});
