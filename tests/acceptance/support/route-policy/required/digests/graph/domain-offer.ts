/**
 * 直接依赖图：区域 domain-offer（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/offer/identity.ts#birthDateFromIdCard': ['#CHECK_CODES', '#WEIGHTS'],
  'packages/domain/src/offer/rules.ts#OFFER_FIELDS': ['#OFFER_FIELD_SECTIONS'],
  'packages/domain/src/offer/rules.ts#approvalAfterEdit': ['#effectiveOfferType'],
  'packages/domain/src/offer/rules.ts#missingOfferFields': ['#blank', '#offerRequiredFields'],
  'packages/domain/src/offer/rules.ts#offerInvalidatable': ['#effectiveOfferType'],
  'packages/domain/src/offer/rules.ts#offerRequiredFields': [
    '#INTERN_REQUIRED',
    '#SOCIAL_REQUIRED',
    '#effectiveOfferType',
  ],
  'packages/domain/src/offer/rules.ts#offerTransferTargets': ['#OFFER_TRANSITIONS', '#transitionGuard'],
  'packages/domain/src/offer/rules.ts#planOfferDispatch': ['#planOfferSend'],
  'packages/domain/src/offer/rules.ts#planOfferInvalidation': ['#blank', '#offerInvalidatable', '#reject'],
  'packages/domain/src/offer/rules.ts#planOfferSend': ['#effectiveOfferType', '#reject'],
  'packages/domain/src/offer/rules.ts#planOfferTransition': ['#blank', '#reject', '#transitionGuard'],
  'packages/domain/src/offer/rules.ts#transitionGuard': ['#OFFER_TRANSITIONS'],
  'packages/domain/src/offer/rules.ts#validOfferReviewFieldsSetting': [
    '#OFFER_FIELDS',
    '#OFFER_TYPES',
    '#offerRequiredFields',
  ],
  'packages/domain/src/offer/rules.ts#validOfferSendApprovalSetting': ['#OFFER_TYPES'],
  'packages/domain/src/offer/views.ts#OFFER_VIEWS': ['#LABEL_FIELDS', '#SOURCES'],
  'packages/domain/src/offer/views.ts#SOURCES': ['#DATE', '#w'],
  'packages/domain/src/offer/views.ts#offerRowActions': [
    'packages/domain/src/offer/rules.ts#offerEditable',
    'packages/domain/src/offer/rules.ts#offerInvalidatable',
  ],
  'packages/domain/src/offer/views.ts#offerView': ['#OFFER_VIEWS'],
};
