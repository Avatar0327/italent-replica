/**
 * F-060（DEC-340④，规格 25 §10.1 ⑱、§10.3 ⑬⑭⑱）：个人报告下载为 PDF，结果报表“下载”为 PNG（原站是整块报表视图的
 * 截图，不是 Excel 数据文件）。文件内容必须与对应 JSON 接口返回的数据一致——同一权限、同一范围裁剪、同一字段裁剪
 * （present）、同一匿名口径（报告快照没有答卷编号 / 评价者标识 / 逐份答案，DEC-355② / DEC-358② 的资格不放宽）：
 * - 文件由同一份已裁剪的 JSON 生成：版面模型（Doc）逐项包含 JSON 里的名称、分数、文本，不含任何 ID；
 * - 字节与“把 JSON 交给渲染函数”的结果完全相同（确定性），受限查看人的文件与管理员的文件不同；
 * - 渲染依赖系统里有中文字体：没有时返回 503 EXPORT_FONT_UNAVAILABLE，而不是输出一堆方框（AGENTS §10 错误码）。
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  docText,
  EXPORT_ROW_LIMIT,
  exportFontReady,
  renderPdf,
  renderPng,
  reportDocument,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { errorOf, key, reportLink, reports, sceneB, type SceneB, sheets, outbox } from './AC-360-B-support.js';

const testDb = useTestDb();

let fonts = false;
beforeAll(async () => {
  fonts = await exportFontReady();
});

/** 自评、上级、两名同事提交（带建议与备注），停用、生成报告。 */
async function answered(label: string) {
  const s = await sceneB(testDb().db, label);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], {
    suggestion: `${label}自评建议`,
    remark: '备注甲',
  });
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5'], { suggestion: `${label}上级建议` });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], {
    suggestion: `${label}同事建议`,
    remark: '备注乙',
  });
  await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v5', 'v3'], { suggestion: `${label}同事二建议` });
  await s.w.transition(s.activity.id, 'disable');
  await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
  const [row] = await reports(s);
  return { s, reportId: row!.id! };
}

interface TableJson {
  level: string;
  columns: { scope: string; roleName?: string }[];
  items: { objectName: string; questionnaireName: string; itemName: string | null; values: (number | null)[] }[];
}
const LEVELS = ['questionnaire', 'composite', 'basic', 'question'] as const;
const uuidIn = (text: string) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text);
const PNG_MAGIC = '89504e470d0a1a0a';

