/** DEC-642：仅新增目录对照检查，不改 F-039 证据 / 必需项 / 核心判定语义。 */
import type { ButtonRef, RoutePolicy } from '@italent/api';
import { objectCatalog } from '../../../../apps/api/src/modules/permission/catalog.js';
import { objectsOf } from './perms.js';

type Node = Record<string, unknown>;
function refs(value: unknown): ButtonRef[] {
  if (!value || typeof value !== 'object') return [];
  const ref = value as Node;
  if (typeof ref['code'] === 'string') return [value as ButtonRef];
  return Object.values((ref['map'] ?? {}) as Node).flatMap(refs);
}

export function catalogButtonMismatches(policy: RoutePolicy): string[] {
  const findings: string[] = [];
  function visit(node: Node) {
    const objects = objectsOf(node['object']) ?? [];
    const buttons = [...refs(node['button']), ...refs((node['rows'] as Node | undefined)?.['button'])];
    for (const code of objects) {
      const definition = objectCatalog.get(code);
      for (const ref of buttons) {
        const registered = definition?.buttons.filter((button) => button.code === ref.code) ?? [];
        if (registered.length && !registered.some((button) => button.level === ref.level)) {
          findings.push(`${code}#${ref.code}: 声明 ${ref.level}，目录 ${registered.map((b) => b.level).join('/')}`);
        }
      }
    }
    for (const child of (node['of'] ?? []) as Node[]) visit(child);
    for (const child of Object.values((node['optional'] ?? {}) as Record<string, Node>)) visit(child);
  }
  visit(policy as unknown as Node);
  return findings;
}
