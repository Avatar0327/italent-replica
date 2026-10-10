/**
 * 报告 PDF / 报表 PNG 的内置中文字体（F-080，DEC-375①）：
 * - 字体文件在 `apps/api/assets/fonts`（Noto Sans SC / 思源黑体常用字子集，SIL OFL，来源、字表与重新生成方法见该目录
 *   README 与 `scripts/fonts/build-cjk-subset.py`），随代码一起发布；渲染从项目路径加载，不依赖服务器安装的字体；
 * - 渲染进程用一份只含这个目录的 fontconfig 配置（不含系统字体目录），所以任何机器上出同一份字形，也不受部署环境
 *   FONTCONFIG_* 的影响；
 * - 缺失 / 被改动是启动期错误：登记了每个文件的 SHA-256，启动检查与首次渲染都会校验；
 * - 字体二进制不 import、不进 F-039 的证据闭包与摘要（evidence-closure 显式跳过资源文件）。
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** SVG 里使用的字体族（两个字重同一个族名，粗细由 font-weight 选择）。 */
export const EXPORT_FONT_FAMILY = 'Noto Sans SC';

export interface ExportFontFile {
  readonly file: string;
  readonly weight: 400 | 700;
  /** 登记的 SHA-256（重新子集化后同步更新）。 */
  readonly sha256: string;
  /** 绝对路径。 */
  readonly path: string;
}

const REGISTERED = [
  {
    file: 'NotoSansSC-Regular.subset.ttf',
    weight: 400,
    sha256: 'be205009f27b6ac16d88e4e54be30b00c60cb5b61ed0db5fcc5993ee1e6842b6',
  },
  {
    file: 'NotoSansSC-Bold.subset.ttf',
    weight: 700,
    sha256: 'dd9b0e1107e629d020d7bf96671bdd773373e6c7fd506049c450c68b539dedb6',
  },
] as const;

/** `apps/api/assets/fonts`：src 与 dist 下本文件都在 `modules/survey360/`，相对位置相同。 */
export function exportFontDirectory(): string {
  return path.resolve(fileURLToPath(new URL('../../../assets/fonts/', import.meta.url)));
}

export function exportFontFiles(directory: string = exportFontDirectory()): readonly ExportFontFile[] {
  return REGISTERED.map((font) => ({ ...font, path: path.join(directory, font.file) }));
}

const fail = (code: 'EXPORT_FONT_MISSING' | 'EXPORT_FONT_CORRUPT', detail: string) =>
  new Error(`${code}：${detail}。内置中文字体随代码发布（apps/api/assets/fonts），请确认部署包完整`);

/** 逐个文件：必须存在，且 SHA-256 与登记一致；不满足抛 EXPORT_FONT_MISSING / EXPORT_FONT_CORRUPT。 */
export async function verifyExportFonts(directory: string = exportFontDirectory()): Promise<readonly ExportFontFile[]> {
  const files = exportFontFiles(directory);
  for (const font of files) {
    let bytes: Buffer;
    try {
      bytes = await readFile(font.path);
    } catch {
      throw fail('EXPORT_FONT_MISSING', `缺少字体文件 ${font.file}（${directory}）`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== font.sha256)
      throw fail('EXPORT_FONT_CORRUPT', `字体文件 ${font.file} 与登记的摘要不一致（缺失内容或被改动）`);
  }
  return files;
}

const xml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CONFIG_PREFIX = 'italent-export-fontconfig-';
/** 目录名 = 前缀 + 创建进程的 PID + mkdtemp 的 6 位随机后缀：据此判断残余目录的主人是否还活着。 */
const CONFIG_DIR = new RegExp(`^${CONFIG_PREFIX}(\\d+)-[A-Za-z0-9]{6}$`);

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * 回收崩溃（SIGKILL / 断电 / OOM）留下的 fontconfig 临时目录：只删“名字符合、是本用户的真实目录（不跟随链接）、所属进程
 * 已不存在”的；存活进程的、不符合命名的目录一律不动。启动检查与首次创建目录时各调用一次。
 */
export function reclaimStaleFontDirs(): void {
  const root = tmpdir();
  const uid = process.getuid?.();
  for (const name of readdirSync(root)) {
    const owner = CONFIG_DIR.exec(name)?.[1];
    if (owner === undefined || processAlive(Number(owner))) continue;
    const dir = path.join(root, name);
    try {
      const stat = lstatSync(dir);
      if (stat.isDirectory() && (uid === undefined || stat.uid === uid)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // 并发回收 / 权限不足：忽略，下次再试
    }
  }
}

const created = new Set<string>();
const removeCreated = () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.clear();
};
let hooked = false;

/**
 * 进程正常退出（exit 事件）时清理本进程创建的目录。**不接管 SIGINT / SIGTERM**：在信号上挂监听并重发信号，会抢在既有
 * 的异步停机流程（server.ts 里落盘 PGlite 的 `handle.close().finally(process.exit)`）之前终止进程，关库做不完
 * （#198 第 3 轮 P2-3）。被信号终止、崩溃留下的目录由下一次启动回收（reclaimStaleFontDirs）。
 */
function hookCleanup(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', removeCreated);
}

/**
 * 只含内置字体目录的 fontconfig 配置：写进本进程独占的临时目录（mkdtemp，不用可预测的共享路径，避免被别的本机用户
 * 预先放置的链接劫持），进程正常退出时清掉，被信号终止 / 崩溃的残留由下次启动回收；返回渲染子进程的环境变量。
 */
function fontEnvironment(directory: string): NodeJS.ProcessEnv {
  reclaimStaleFontDirs();
  const home = mkdtempSync(path.join(tmpdir(), `${CONFIG_PREFIX}${process.pid}-`));
  created.add(home);
  hookCleanup();
  const conf = path.join(home, 'fonts.conf');
  writeFileSync(
    conf,
    `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${xml(directory)}</dir>` +
      `<cachedir>${xml(path.join(home, 'cache'))}</cachedir></fontconfig>\n`,
  );
  return { PATH: process.env.PATH ?? '', FONTCONFIG_FILE: conf, FONTCONFIG_PATH: home };
}

/** 渲染进程环境（字体通过校验后才给；每个目录校验一次）。 */
const verified = new Map<string, Promise<NodeJS.ProcessEnv>>();
export function exportFontEnv(directory: string = exportFontDirectory()): Promise<NodeJS.ProcessEnv> {
  let env = verified.get(directory);
  if (!env) {
    env = verifyExportFonts(directory).then(() => fontEnvironment(directory));
    // 校验失败不缓存：补上字体后无需重启进程即可恢复
    env.catch(() => verified.delete(directory));
    verified.set(directory, env);
  }
  return env;
}
