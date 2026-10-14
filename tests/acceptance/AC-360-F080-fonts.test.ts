/**
 * F-080（DEC-375①）：项目内置精简版开源中文字体（Noto Sans SC / 思源黑体，SIL OFL 1.1），报告 PDF / 报表 PNG 的栅格化
 * 只用项目路径里的字体，不再依赖服务器安装的字体，也不再用 fc-list 探测：
 * - 字体文件、许可文件（OFL.txt）、可复现的子集化脚本都在仓库里；字体体积 3～5.5 MB，Regular / Bold 两个字重；
 * - 字表 = GB 2312 全部字符 + ASCII：6763 个常用汉字（含目前版面里出现的全部文字）都有字形；
 * - 渲染与系统字体无关：把系统 fontconfig 隔离到没有任何字体的配置，PNG / PDF 逐字节不变，下载入口仍是 200；
 * - 内置字体缺失 / 被改动才是启动期错误（进程拒绝启动），运行期不再有“缺字体 503”。
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as exportFiles from '../../apps/api/src/modules/survey360/export-files.js';
import {
  docText,
  EXPORT_FONT_FAMILY,
  exportFontDirectory,
  exportFontFiles,
  exportStartupCheck,
  renderPdf,
  renderPng,
  reportDocument,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { errorOf, key, reports, sceneB } from './AC-360-B-support.js';
import { cmapCodepoints } from './support/ttf-cmap.js';

const testDb = useTestDb();
const ROOT = process.cwd();
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('AC-360-F080 内置字体文件、许可与子集化脚本', () => {
  it('字体目录在 apps/api/assets/fonts：两个字重、OFL.txt、体积 3～5.5 MB', () => {
    expect(exportFontDirectory()).toBe(join(ROOT, 'apps/api/assets/fonts'));
    const files = exportFontFiles();
    expect(files.map((f) => f.file)).toEqual(['NotoSansSC-Regular.subset.ttf', 'NotoSansSC-Bold.subset.ttf']);
    expect(files.map((f) => f.weight)).toEqual([400, 700]);
    let total = 0;
    for (const f of files) {
      expect(sha256(f.path), `${f.file} 的登记摘要与文件一致`).toBe(f.sha256);
      total += statSync(f.path).size;
    }
    expect(total).toBeGreaterThan(3 * 1024 * 1024);
    expect(total).toBeLessThan(5.5 * 1024 * 1024);
    expect(EXPORT_FONT_FAMILY).toBe('Noto Sans SC');
    const license = readFileSync(join(exportFontDirectory(), 'OFL.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(license).toContain('Copyright 2014-2021 Adobe');
  });

  it('子集化脚本可复现：写明输入字体包与版本、校验输入摘要、说明字表来源；字体目录里只有登记的文件', () => {
    const script = readFileSync(join(ROOT, 'scripts/fonts/build-cjk-subset.py'), 'utf8');
    expect(script).toContain('@expo-google-fonts/noto-sans-sc@0.4.4');
    expect(script).toContain('GB 2312');
    expect(script).toContain('fonttools==4.66.1');
    expect(script).toMatch(/hashlib\.sha256/);
    const names = readdirSync(exportFontDirectory()).sort();
    expect(names).toEqual(['NotoSansSC-Bold.subset.ttf', 'NotoSansSC-Regular.subset.ttf', 'OFL.txt', 'README.md']);
  });
});

/** 一份把所有版面文字都用到的报告 + 报表。 */
function sampleDocs() {
  const part = {
    name: '套卷',
    preface: {
      relationTable: [{ roleName: '同事', completed: 1, invited: 2, rate: 50 }],
      total: { completed: 1, invited: 2, rate: 50 },
      scaleTable: [{ label: '非常符合', value: 5 }],
    },
    overview: { self: 1, other: 2, roles: [{ roleName: '上级', score: 3 }], reference: { value: 4 } },
    strengths: { strengths: [{ name: '沟通', score: 1 }], weaknesses: [{ name: '决策', score: 1 }], byRole: [] },
    bias: { self: [{ name: '沟通', self: 1, other: 2, gap: -1 }], roles: [] },
    developmentAdvice: [{ name: '沟通', definition: '清晰表达', score: 1 }],
    openFeedback: [{ text: '很好', roleName: '同事' }],
    supplementary: [{ question: '其他建议', answers: [{ text: '无', roleName: '上级' }] }],
    details: [{ name: '沟通', level: 'basic', self: 1, other: 2, roles: [] }],
  };
  return [
    reportDocument({
      cover: { objectName: '张三', activityName: '活动', department: '部门', position: '职位', templateName: '模板' },
      questionnaires: [part],
      statement: '声明',
    } as never),
    scoreTableDocument(
      { level: 'question', columns: [{ scope: 'self' }, { scope: 'other' }], items: [] },
      { activityName: '活动' },
    ),
  ];
}

