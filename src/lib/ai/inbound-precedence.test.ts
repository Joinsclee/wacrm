import { describe, expect, it } from 'vitest';
import {
  automationResultsBlockAi,
  isInboundEligibleForAi,
} from './inbound-precedence';

describe('automationResultsBlockAi', () => {
  it('blocks for a matching content automation', () => {
    expect(
      automationResultsBlockAi([
        {
          triggerType: 'keyword_match',
          result: { matched: 1, failed: false },
        },
      ])
    ).toBe(true);
  });

  it('fails closed when a content automation cannot be evaluated', () => {
    expect(
      automationResultsBlockAi([
        {
          triggerType: 'new_message_received',
          result: { matched: 0, failed: true },
        },
      ])
    ).toBe(true);
  });

  it('does not block for relational automations, even when they match or fail', () => {
    expect(
      automationResultsBlockAi([
        {
          triggerType: 'new_contact_created',
          result: { matched: 1, failed: false },
        },
        {
          triggerType: 'first_inbound_message',
          result: { matched: 0, failed: true },
        },
      ])
    ).toBe(false);
  });
});

describe('isInboundEligibleForAi', () => {
  const eligible = {
    contentType: 'text',
    flowConsumed: false,
    interactiveReplyId: null,
    text: 'Hola',
    automationBlocked: false,
  };

  it('accepts only non-empty plain text left unhandled by deterministic responders', () => {
    expect(isInboundEligibleForAi(eligible)).toBe(true);
    expect(isInboundEligibleForAi({ ...eligible, contentType: 'image' })).toBe(
      false
    );
    expect(isInboundEligibleForAi({ ...eligible, flowConsumed: true })).toBe(
      false
    );
    expect(
      isInboundEligibleForAi({ ...eligible, interactiveReplyId: 'option-1' })
    ).toBe(false);
    expect(isInboundEligibleForAi({ ...eligible, text: '   ' })).toBe(false);
    expect(
      isInboundEligibleForAi({ ...eligible, automationBlocked: true })
    ).toBe(false);
  });
});
