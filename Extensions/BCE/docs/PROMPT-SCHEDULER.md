# ChatGPT Prompt Scheduler — Core Contract

**Status:** Scheduler state engine only. Browser-page sending, persistent storage wiring and UI controls are separate tasks.

## Design boundary

Each selected ChatGPT conversation receives its own prompt job and its own conversation lock. Jobs targeting the same conversation are strictly sequential. Jobs targeting different conversations may run concurrently, up to a host-configured limit (1–32).

The scheduler does not inspect ChatGPT DOM, send messages, select Thinking mode, or decide whether a response has completed. A trusted page adapter must provide those verified events later.

## Required execution order

1. Create and persist a validated job.
2. Claim a due job and persist its \`dispatching\` state and unique dispatch ID **before** touching the page.
3. The page adapter checks the exact conversation, composer availability, current generation state and requested controls.
4. After the adapter verifies that ChatGPT accepted the prompt, persist \`awaiting_response\` and increment the sent count.
5. Wait for explicit evidence that the assistant response completed. A timeout, tab close, network error or ambiguous DOM state is not completion.
6. Persist completion before the scheduler can claim the next repeat.

## Safety invariants

- One active job per conversation, including \`dispatching\`, \`awaiting_response\` and \`needs_attention\`.
- Different conversations can progress concurrently within a configurable bound.
- Finite jobs stop at the exact \`repeatCount\`; unlimited jobs use \`repeatCount: null\` and continue until the owner stops them.
- Pause and stop requests do not release an in-flight conversation lock. They take effect after the current response is reconciled.
- A worker restart during \`dispatching\` moves the job to \`needs_attention\`. It is never automatically sent again.
- A confirmed in-flight response retains its lock after worker restart until a page adapter reconciles it.
- An uncertain job requires an explicit operator resolution (\`not_sent\` or \`sent_and_completed\`) before it can continue.
- The scheduler never treats a button click, elapsed time or network timeout as proof of response completion.
- The module is deterministic and has no Chrome API dependency. A later storage adapter must persist each returned state transition before acting on it.

## Current limits

- This is not yet connected to \`service.js\`, \`ui.js\` or a ChatGPT content script.
- Jobs are not yet persisted in \`chrome.storage.local\`.
- There is no prompt-template editor, repeat controls, conversation picker or run-history UI yet.
- The scheduler does not send prompts or support Thinking-mode selection by itself.
- It does not use the legacy OpenAI API-key setting or any hosted model. The future connector must call the separately developed Development-AI service through its authenticated local bridge.

## Validation

Run \`npm run check\` from \`Extensions/BCE\`. The test suite covers finite/unlimited count behavior, per-conversation serialization, bounded cross-conversation concurrency, response-completion gating, pause/resume/stop, stale dispatch events and restart uncertainty.
