import type { Message } from '@anthropic-ai/sdk/resources/messages';

import { DEFAULT_CLAUDE_MODEL } from '../claudeReview.ts';

/** A one-file diff Claude can review. */
export const SOURCE_DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

/** Claude's reply calling `submit_review` with `input`. */
export function toolMessage(input: unknown, overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_CLAUDE_MODEL,
    content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_review', input, caller: { type: 'direct' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...overrides,
  } as unknown as Message;
}
