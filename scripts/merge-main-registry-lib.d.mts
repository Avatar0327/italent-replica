export declare const DECLARED_DIR: string;
export declare const DECLARED_INDEX_PATH: string;
export declare const REGISTRY_LINE_FILES: Readonly<Record<string, readonly RegExp[]>>;
export declare const REGISTRY_PATHS: readonly string[];
export declare function isDeclaredModulePath(file: string): boolean;
export declare function isRegistryPath(file: string): boolean;
export interface RegistryVersions {
  ours: string;
  base: string;
  theirs: string;
}
export interface RegistryTools {
  ts: unknown;
  prettier: unknown;
}
export declare function unionLineHunk(
  patterns: readonly RegExp[],
  hunk: { ours: string; base: string | null; theirs: string },
): string | null;
export declare function resolveLineRegistry(
  file: string,
  diff3Text: string,
): { text: string; remaining: number } | null;
export declare function loadTools(): Promise<RegistryTools | undefined>;
export declare function parseDeclared(
  ts: unknown,
  text: string,
): { head: string; tail: string; keys: { name: string; comment: string; items: (string | string[])[] }[] };
export declare function roundTripDeclared(tools: RegistryTools, file: string, text: string): Promise<string>;
export declare function mergeDeclared(
  tools: RegistryTools,
  file: string,
  versions: RegistryVersions,
): Promise<{ text: string; error?: undefined } | { error: string; text?: undefined }>;
export declare function declaredProblems(tools: RegistryTools, text: string, versions: RegistryVersions): string[];
export declare function resolveRegistryFile(
  tools: RegistryTools | undefined,
  file: string,
  input: { versions: Partial<Record<keyof RegistryVersions, string | undefined>>; diff3: string | undefined },
): Promise<{ text: string; error?: undefined } | { error: string; text?: undefined }>;
export declare function registryProblems(
  tools: RegistryTools | undefined,
  file: string,
  text: string,
  versions: RegistryVersions,
): string[];
