import {memberContext} from '@/lib/hris/context';
import {developmentContext} from '@/lib/hris/development-repository';
import {legacySelfService} from '@/lib/hris/r1-legacy-self-service';
import {portalSummary} from '@/lib/hris/r1-portal-summary';
import {json,failure} from '@/lib/hris/http';
export async function GET(){try{const member=await memberContext();if(member.member.securityStamp?.featuresEnabled)return json(await portalSummary(member));const ctx=await developmentContext(['homeworkSubmission','homeworkTask','learningExamAttempt','learningExamTask','learningAssignment','performanceCycle','performanceGoalChange','performanceCheckin','trainingRequest','onboardingPlan','leave','correction','performanceAppeal','performance','employeeFieldDefinition','employeeFieldValue','plan','enrollment','performancePlan','surveyRound','surveyResponse','paySlip','payBatch','payQuery','cadreObservation','feedbackProject','feedbackInvite','feedbackReply','feedbackReport']);return json(legacySelfService(ctx));}catch(e){return failure(e);}}