describe('F-060 版面模型与 JSON 数据一致（不依赖字体）', () => {
  it('结果报表：四种清单的名称、列头、4 位小数分数逐项出现，没有任何 ID', async () => {
    const { s } = await answered('f060-t1');
    for (const level of LEVELS) {
      const json = await s.w.ok<TableJson>(s.w.request('GET', `${s.path}/score-tables?level=${level}`));
      const text = docText(scoreTableDocument(json, { activityName: s.activity.name }));
      expect(text, level).toContain(s.activity.name);
      for (const item of json.items) {
        expect(text).toContain(item.objectName);
        expect(text).toContain(item.questionnaireName);
        if (item.itemName) expect(text).toContain(item.itemName);
        for (const value of item.values) if (value !== null) expect(text).toContain(value.toFixed(4));
      }
      for (const column of json.columns)
        expect(text).toContain(column.roleName ?? (column.scope === 'self' ? '自评' : '他评'));
      expect(uuidIn(text), `${level} 不含任何 ID`).toBe(false);
    }
  });

  it('个人报告：封面、评价关系表、分数、各节正文与附录文本都在版面里；没有答卷编号、评价者标识与逐份选项', async () => {
    const { s, reportId } = await answered('f060-t2');
    const json = await s.w.ok<Record<string, unknown>>(s.w.request('GET', `${s.path}/reports/${reportId}`));
    const text = docText(reportDocument(json as never));
    const cover = json.cover as { activityName: string; objectName: string };
    expect(text).toContain(cover.activityName);
    expect(text).toContain(cover.objectName);
    const part = (json.questionnaires as Record<string, unknown>[])[0]!;
    expect(text).toContain(part.name as string);
    for (const row of (part.preface as { relationTable: { roleName: string }[] }).relationTable)
      expect(text).toContain(row.roleName);
    for (const answer of part.openFeedback as { text: string }[]) expect(text).toContain(answer.text);
    for (const entry of part.supplementary as { question: string; answers: { text: string }[] }[]) {
      expect(text).toContain(entry.question);
      for (const answer of entry.answers) expect(text).toContain(answer.text);
    }
    const overview = part.overview as { self: number | null; other: number | null };
    expect(text).toContain(overview.other!.toFixed(4));
    expect(text).toContain(json.statement as string);
    const sheetIds = (await sheets(s)).map((c) => c.id);
    for (const secret of [...sheetIds, s.person.P1.id, s.person.P2.id, s.rel.p1.id, 'optionId', s.person.P1.email])
      expect(text, secret).not.toContain(secret);
    expect(uuidIn(text), '不含任何 ID').toBe(false);
  });

  it('字段裁剪后的 JSON 生成的版面同样被裁剪：看不到分数字段时版面里也没有分数', async () => {
    const { s, reportId } = await answered('f060-t3');
    const json = await s.w.ok<Record<string, unknown>>(s.w.request('GET', `${s.path}/reports/${reportId}`));
    const part = (json.questionnaires as { overview: { other: number } }[])[0]!;
    const withScore = docText(reportDocument(json as never));
    expect(withScore).toContain(part.overview.other.toFixed(4));
    // 去掉 score 类字段（模拟结果对象无“分数”字段权限时 present 的输出）后重新生成版面
    const stripped = JSON.parse(JSON.stringify(json), (k, v) =>
      ['score', 'self', 'other', 'gap', 'value', 'reference'].includes(k) ? undefined : v,
    ) as never;
    expect(docText(reportDocument(stripped))).not.toContain(part.overview.other.toFixed(4));
  });

  it('清单超过上限时拒绝（整份文件必须与数据一致，不静默截断）', () => {
    const items = Array.from({ length: EXPORT_ROW_LIMIT + 1 }, (_, i) => ({
      objectName: `对象${i}`,
      questionnaireName: '套卷',
      itemName: null,
      values: [1],
    }));
    expect(() =>
      scoreTableDocument({ level: 'questionnaire', columns: [{ scope: 'self' }], items } as never, {
        activityName: '活动',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  });
});

async function file(s: SceneB, path: string, user?: string) {
  return user ? s.w.as(user)('GET', path) : s.w.request('GET', path);
}

describe('F-060 报表 PNG 下载', () => {
  it('下载内容与 score-tables JSON 一致：同一份数据生成、确定性、是有效的 PNG 附件', async () => {
    const { s } = await answered('f060-p1');
    for (const level of LEVELS) {
      const json = await s.w.ok<TableJson>(s.w.request('GET', `${s.path}/score-tables?level=${level}`));
      const res = await file(s, `${s.path}/score-tables/download?level=${level}`);
      if (!fonts) {
        expect(res.status).toBe(503);
        expect((await errorOf(res)).details?.reason).toBe('EXPORT_FONT_UNAVAILABLE');
        continue;
      }
      expect(res.status, level).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/);
      expect(decodeURIComponent(res.headers.get('content-disposition')!)).toContain(s.activity.name);
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(0, 8).toString('hex')).toBe(PNG_MAGIC);
      const meta = await sharp(bytes).metadata();
      expect(meta.width).toBeGreaterThan(200);
      expect(meta.height).toBeGreaterThan(100);
      const expected = await renderPng(scoreTableDocument(json, { activityName: s.activity.name }));
      expect(bytes.equals(expected), `${level} 与 JSON 生成的文件逐字节相同`).toBe(true);
      // 不是空白图
      const stats = await sharp(bytes).stats();
      expect(stats.channels.some((c) => c.stdev > 1)).toBe(true);
    }
  });

  it('参数与权限同 JSON 接口：非法 level 400、等级评定没有题目清单 400、无授权管理员 404、匿名 401', async () => {
    const { s } = await answered('f060-p2');
    const bad = await file(s, `${s.path}/score-tables/download?level=team`);
    expect(bad.status).toBe(400);
    const outsider = await s.w.member('无授权管理员');
    await s.w.appoint(outsider, 'advanced');
    expect((await file(s, `${s.path}/score-tables/download?level=questionnaire`, outsider)).status).toBe(404);
    const anonymous = await s.w.api.request(
      'GET',
      `/api/tenant/survey360${s.path}/score-tables/download?level=questionnaire`,
    );
    expect(anonymous.status).toBe(401);
    expect((await file(s, `/activities/${randomUUID()}/score-tables/download?level=questionnaire`)).status).toBe(404);
  });

  it('尚未计分的活动：和 JSON 一样给空清单，PNG 里是“暂无数据”', async () => {
    const s = await sceneB(testDb().db, 'f060-p3');
    const json = await s.w.ok<TableJson>(s.w.request('GET', `${s.path}/score-tables?level=questionnaire`));
    expect(json.items).toEqual([]);
    expect(docText(scoreTableDocument(json, { activityName: s.activity.name }))).toContain('暂无数据');
    const res = await file(s, `${s.path}/score-tables/download?level=questionnaire`);
    expect(res.status).toBe(fonts ? 200 : 503);
  });
});

describe('F-060 报告 PDF 下载', () => {
  it('管理端：内容与报告 JSON 一致，有效 PDF 附件，确定性', async () => {
    const { s, reportId } = await answered('f060-d1');
    const json = await s.w.ok<Record<string, unknown>>(s.w.request('GET', `${s.path}/reports/${reportId}`));
    const res = await file(s, `${s.path}/reports/${reportId}/download`);
    if (!fonts) {
      expect(res.status).toBe(503);
      return;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(decodeURIComponent(res.headers.get('content-disposition')!)).toContain('评价对象');
    const bytes = Buffer.from(await res.arrayBuffer());
    const head = bytes.subarray(0, 8).toString('latin1');
    expect(head).toMatch(/^%PDF-1\.\d/);
    expect(bytes.subarray(-6).toString('latin1')).toContain('%%EOF');
    const pages = bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(bytes.equals(await renderPdf(reportDocument(json as never)))).toBe(true);
  });

  it('活动数据变化后与 JSON 一样 409 DATA_CHANGED；范围外 / 不存在 404；匿名 401', async () => {
    const { s, reportId } = await answered('f060-d2');
    expect((await file(s, `${s.path}/reports/${randomUUID()}/download`)).status).toBe(404);
    const outsider = await s.w.member('无授权管理员');
    await s.w.appoint(outsider, 'advanced');
    expect((await file(s, `${s.path}/reports/${reportId}/download`, outsider)).status).toBe(404);
    expect((await s.w.api.request('GET', `/api/tenant/survey360${s.path}/reports/${reportId}/download`)).status).toBe(
      401,
    );
    // 屏蔽一份答卷 → 报告失效，JSON 与下载同一拦截
    const card = (await sheets(s))[0]!;
    await s.w.ok(s.w.request('POST', `${s.path}/sheets/${card.id}/block`, { ifMatch: card.revision }));
    const json = await s.w.request('GET', `${s.path}/reports/${reportId}`);
    const download = await file(s, `${s.path}/reports/${reportId}/download`);
    expect([json.status, download.status]).toEqual([409, 409]);
    expect((await errorOf(download)).details?.reason).toBe('DATA_CHANGED');
  });

  it('收件人链接：凭转发邮件里的令牌下载同一份 PDF；令牌错误、报告不在清单里、缺令牌都是 404', async () => {
    const { s, reportId } = await answered('f060-d3');
    await s.w.ok(
      s.w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'reporting', targets: ['self'] },
      }),
    );
    const mail = (await outbox(s.w, 'survey360.report_forward')).find((m) => m.payload.to === s.person.T.email)!;
    const call = reportLink(s.w, mail.payload.token);
    const json = await s.w.ok<Record<string, unknown>>(call('GET', `/reports/${reportId}`));
    const res = await call('GET', `/reports/${reportId}/download`);
    if (!fonts) {
      expect(res.status).toBe(503);
    } else {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.equals(await renderPdf(reportDocument(json as never)))).toBe(true);
    }
    expect((await call('GET', `/reports/${randomUUID()}/download`)).status).toBe(404);
    expect((await reportLink(s.w, 'forged-token')('GET', `/reports/${reportId}/download`)).status).toBe(404);
    const missing = await s.w.api.request('GET', `/api/survey360/report-link/reports/${reportId}/download`, {
      tenant: s.w.tenantId,
    });
    expect(missing.status).toBe(404);
  });
});

