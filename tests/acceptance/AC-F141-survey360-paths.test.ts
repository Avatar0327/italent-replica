/**
 * F-141 ③（DEC-500）：360“题库 · 企业自定义”页签的读取、详情、启停和新增，请求路径必须是后端登记的
 * /survey360/questionnaire-templates（不是前端自己拼的 /templates）。期望路径取自 F-039 的后端实测基线。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { surveyPath } from '../../apps/web/src/survey360/model.js';

const observed = readFileSync(
  new URL('./support/route-policy/baseline/observed-contract.json', import.meta.url),
  'utf8',
);
const registered = (method: string, path: string) => observed.includes(`"${method} /api/tenant/survey360${path}"`);

describe('AC-F141-survey360-paths 前端三个页签的请求路径都是后端登记的（DEC-500③）', () => {
  it('题库页签用 questionnaire-templates，另外两个页签路径不变', () => {
    expect(surveyPath('templates')).toBe('/questionnaire-templates');
    expect(surveyPath('questionnaires')).toBe('/questionnaires');
    expect(surveyPath('activities')).toBe('/activities');
  });

  it('三个页签的列表、详情读取路径在后端基线里都有登记', () => {
    for (const kind of ['activities', 'questionnaires', 'templates'] as const) {
      expect(registered('GET', surveyPath(kind)), `${kind} 列表`).toBe(true);
      expect(registered('GET', `${surveyPath(kind)}/:id`), `${kind} 详情`).toBe(true);
    }
  });

  it('新增、启停（用同一 kind 拼的写路径）在后端基线里有登记', () => {
    expect(registered('POST', surveyPath('templates'))).toBe(true);
    expect(registered('POST', surveyPath('questionnaires'))).toBe(true);
  });
});