describe('AC-360-F080 字表覆盖：GB 2312 常用字全部有字形', () => {
  it('两个字重的字符数 ≥ 7000，覆盖 ASCII、版面用字，以及 GB 2312 的全部 6763 个汉字', () => {
    const gb = [...new TextDecoder('gb2312').decode(gb2312Bytes())].filter((c) => /\p{Script=Han}/u.test(c));
    expect(gb.length).toBe(6763);
    const used = [
      ...new Set(
        sampleDocs()
          .flatMap((d) => [...docText(d)])
          .filter((c) => c !== '\n'),
      ),
    ];
    expect(used.length).toBeGreaterThan(40);
    const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i));
    for (const f of exportFontFiles()) {
      const covered = cmapCodepoints(f.path);
      expect(covered.size, f.file).toBeGreaterThanOrEqual(7000);
      const missing = [...gb, ...used, ...ascii, ...'，。！？、；：（）【】“”‘’·—…％～'].filter(
        (c) => !covered.has(c.codePointAt(0)!),
      );
      expect(missing, `${f.file} 缺字形`).toEqual([]);
    }
  });
});

/** GB 2312 一级 + 二级汉字区的全部字节对（0xB0A1–0xF7FE，94 × 87 个码位里有字的部分）。 */
function gb2312Bytes(): Uint8Array {
  const bytes: number[] = [];
  const decoder = new TextDecoder('gb2312', { fatal: true });
  for (let high = 0xb0; high <= 0xf7; high += 1)
    for (let low = 0xa1; low <= 0xfe; low += 1) {
      try {
        decoder.decode(Uint8Array.of(high, low));
        bytes.push(high, low);
      } catch {
        // 码位无字
      }
    }
  return Uint8Array.from(bytes);
}

