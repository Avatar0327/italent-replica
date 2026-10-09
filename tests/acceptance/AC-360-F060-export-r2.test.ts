/**
 * F-060 第 2 轮（PR #174 Astra Max 首轮审查 P2-1～P2-4 与 P3）：
 * - P2-1：隐藏 Activity.name 的查看人，PNG 图内标题与 Content-Disposition 文件名都不带活动名称（中性占位）；
 * - P2-2：PDF 表格里超过一页的长行拆分续接（题干、指标名称 + 定义等所有表格块），尾文在后续页可见，管理端与收件人链接两个入口；
 * - P2-3：PNG 按实际排版高度 / 像素预算在渲染前拒绝（413 EXPORT_TOO_LARGE，不是 500）；80 页限制在排版过程中检查；
 *   三个下载入口有应用层并发准入（EXPORT_BUSY）与渲染超时（EXPORT_TIMEOUT）；
 * - P2-4：字体覆盖用 fontconfig 查询（隔离到无中文字体的配置时必须判缺）；有字体 / 缺字体两种环境用探针覆盖固定测试，
 *   缺字体时三个入口全部 503 EXPORT_FONT_UNAVAILABLE；
 * - P3：附件文件名按完整字符截断（含代理对不抛 URIError）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A4,
  admitted,
  attachmentName,
  configureExport,
  docText,
  EXPORT_PAGE_LIMIT,
  exportStartupCheck,
  HIDDEN_ACTIVITY_NAME,
  overrideFontProbe,
  paginate,
  probeFontCoverage,
  renderPdf,
  renderPng,
  reportDocument,
  resetExport,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { errorOf, key, outbox, reportLink, reports, sceneB } from './AC-360-B-support.js';

const testDb = useTestDb();

afterEach(() => {
  overrideFontProbe(undefined);
  resetExport();
});

/** 合法的超长题干：330 次换行，一页放不下（审查复现用例是 997 字符 / 330 换行）。 */
const LONG = `${Array.from({ length: 331 }, () => '行').join('\n')}\n结尾标记`;
const longQuestion = (content: { questions: { text: string }[] }) => ({
  ...content,
  questions: content.questions.map((q, i) => (i === 0 ? { ...q, text: LONG } : q)),
});

async function scene(label: string, long = false) {
  const s = await sceneB(testDb().db, label, {}, long ? (c) => longQuestion(c as never) : undefined);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: `${label}建议`, remark: '备注' });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: `${label}同事建议` });
  await s.w.transition(s.activity.id, 'disable');
  await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
  const [row] = await reports(s);
  return { s, reportId: row!.id! };
}

// ---- P2-1 -------------------------------------------------------------------------------------------------------

/** 某对象全部数据操作与按钮，可隐藏字段（与 AC-360-R3-guards 的 perm 同口径）。 */
function profile(object: 'activity' | 'result', hide: readonly string[] = []) {
  const definition = survey360.SURVEY360_OBJECTS[object];
  const hidden = new Set(hide);
  return {
    objectCode: definition.code,
    dataOperations: { create: false, update: false, delete: false },
    fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hidden.has(f.code), edit: false })),
    buttons: [],
  };
}