describe('F-060 受限管理员只得到范围内的文件', () => {
  it('精细化权限：范围内的报告 / 报表 PNG 与 JSON 同口径；范围外报告 404', async () => {
    const { s, reportId } = await answered('f060-r1');
    const { w } = s;
    const mou = await w.ok<{ id: string }>(
      w.enterprise('POST', '/mous', {
        ifMatch: 0,
        body: { code: 'mou-f060r1', name: '甲部门', orgRanges: [{ orgId: s.org.id, includeDescendants: true }] },
      }),
      201,
    );
    const admin = await w.member('受限管理员');
    await w.appoint(admin, 'advanced');
    await w.ok(
      w.enterprise('PUT', `/scopes/${admin}/${survey360.SURVEY360_APP}`, {
        ifMatch: 0,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    const current = await w.getActivity(s.activity.id);
    await w.ok(w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [admin] } }));
    const as = w.as(admin);

    const json = await w.ok<TableJson>(as('GET', `${s.path}/score-tables?level=questionnaire`));
    const png = await as('GET', `${s.path}/score-tables/download?level=questionnaire`);
    expect(png.status).toBe(fonts ? 200 : 503);
    if (fonts) {
      const bytes = Buffer.from(await png.arrayBuffer());
      expect(bytes.equals(await renderPng(scoreTableDocument(json, { activityName: s.activity.name })))).toBe(true);
    }
    expect((await as('GET', `${s.path}/reports/${reportId}/download`)).status).toBe(fonts ? 200 : 503);
    expect((await as('GET', `${s.path}/reports/${randomUUID()}/download`)).status).toBe(404);
  });
});