/** 隔离到没有任何字体的 fontconfig：旧实现会因此判“缺字体”并返回 503。 */
function isolatedFontconfig(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'f080-fc-'));
  const conf = join(dir, 'fonts.conf');
  writeFileSync(
    conf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${dir}</dir>` +
      `<cachedir>${join(dir, 'cache')}</cachedir></fontconfig>`,
  );
  return { FONTCONFIG_FILE: conf, FONTCONFIG_PATH: dir };
}

describe('AC-360-F080 渲染与系统字体无关', () => {
  const saved = { file: process.env.FONTCONFIG_FILE, path: process.env.FONTCONFIG_PATH };
  const restore = () => {
    for (const [name, value] of [
      ['FONTCONFIG_FILE', saved.file],
      ['FONTCONFIG_PATH', saved.path],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  afterEach(restore);

  it('系统 fontconfig 被隔离到没有字体时，PNG / PDF 逐字节与正常环境相同', async () => {
    const [report, table] = sampleDocs() as [ReturnType<typeof reportDocument>, ReturnType<typeof reportDocument>];
    const png = await renderPng(table);
    const pdf = await renderPdf(report);
    Object.assign(process.env, isolatedFontconfig());
    expect((await renderPng(table)).equals(png)).toBe(true);
    expect((await renderPdf(report)).equals(pdf)).toBe(true);
  });

  it('中文真的是用内置字体画出来的：不同的汉字渲染出不同的位图（不是统一的缺字方框）', async () => {
    const one = async (text: string) =>
      renderPng({ title: 't', blocks: [{ kind: 'text', text }] }).then((b) =>
        createHash('sha256').update(b).digest('hex'),
      );
    const [a, b, c] = await Promise.all([one('中文报告'), one('评价得分'), one('中文报告')]);
    expect(a).toBe(c);
    expect(a).not.toBe(b);
  });

  it('HTTP：系统没有任何字体时三类下载仍是 200（没有 503 EXPORT_FONT_UNAVAILABLE）', async () => {
    const s = await sceneB(testDb().db, 'f080-http');
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '建议' });
    await s.w.transition(s.activity.id, 'disable');
    await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
    const [row] = await reports(s);
    Object.assign(process.env, isolatedFontconfig());
    const png = await s.w.request('GET', `${s.path}/score-tables/download?level=questionnaire`);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const pdf = await s.w.request('GET', `${s.path}/reports/${row!.id}/download`);
    expect(pdf.status, JSON.stringify(pdf.status === 200 ? {} : await errorOf(pdf))).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });

  it('旧的字体探测接口已移除（不再有 fc-list、探针与缺字体 503）', () => {
    for (const name of ['exportFontReady', 'overrideFontProbe', 'probeFontCoverage', 'FONT_INSTALL_HINT'])
      expect(exportFiles, name).not.toHaveProperty(name);
    const runtime = readFileSync(join(ROOT, 'apps/api/src/modules/survey360/export-runtime.ts'), 'utf8');
    expect(runtime).not.toMatch(/fc-list|EXPORT_FONT_UNAVAILABLE/);
  });
});

describe('AC-360-F080 启动检查：内置字体缺失才是启动期错误', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'f080-fonts-'));
  });

  const copyFonts = (to: string) => {
    mkdirSync(to, { recursive: true });
    cpSync(exportFontDirectory(), to, { recursive: true });
  };

  it('字体齐全且摘要一致：通过，记一行已校验的日志，不抛', async () => {
    const lines: string[] = [];
    await exportStartupCheck((line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NotoSansSC-Regular.subset.ttf');
    expect(lines[0]).toContain('NotoSansSC-Bold.subset.ttf');
  });

  it('字体目录不存在 / 缺一个字体文件：启动检查抛错（EXPORT_FONT_MISSING，写明缺哪个文件）', async () => {
    await expect(exportStartupCheck(() => undefined, join(dir, 'none'))).rejects.toThrowError(/EXPORT_FONT_MISSING/);
    copyFonts(dir);
    expect(existsSync(join(dir, 'NotoSansSC-Bold.subset.ttf'))).toBe(true);
    writeFileSync(join(dir, 'NotoSansSC-Bold.subset.ttf'), Buffer.alloc(0));
    await expect(exportStartupCheck(() => undefined, dir)).rejects.toThrowError(/EXPORT_FONT_CORRUPT.*Bold/);
    const rest = mkdtempSync(join(tmpdir(), 'f080-fonts-'));
    copyFonts(rest);
    writeFileSync(join(rest, 'NotoSansSC-Regular.subset.ttf'), readFileSync(join(rest, 'OFL.txt')));
    await expect(exportStartupCheck(() => undefined, rest)).rejects.toThrowError(/EXPORT_FONT_CORRUPT.*Regular/);
    const gone = mkdtempSync(join(tmpdir(), 'f080-fonts-'));
    copyFonts(gone);
    rmSync(join(gone, 'NotoSansSC-Bold.subset.ttf'));
    await expect(exportStartupCheck(() => undefined, gone)).rejects.toThrowError(/EXPORT_FONT_MISSING.*Bold/);
  });

  it('进程入口 server.ts 直接 await 启动检查（不吞异常，字体缺失时进程起不来）', () => {
    const server = readFileSync(join(ROOT, 'apps/api/src/server.ts'), 'utf8');
    expect(server).toMatch(/^await exportStartupCheck\(/m);
    expect(server).not.toMatch(/exportStartupCheck\([^)]*\)\s*\.catch/);
    expect(server).not.toMatch(/try\s*{[^}]*exportStartupCheck/);
  });
});