describe('AC-360-F060 R2 P2-1 隐藏活动名称的查看人拿不到名称', () => {
  it('PNG：图内标题与文件名用中性占位；有名称权限的人照常带名称', async () => {
    overrideFontProbe(async () => true);
    const { s, reportId } = await scene('f060r2-name');
    const { w } = s;
    const user = await w.member('看不到活动名称');
    await w.grantProfile(
      user,
      await w.defineProfile('看不到活动名称', [profile('activity', ['name']), profile('result')] as never),
    );
    const current = await w.getActivity(s.activity.id);
    await w.ok(w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }));
    const as = w.as(user);

    // 前提：该查看人的活动 JSON 与报表 JSON 都没有名称
    const activity = await w.ok<Record<string, unknown>>(as('GET', s.path));
    expect(activity).not.toHaveProperty('name');
    const json = await w.ok<Record<string, unknown>>(as('GET', `${s.path}/score-tables?level=questionnaire`));
    expect(JSON.stringify(json)).not.toContain(s.activity.name);

    const hidden = await as('GET', `${s.path}/score-tables/download?level=questionnaire`);
    expect(hidden.status).toBe(200);
    const disposition = decodeURIComponent(hidden.headers.get('content-disposition')!);
    expect(disposition).not.toContain(s.activity.name);
    const bytes = Buffer.from(await hidden.arrayBuffer());
    expect(bytes.equals(await renderPng(scoreTableDocument(json as never, {})))).toBe(true);
    expect(docText(scoreTableDocument(json as never, {}))).not.toContain(s.activity.name);
    expect(HIDDEN_ACTIVITY_NAME).not.toContain(s.activity.name);

    // 报告同理：封面里的活动名称也按 Activity.name 的字段权限裁剪（JSON 与 PDF 一致）
    const report = await w.ok<Record<string, unknown>>(as('GET', `${s.path}/reports/${reportId}`));
    expect(JSON.stringify(report)).not.toContain(s.activity.name);
    const pdf = await as('GET', `${s.path}/reports/${reportId}/download`);
    expect(pdf.status).toBe(200);
    expect(decodeURIComponent(pdf.headers.get('content-disposition')!)).not.toContain(s.activity.name);
    expect(Buffer.from(await pdf.arrayBuffer()).equals(await renderPdf(reportDocument(report as never)))).toBe(true);
    expect(docText(reportDocument(report as never))).not.toContain(s.activity.name);

    // 有名称权限的管理员：文件名与图内标题带名称，且与隐藏版不同
    const full = await w.request('GET', `${s.path}/score-tables/download?level=questionnaire`);
    expect(decodeURIComponent(full.headers.get('content-disposition')!)).toContain(s.activity.name);
    expect(Buffer.from(await full.arrayBuffer()).equals(bytes)).toBe(false);
  });
});

describe('AC-360-F060 R3 P2-R2-1 隐藏活动名称的发送人不能经转发读回（第 3 轮，Opus 接手）', () => {
  it('转发预览与执行都 403、不发邮件；有完整查看权的发送人照常转发，收件人报告 JSON / PDF 保留活动名称', async () => {
    overrideFontProbe(async () => true);
    const { s, reportId } = await scene('f060r3-forward');
    const { w } = s;
    const user = await w.member('看不到活动名称的转发人');
    const result = profile('result');
    await w.grantProfile(
      user,
      await w.defineProfile('看不到活动名称的转发人', [
        profile('activity', ['name']),
        {
          ...result,
          dataOperations: { create: false, update: true, delete: false },
          buttons: [{ buttonCode: 'forwardReport', level: 'list' }],
        },
      ] as never),
    );
    const current = await w.getActivity(s.activity.id);
    await w.ok(w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }));
    const as = w.as(user);
    // 前提：该发送人在管理端看不到活动名称
    expect(JSON.stringify(await w.ok(as('GET', `${s.path}/reports/${reportId}`)))).not.toContain(s.activity.name);

    const body = { mode: 'others', others: [{ name: '自己', email: 'self-f060r3@example.com' }] };
    for (const path of ['/reports/forward/preview', '/reports/forward']) {
      const res = await as('POST', `${s.path}${path}`, { idempotencyKey: key(), body });
      expect(res.status, path).toBe(403);
      expect((await errorOf(res)).details?.reason, path).toBe('REPORT_FIELDS_RESTRICTED');
    }
    expect(await outbox(w, 'survey360.report_forward')).toEqual([]);

    // 合法收件人的全量口径保留：有完整查看权的管理员转发，收件人报告 JSON 与 PDF 都带活动名称
    await w.ok(
      w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'others', others: [{ name: 'HRBP', email: 'hrbp-f060r3@example.com' }] },
      }),
    );
    const [mail] = await outbox(w, 'survey360.report_forward');
    const call = reportLink(w, mail!.payload.token);
    const recipient = await w.ok<Record<string, unknown>>(call('GET', `/reports/${reportId}`));
    expect(JSON.stringify(recipient)).toContain(s.activity.name);
    const pdf = await call('GET', `/reports/${reportId}/download`);
    expect(pdf.status).toBe(200);
    expect(docText(reportDocument(recipient as never))).toContain(s.activity.name);
  });
});

// ---- P2-2 -------------------------------------------------------------------------------------------------------

