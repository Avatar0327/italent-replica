// 配置目录：config.json 为公共部分（Vitest 配置、收集范围、定义来源、非业务编号、收集档），
// 其余 <阶段>.json 为各阶段的范围（groups）与人工层（notes）。路径相对 config.json 中的 root，root 相对配置目录。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class UsageError extends Error {}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function loadConfig(configDir) {
  const dir = resolve(configDir);
  const raw = readJson(join(dir, 'config.json'));
  const root = resolve(dir, raw.root ?? '.');
  const stages = new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json') && name !== 'config.json')
      .sort()
      .map((name) => [name.slice(0, -'.json'.length), readJson(join(dir, name))]),
  );
  return {
    root,
    vitestConfig: resolve(root, raw.vitestConfig),
    filters: raw.filters ?? [],
    definitions: (raw.definitions ?? []).map((path) => resolve(root, path)),
    ignore: raw.ignore ?? {},
    profiles: raw.profiles ?? { default: {} },
    stages,
  };
}

/** 选出要统计的阶段：单个阶段名，或 all 表示全部阶段。 */
export function selectStages(config, stage) {
  if (stage === 'all') return [...config.stages.keys()];
  if (config.stages.has(stage)) return [stage];
  throw new UsageError(`未知阶段 ${stage}，可选：${[...config.stages.keys()].join(' / ')} / all`);
}
