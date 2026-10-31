import { PRESET_PROCESSES, type ApprovalNode } from '@italent/domain';
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
      nodes: preset.definition.nodes.map((node): ApprovalNode =>
        node.kind === 'countersign'
          ? { ...structuredClone(node), transitionRule: { ...node.transitionRule, rules: {} }, fallbackUserIds: [] }
          : { ...structuredClone(node), kind: 'single', fallbackUserIds: [] },
      ),
    },
  };
}
