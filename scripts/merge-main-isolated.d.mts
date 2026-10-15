export interface IsolatedTree {
  /** 临时根目录（放临时索引） */
  base: string;
  /** 从树逐字节写出的目录 */
  dir: string;
  /** 路径 → 写出时的模式与对象 id */
  entries: Map<string, { mode: string; sha: string }>;
  cleanup(): void;
}
export interface CollectedTree {
  tree: string;
  changed: string[];
  problems: string[];
}
export declare function symlinkEscapes(file: string, target: string): boolean;
export declare function createIsolation(root: string): {
  unprovableProblems(): string[];
  materializeTree(tree: string, prefix?: string): Promise<IsolatedTree>;
  collectTree(iso: IsolatedTree, tree: string, allowed: (file: string) => boolean): CollectedTree;
};