const textsOf = (pages: ReturnType<typeof paginate>) =>
  pages.flatMap((p) => p.draws.filter((d) => d.t === 'text').map((d) => (d as { value: string }).value)).join('\n');
const insidePages = (pages: ReturnType<typeof paginate>) =>
  pages.every((p) => p.draws.every((d) => (d.t === 'line' ? d.y : d.t === 'rect' ? d.y + d.h : d.y) <= A4.height));

describe('AC-360-F060 R2 P2-2 PDF 长行拆分续接', () => {
  it('合法长题干：尾文在后续页可见，所有绘制都在页内（管理端与收件人链接两个入口）', async () => {
    overrideFontProbe(async () => true);
    const { s, reportId } = await scene('f060r2-long', true);
    const json = await s.w.ok<Record<string, unknown>>(s.w.request('GET', `${s.path}/reports/${reportId}`));
    expect(JSON.stringify(json)).toContain('结尾标记');
    const pages = paginate(reportDocument(json as never), 'a4');
    expect(insidePages(pages)).toBe(true);
    expect(textsOf(pages)).toContain('结尾标记');
    expect(pages.length).toBeGreaterThan(2);

    const admin = await s.w.request('GET', `${s.path}/reports/${reportId}/download`);
    expect(admin.status).toBe(200);
    expect(Buffer.from(await admin.arrayBuffer()).equals(await renderPdf(reportDocument(json as never)))).toBe(true);

    await s.w.ok(
      s.w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'reporting', targets: ['self'] },
      }),
    );
    const mail = (await outbox(s.w, 'survey360.report_forward')).find((m) => m.payload.to === s.person.T.email)!;
    const call = reportLink(s.w, mail.payload.token);
    const linkJson = await s.w.ok<Record<string, unknown>>(call('GET', `/reports/${reportId}`));
    const viaLink = await call('GET', `/reports/${reportId}/download`);
    expect(viaLink.status).toBe(200);
    expect(Buffer.from(await viaLink.arrayBuffer()).equals(await renderPdf(reportDocument(linkJson as never)))).toBe(
      true,
    );
  });

  it('所有表格块的长行都续页：指标名称 + 定义、评估详情、认知偏差、评价关系表', () => {
    const long = Array.from({ length: 200 }, (_, i) => `行${i}`).join('\n');
    const tail = '尾文标记';
    const part = {
      name: '套卷',
      preface: { relationTable: [{ roleName: `${long}\n${tail}关系`, completed: 1, invited: 1, rate: 100 }] },
      overview: { self: 1, other: 2, roles: [{ roleName: `${long}\n${tail}概况`, score: 3 }] },
      strengths: { strengths: [{ name: `${long}\n${tail}优势`, score: 1 }], weaknesses: [], byRole: [] },
      bias: { self: [{ name: `${long}\n${tail}偏差`, self: 1, other: 2, gap: -1 }], roles: [] },
      developmentAdvice: [{ name: '指标', definition: `${long}\n${tail}定义`, score: 1 }],
      details: [{ name: `${long}\n${tail}详情`, level: 'question', self: 1, other: 2, roles: [] }],
    };
    const pages = paginate(reportDocument({ cover: {}, questionnaires: [part] } as never), 'a4');
    expect(insidePages(pages)).toBe(true);
    const text = textsOf(pages);
    for (const where of ['关系', '概况', '优势', '偏差', '定义', '详情'])
      expect(text, where).toContain(`${tail}${where}`);
  });
});

// ---- P2-3 -------------------------------------------------------------------------------------------------------

