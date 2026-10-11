/**
 * 直接依赖图：区域 domain-survey360（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/survey360/catalog.ts#ADVANCED_WITHOUT': ['#SURVEY360_BUTTONS'],
  'packages/domain/src/survey360/catalog.ts#ALL': ['#SURVEY360_OBJECTS'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS': ['#SURVEY360_BUTTONS', '#button', '#crud', '#object'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>activity': [
    '#SURVEY360_BUTTONS',
    '#button',
    '#crud',
    '#object',
  ],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>answer': ['#button', '#object'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>person': ['#SURVEY360_BUTTONS', '#button', '#object'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>questionnaire': [
    '#SURVEY360_BUTTONS',
    '#button',
    '#crud',
    '#object',
  ],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>relation': ['#button', '#crud', '#object'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>result': ['#button', '#object'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_OBJECTS>settings': ['#SURVEY360_BUTTONS', '#button', '#object'],
  'packages/domain/src/survey360/catalog.ts#SURVEY360_PROFILES': [
    '#ADVANCED_WITHOUT',
    '#ALL',
    '#SURVEY360_BUTTONS',
    '#grant',
  ],
  'packages/domain/src/survey360/catalog.ts#crud': ['#button'],
  'packages/domain/src/survey360/catalog.ts#object': ['#SURVEY360_APP'],
  'packages/domain/src/survey360/questionnaire.ts#allowedScoreMethods': ['#isLeaf'],
  'packages/domain/src/survey360/questionnaire.ts#methodIssues': ['#allowedScoreMethods'],
  'packages/domain/src/survey360/questionnaire.ts#roleIssues': [
    'packages/domain/src/survey360/rules.ts#SURVEY360_LIMITS',
  ],
  'packages/domain/src/survey360/questionnaire.ts#scaleIssues': [
    'packages/domain/src/survey360/rules.ts#SURVEY360_LIMITS',
  ],
  'packages/domain/src/survey360/questionnaire.ts#structureIssues': ['#childrenOf', '#isLeaf'],
  'packages/domain/src/survey360/questionnaire.ts#validateQuestionnaire': [
    '#methodIssues',
    '#roleIssues',
    '#scaleIssues',
    '#structureIssues',
  ],
  'packages/domain/src/survey360/scoring.ts#aggregateScores': ['#average'],
  'packages/domain/src/survey360/scoring.ts#answerableItems': [
    'packages/domain/src/survey360/questionnaire.ts#childrenOf',
    'packages/domain/src/survey360/questionnaire.ts#isLeaf',
    '#applies',
  ],
  'packages/domain/src/survey360/scoring.ts#maxTotal': ['#answerableItems', '#scoreSheet'],
  'packages/domain/src/survey360/scoring.ts#scoreSheet': [
    'packages/domain/src/survey360/questionnaire.ts#childrenOf',
    'packages/domain/src/survey360/questionnaire.ts#isLeaf',
    '#answerableItems',
    '#combine',
  ],
};
