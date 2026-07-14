import type { AutomationDispatchResult } from '@/lib/automations/engine';
import type { AutomationTriggerType } from '@/types';

export interface InboundAutomationResult {
  triggerType: AutomationTriggerType;
  result: AutomationDispatchResult;
}

export interface InboundAiEligibility {
  contentType: string;
  flowConsumed: boolean;
  interactiveReplyId: string | null;
  text: string;
  automationBlocked: boolean;
}

/** Relationship lifecycle automations never suppress the content responder. */
export function automationResultsBlockAi(
  results: readonly InboundAutomationResult[]
): boolean {
  return results.some(
    ({ triggerType, result }) =>
      (triggerType === 'new_message_received' ||
        triggerType === 'keyword_match') &&
      (result.matched > 0 || result.failed)
  );
}

/** The webhook's single source of truth for whether an inbound may queue AI. */
export function isInboundEligibleForAi(input: InboundAiEligibility): boolean {
  return (
    input.contentType === 'text' &&
    !input.flowConsumed &&
    !input.interactiveReplyId &&
    input.text.trim().length > 0 &&
    !input.automationBlocked
  );
}