describe('AC-360-F060 R2 P2-3 资源预算、并发准入与超时', () => {
  const tooLong = () =>
    scoreTableDocument(
      {
        level: 'question',
        columns: [{ scope: 'self' }],
        items: Array.from({ length: 60 }, (_, i) => ({
          objectName: `对象${i}`,
          questionnaireName: '套卷',
          itemName: i % 3 === 0 ? LONG : '题',
          values: [1],
        })),
      } as never,
      { activityName: '活动' },
    );

  it('PNG 渲染前按实际排版高度 / 像素预算拒绝（413 EXPORT_TOO_LARGE，不是 500），不进入 sharp', async () => {
    overrideFontProbe(async () => true);
    await expect(renderPng(tooLong())).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      details: expect.objectContaining({ reason: 'EXPORT_TOO_LARGE' }),
    });
  });

  it('HTTP：超预算返回 413 EXPORT_TOO_LARGE', async () => {
    overrideFontProbe(async () => true);
    const { s } = await scene('f060r2-budget');
    configureExport({ pixelBudget: 50_000 });
    const res = await s.w.request('GET', `${s.path}/score-tables/download?level=question`);
    expect(res.status).toBe(413);
    expect((await errorOf(res)).details?.reason).toBe('EXPORT_TOO_LARGE');
  });

  it('80 页限制在排版过程中检查：超限时不会把整份文档排完', () => {
    let reached = 0;
    const blocks = new Proxy(
      Array.from({ length: 12_000 }, (_, i) => ({ kind: 'text' as const, text: `行${i}` })),
      {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) reached = Math.max(reached, Number(prop));
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    expect(() => paginate({ title: '大文档', blocks }, 'a4')).toThrowError(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
    // 每页约 55 行：80 页上限之后不再继续排版
    expect(reached).toBeLessThan(EXPORT_PAGE_LIMIT * 70);
  });

  it('并发准入：同租户占满名额时三个入口返回 503 EXPORT_BUSY；释放后恢复', async () => {
    overrideFontProbe(async () => true);
    const { s, reportId } = await scene('f060r2-busy');
    configureExport({ tenantLimit: 1, globalLimit: 4 });
    let release!: () => void;
    const holder = admitted(s.w.tenantId, () => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();
    await s.w.ok(
      s.w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'reporting', targets: ['self'] },
      }),
    );
    const mail = (await outbox(s.w, 'survey360.report_forward')).find((m) => m.payload.to === s.person.T.email)!;
    const paths: [string, () => Promise<Response>][] = [
      ['PNG', () => s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`)],
      ['PDF', () => s.w.request('GET', `${s.path}/reports/${reportId}/download`)],
      ['收件人 PDF', () => reportLink(s.w, mail.payload.token)('GET', `/reports/${reportId}/download`)],
    ];
    for (const [name, call] of paths) {
      const res = await call();
      expect(res.status, name).toBe(503);
      expect((await errorOf(res)).details?.reason, name).toBe('EXPORT_BUSY');
    }
    release();
    await holder;
    for (const [name, call] of paths) expect((await call()).status, name).toBe(200);
  });

  it('全局名额：不同租户也受同一上限约束', async () => {
    overrideFontProbe(async () => true);
    const { s } = await scene('f060r2-global');
    configureExport({ tenantLimit: 4, globalLimit: 1 });
    let release!: () => void;
    const holder = admitted('另一个租户', () => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();
    const res = await s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).details?.reason).toBe('EXPORT_BUSY');
    release();
    await holder;
  });

  // 第 3 轮 P3（Opus 接手）：超时后取消渲染并释放名额，不能只返回超时、让 PDF 在后台继续逐页生成
  it('超时后取消渲染：名额在超时后很快释放（不等后台把整份 PDF 生成完）', async () => {
    overrideFontProbe(async () => true);
    const blocks = Array.from({ length: 1_600 }, (_, i) => ({ kind: 'text' as const, text: `第${i}行` }));
    const doc = { title: '取消测试', blocks };
    expect(paginate(doc, 'a4').length).toBeGreaterThan(20);
    configureExport({ timeoutMs: 100, tenantLimit: 1, globalLimit: 1 });
    const started = Date.now();
    await expect(admitted('取消', (signal) => renderPdf(doc, signal))).rejects.toMatchObject({
      details: expect.objectContaining({ reason: 'EXPORT_TIMEOUT' }),
    });
    // 名额释放：轮询到不再 EXPORT_BUSY 为止
    let freed = false;
    while (!freed && Date.now() - started < 10_000) {
      try {
        await admitted('取消', async () => undefined);
        freed = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(freed).toBe(true);
    // 整份 20+ 页的位图 PDF 生成要数秒；取消后应在一页的渲染时间内释放
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('渲染超时：EXPORT_TIMEOUT（503），不是 500，也不占着名额', async () => {
    overrideFontProbe(async () => true);
    const { s } = await scene('f060r2-timeout');
    configureExport({ timeoutMs: 1 });
    const res = await s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`);
    expect(res.status).toBe(503);
    expect((await errorOf(res)).details?.reason).toBe('EXPORT_TIMEOUT');
    resetExport();
    expect((await s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`)).status).toBe(200);
  });
});

// ---- P2-4 -------------------------------------------------------------------------------------------------------

/** 只含西文字体的 fontconfig 配置（审查复现：隔离到仅 Arial 后探测仍为 true）。 */
function isolatedFontconfig(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'f060-fc-'));
  const conf = join(dir, 'fonts.conf');
  writeFileSync(
    conf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${dir}</dir>` +
      `<cachedir>${join(dir, 'cache')}</cachedir></fontconfig>`,
  );
  return { ...process.env, FONTCONFIG_FILE: conf, FONTCONFIG_PATH: dir };
}

describe('AC-360-F060 R2 P2-4 字体覆盖检查', () => {
  it('隔离到没有任何中文字体的 fontconfig 时判缺（用真实 fc-list）', async () => {
    const result = await probeFontCoverage({ env: isolatedFontconfig() });
    expect(result).toBe(false);
  });

  it('fc-list 返回覆盖目标字符集的字体 → 有；空输出 / 命令不存在 / 失败 → 缺', async () => {
    expect(await probeFontCoverage({ run: async () => 'NotoSansCJK-Regular.ttc\n' })).toBe(true);
    expect(await probeFontCoverage({ run: async () => '' })).toBe(false);
    expect(await probeFontCoverage({ run: async () => '   \n' })).toBe(false);
    expect(
      await probeFontCoverage({
        run: async () => {
          throw Object.assign(new Error('spawn fc-list ENOENT'), { code: 'ENOENT' });
        },
      }),
    ).toBe(false);
  });

  it('有字体环境（探针固定为真）：三个入口 200，文件与 JSON 一致', async () => {
    overrideFontProbe(async () => true);
    const { s, reportId } = await scene('f060r2-fontok');
    expect((await s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`)).status).toBe(200);
    expect((await s.w.request('GET', `${s.path}/reports/${reportId}/download`)).status).toBe(200);
  });

  it('缺字体环境（探针固定为假）：PNG、管理端 PDF、收件人 PDF 全部 503 EXPORT_FONT_UNAVAILABLE', async () => {
    const { s, reportId } = await scene('f060r2-fontmissing');
    overrideFontProbe(async () => true);
    await s.w.ok(
      s.w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'reporting', targets: ['self'] },
      }),
    );
    const mail = (await outbox(s.w, 'survey360.report_forward')).find((m) => m.payload.to === s.person.T.email)!;
    overrideFontProbe(async () => false);
    for (const [name, res] of [
      ['PNG', await s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`)],
      ['PDF', await s.w.request('GET', `${s.path}/reports/${reportId}/download`)],
      ['收件人 PDF', await reportLink(s.w, mail.payload.token)('GET', `/reports/${reportId}/download`)],
    ] as const) {
      expect(res.status, name).toBe(503);
      expect((await errorOf(res)).details?.reason, name).toBe('EXPORT_FONT_UNAVAILABLE');
    }
  });

  it('启动检查：缺字体时记警告（含需要安装的字体），有字体时不记', async () => {
    const lines: string[] = [];
    overrideFontProbe(async () => false);
    await exportStartupCheck((line) => lines.push(line));
    expect(lines.join('\n')).toMatch(/fonts-noto-cjk|fonts-wqy-zenhei/);
    expect(lines.join('\n')).toContain('EXPORT_FONT_UNAVAILABLE');
    lines.length = 0;
    overrideFontProbe(async () => true);
    await exportStartupCheck((line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

// ---- P3 ---------------------------------------------------------------------------------------------------------

describe('AC-360-F060 R2 P3 附件文件名', () => {
  it('按完整字符截断：截断点落在代理对中间也不抛 URIError', () => {
    const name = `${'a'.repeat(119)}𠮷${'b'.repeat(20)}`;
    const header = attachmentName(name, 'pdf');
    expect(header).toMatch(/^attachment; filename\*=UTF-8''/);
    const decoded = decodeURIComponent(header.replace(/^attachment; filename\*=UTF-8''/, ''));
    expect([...decoded.replace(/\.pdf$/, '')]).toHaveLength(120);
    expect(decoded).toContain('𠮷');
  });
});
