// F-493 S4c：导入历史请求路径与读取结果校验（纯函数）。形状对照 apps/api/src/modules/employment/exit-import-history.ts。
import { describe, expect, it } from 'vitest';
import { historyPath, parseHistory, tenantMinute } from './import-history-model.js';

const LIST = '/api/tenant/employment/exits/import/batches';
const row = {
  id: '81000000-0000-4000-8000-000000000001',
  importType: 'exit',
  createdAt: '2026-11-05T16:00:00.000Z',
  submitterName: '',
  status: 'succeeded',
  total: 1000,
  errorCount: 0,
  hasErrorFile: false,
  fileName: '合成 <特殊>&名.xlsx',
  filesExpired: false,
};

describe('导入历史 model', () => {
  it('状态按 执行中 / 成功 / 失败 固定顺序，导入时间区间原样带业务日期', () => {
    expect(historyPath(1, { status: [] })).toBe(`${LIST}?page=1`);
    expect(historyPath(3, { status: ['failed', 'running'], from: '2026-11-01', to: '2026-11-01' })).toBe(
      `${LIST}?page=3&status=running%2Cfailed&from=2026-11-01&to=2026-11-01`,
    );
  });

  it('空集、上限行数、空导入者、特殊字符文件名都按契约收下', () => {
    expect(parseHistory({ items: [], page: 1, hasNext: false })).toEqual({ items: [], page: 1, hasNext: false });
    expect(parseHistory({ items: [row], page: 1_000_000, hasNext: true })?.items[0]?.fileName).toBe(row.fileName);
  });

  it.each([
    ['执行中却有错误数', { status: 'running', errorCount: 0 }],
    ['终态缺错误数', { errorCount: null }],
    ['未知状态', { status: 'queued' }],
    ['其他导入类型', { importType: 'entry' }],
    ['负数总行数', { total: -1 }],
    ['时间不可解析', { createdAt: 'yesterday' }],
    ['过期标记非布尔', { filesExpired: 'no' }],
  ])('%s 判整页无效', (_, extra) => {
    expect(parseHistory({ items: [row, { ...row, ...extra }], page: 1, hasNext: false })).toBeUndefined();
  });

  it('缺分页字段判无效', () => {
    expect(parseHistory({ items: [row], page: 1 })).toBeUndefined();
    expect(parseHistory(null)).toBeUndefined();
  });

  it('导入时间按租户时区到分钟，跨日边界不按浏览器时区', () => {
    expect(tenantMinute('2026-11-05T16:00:00.000Z', 'Asia/Shanghai')).toBe('2026/11/06 00:00');
    expect(tenantMinute('2026-11-05T16:00:00.000Z', 'America/New_York')).toBe('2026/11/05 11:00');
  });
});
