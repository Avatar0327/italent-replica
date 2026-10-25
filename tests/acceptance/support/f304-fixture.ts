import { PRESET_PROCESSES } from '@italent/domain';
import { flowFixture } from './f315-fixture.js';

export function fallbackFixture() {
  const flow = flowFixture();
  const preset = PRESET_PROCESSES.find((item) => item.approvalType === 'exit_handover')!;
  return {
    ...flow,
    approvalType: 'exit_handover',
    latestVersion: {
      ...flow.latestVersion,
      ...structuredClone(preset.definition),
      nodes: preset.definition.nodes.map((node) => ({
        ...structuredClone(node),
        kind: node.kind ?? 'single',
        ...(node.kind === 'countersign' ? { transitionRule: { ...node.transitionRule, rules: {} } } : {}),
        actions: { ...flow.latestVersion.nodes[0]!.actions, ...node.actions },
        fallbackUserIds: [] as string[],
      })),
    },
  };
}
