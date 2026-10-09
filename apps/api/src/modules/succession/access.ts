/**
 * 继任管理的权限接入（R3-T05 设计 §8；DEC-080 单一权限模型）：对象目录在领域层（SUCCESSION_OBJECTS），这里登记进
 * 权限目录；数据范围按对象所属应用 SuccessionAndDevelopment 解析（permission/module-access.ts scopeAppOf，
 * DEC-043、#107），缺省为空。路由的对象 / 按钮 / 字段 / 范围判定随 PR-A～PR-D 在本目录追加（设计 §2.1）。
 */
import { SUCCESSION_OBJECTS, type SuccessionObject } from '@italent/domain';
import { registerObjectDefinition } from '../permission/catalog.js';

for (const definition of Object.values(SUCCESSION_OBJECTS)) registerObjectDefinition(definition);

export const SUCCESSION_BASE = '/api/tenant/succession';

/** 审计动作前缀（`<前缀>.create|update|delete|…`）；审计查看规则按它取创建人（audit-scope.ts、DEC-198）。 */
export const SUCCESSION_AUDIT_ACTIONS: Readonly<Record<SuccessionObject, string>> = {
  record: 'succession.record',
  map: 'succession.map',
  riskResult: 'succession.risk-result',
  healthResult: 'succession.health-result',
  riskLevel: 'succession.risk-level',
  healthLevel: 'succession.health-level',
  population: 'succession.population',
  ruleSettings: 'succession.rule-settings',
  calcRun: 'succession.calc-run',
  syncBatch: 'succession.sync-batch',
};
