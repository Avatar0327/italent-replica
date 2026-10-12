import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { levelBody, levelKinds, levelsWorld } from './AC-SC-levels-support.js';

const testDb = useTestDb();
describe('AC-SC B2b P3-2 合并字段过滤与度量比较警告', () => {
  it.each(levelKinds)('AC-SC %s：保存、详情和列表均包含两个来源的警告', async (kind) => {
    const w = await levelsWorld(testDb().db);
    const body = levelBody(kind);
    const row = body.rules.rows[0]!;
    const saved = await w.createLevel(kind, {
      ...body,
      rules: {
        expression: '1 and 2',
        rows: [
          { ...row, filterValues: [] },
          { ...row, rowNo: 2, threshold: null },
        ],
      },
    });
    const expected = [
      { code: 'RULE_ROW_VALUE_MISSING', rowNo: 1 },
      { code: 'RULE_ROW_VALUE_MISSING', rowNo: 2 },
    ];
    const detail = await (await w.request('GET', `/${kind}-levels/${saved.id}`)).json();
    const list = await w.list(kind);
    for (const result of [saved, detail, list.items[0]]) {
      expect(result).toMatchObject({ warnings: expected });
      expect(result).not.toHaveProperty('reviewFields');
    }
  });
});
