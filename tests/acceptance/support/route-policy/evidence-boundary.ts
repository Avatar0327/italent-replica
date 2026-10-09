/**
 * 证据闭包的边界清单（F-039 PR-B2，设计 B-02 第 3 点）。闭包从证据单元出发解析标识符，走到这里列出的文件就停，
 * 不展开也不登记依赖摘要。只放授权引擎与通用基础设施；模块内辅助函数（`modules/<模块>/`）一律不得进来——它们
 * 决定授权实参，改动必须让引用它们的义务重新复核。`modules/permission/` 是唯一例外（授权引擎本身）。
 * 单个依赖牵连的义务数超过 100 的非引擎依赖，列出由审查裁定，不自行加进边界（设计 B-02 第 5 点）。
 */
export interface BoundaryEntry {
  /** 仓库相对路径；以 `/` 结尾表示整个目录。 */
  readonly path: string;
  readonly reason: string;
}

export const EVIDENCE_BOUNDARY: readonly BoundaryEntry[] = [
  { path: 'apps/api/src/errors.ts', reason: '统一错误码与 AppError：构造错误，不决定谁被拒绝' },
  { path: 'apps/api/src/commands.ts', reason: '命令台账与幂等引擎（runCommand）：通用基础设施，授权在命令之前' },
  {
    path: 'apps/api/src/modules/permission/authorizer.ts',
    reason: '授权引擎：按授予的权限回答 authorize，由 permission 模块自己的验收测试保证',
  },
  { path: 'packages/db/', reason: '数据库连接、表结构与迁移：通用基础设施，不含授权判定' },
];

/** 路径是否落在边界清单里（文件精确匹配，或落在以 `/` 结尾的目录下）。 */
export function inBoundary(file: string, boundary: readonly BoundaryEntry[] = EVIDENCE_BOUNDARY): boolean {
  return boundary.some((entry) => (entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path));
}

/** 业务目录：边界目录不得等于或覆盖它们（`apps/`、`apps/api/src/` 这样的祖先目录会把整个 modules 带进边界）。 */
const BUSINESS_DIRS: readonly string[] = ['apps/api/src/modules/', 'packages/domain/'];

/** 清单形状：每条有理由；不得覆盖业务目录；`modules/<模块>/` 下除 `modules/permission/` 以外不允许出现。 */
export function assertBoundaryShape(boundary: readonly BoundaryEntry[]): void {
  for (const entry of boundary) {
    if (!entry.reason.trim()) throw new Error(`边界清单 ${entry.path} 缺理由`);
    if (entry.path.endsWith('/')) {
      const covered = BUSINESS_DIRS.find((dir) => dir.startsWith(entry.path));
      if (covered) throw new Error(`边界清单的目录 ${entry.path} 覆盖了业务目录 ${covered}`);
    }
    const module = /^apps\/api\/src\/modules\/([^/]+)\//.exec(entry.path)?.[1];
    if (module && module !== 'permission') {
      throw new Error(`边界清单不得放模块内文件（apps/api/src/modules/${module}/…）：${entry.path}`);
    }
  }
}
