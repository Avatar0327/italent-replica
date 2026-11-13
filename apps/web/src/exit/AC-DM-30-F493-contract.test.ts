// F493-FE-01 / 06 / 07：前端解析器与客户端串联当前真实 HTTP / DB 提交契约。
import '../../../../tests/acceptance/support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importWorld } from '../../../../tests/acceptance/AC-DM-30-support.js';
import { uniqueSuffix } from '../../../../tests/acceptance/support/unique.js';
import { createApiClient, newCommand } from '../foundation/client.js';
import { importPath, importRowsOf, parseImportReceipt } from './exit-import-model.js';
import { readXlsx } from './xlsx-reader.js';
import { buildXlsx, importHeader, requiredRows } from '../../smoke/exit-import-fixtures.js';
import { cellValue } from './exit-model.js';

const database = useTestDb();
afterEach(() => vi.restoreAllMocks());

describe('AC-DM-30-F493 前后端契约', () => {
  it('真模板 → 26 列解析 → 原键 POST 202 / 重放 → 三人落库 → 列表直接离职', async () => {
    const world = await importWorld(database().db, uniqueSuffix());
    const department = await world.dept('合成前端契约部门');
    const template = await world.session.request('GET', '/exits/import/template');
    expect(template.status).toBe(200);
    expect(decodeURIComponent(template.headers.get('content-disposition')!)).toContain('历史离职人员导入模板.xlsx');
    const sheet = await readXlsx(new Uint8Array(await template.arrayBuffer()));
    expect(sheet.rows.map((row) => row.cells)).toEqual([importHeader]);
    const rows = requiredRows(3).map((row, i) => {
      row[0] = '旧错误原文';
      row[2] = `frontend.${i}.${uniqueSuffix()}@example.com`;
      row[3] = department.code;
      return row;
    });
    const fileName = '合成前端导入.xlsx';
    const parsed = importRowsOf(await readXlsx(await buildXlsx([importHeader, ...rows])), fileName);
    if ('error' in parsed) throw new Error(parsed.error);
    const statuses: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, init) => {
      const response = await world.session.request('POST', String(path).replace('/api/tenant/employment', ''), {
        body: JSON.parse(String(init?.body)),
        idempotencyKey: new Headers(init?.headers).get('idempotency-key'),
      });
      statuses.push(response.status);
      return response;
    });
    const client = createApiClient(() => ({ tenantId: world.tenantId, identityKey: 'synthetic' }));
    const command = newCommand({ rows: parsed.rows, fileName });
    try {
      const receipt = await client.request(importPath, { method: 'POST', command });
      expect(statuses).toEqual([202]);
      expect(() => parseImportReceipt(receipt, parsed.rows)).not.toThrow();
      expect(await client.request(importPath, { method: 'POST', command })).toEqual(receipt);
      expect(statuses).toEqual([202, 202]);
      await world.settle();
      expect(await world.employeeCount()).toBe(3);
      expect(await world.batchCount()).toBe(1);
      const listed = await world.session.request('GET', '/exits?view=all&page=1&pageSize=30');
      expect(listed.status).toBe(200);
      const { items } = await listed.json();
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item).toMatchObject({ mode: 'direct', batchId: null });
        expect(cellValue(item, 'mode')).toBe('直接离职');
      }
    } finally {
      await world.settle();
    }
  });
});
