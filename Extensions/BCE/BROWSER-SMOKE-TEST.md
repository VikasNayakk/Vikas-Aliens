# BCE real-browser smoke-test matrix

**Purpose:** verify the existing Manifest V3 extension in real Chrome before treating the ChatGPT scheduler or Teams reader as browser-verified. This is a test plan, not a claim that these manual tests have passed.

**Baseline under test:** Extensions/BCE on the Chatgpt branch. At the time this matrix was added, the branch's latest recorded commit was 3c1222956d46ddec78f9b090e8424804d2dd8b41; GitHub Actions run #44074705676 passed the automated BCE checks (44 unit tests, JavaScript syntax, manifest references and local assets). **That CI result does not replace these Chrome tests.**

## Test environment and safety

- Chrome 116 or later, desktop profile with the BCE unpacked extension loaded.
- Use a dedicated test profile if possible. Sign in to Teams / ChatGPT normally; do not store passwords or cookies in test notes.
- Prepare at least four harmless ChatGPT test conversations in separate tabs. Use non-sensitive prompts such as "Reply with exactly READY." and finite repeat counts first.
- For Teams, use a test group or a low-risk group whose members know it is being used for testing. Avoid reading private or confidential content aloud in a public space.
- Do not test with payments, account changes, deletion, external submissions or real business data.
- Capture only pass/fail, the test ID, extension version, Chrome version and a redacted observation. Do not attach private messages, full prompts, cookies, tokens or account identifiers.
- Stop the scheduler and Teams reader before changing permissions, reloading the extension or closing test tabs.

## Result recording

Use one result per case: **Not run**, **Pass**, **Fail**, or **Blocked**. A case is Pass only when the expected behavior is observed in Chrome, not merely because the related unit test passes.

| Field | Record |
|---|---|
| Date / tester | Not run |
| Chrome version | Not recorded |
| BCE version | 1.6.3 |
| Tested commit SHA | 3c1222956d46ddec78f9b090e8424804d2dd8b41 baseline; update if testing a later commit |
| Browser profile | Dedicated test profile recommended |
| Manual suite status | **Not run** |

## A. Install, permission and recovery

| ID | Scenario | Expected result |
|---|---|---|
| BCE-BR-001 | Load unpacked extension from Extensions/BCE | Chrome accepts the MV3 manifest; popup opens without a service-worker error |
| BCE-BR-002 | Inspect requested permissions | Only manifest-declared permissions appear; no unexpected host permission prompt |
| BCE-BR-003 | Reload extension while idle | Popup, options page and service worker recover; persisted prompt jobs remain visible |
| BCE-BR-004 | Remove ChatGPT site access / make a ChatGPT tab unavailable | Scheduler reports the tab is unavailable; it does not silently switch to another conversation |
| BCE-BR-005 | Stop all work, then reload extension | No queued job unexpectedly starts unless its persisted state is explicitly dispatchable |

## B. ChatGPT conversation targeting and send safety

| ID | Scenario | Expected result |
|---|---|---|
| BCE-CHAT-001 | Open one supported ChatGPT conversation and enumerate tabs | Only valid ChatGPT conversation tabs with a verified conversation ID are selectable |
| BCE-CHAT-002 | Create one job with a harmless prompt and repeat count 1 | Prompt is entered into the selected tab only; send is confirmed by a matching new user-message echo |
| BCE-CHAT-003 | Create a finite job with repeat count 2 | The second prompt is not sent until the first assistant response is considered complete; final completed count is 2 |
| BCE-CHAT-004 | Create an unlimited job | Repeats continue only after each response is considered complete; Stop after response prevents the next repeat |
| BCE-CHAT-005 | Create two jobs for the same conversation | Only one job can send / await a response at a time; the second stays queued |
| BCE-CHAT-006 | Create jobs for four different conversations | At most three different conversations are dispatched concurrently; the fourth waits |
| BCE-CHAT-007 | Use the same prompt text in two different conversations | Each job remains associated with its own conversation ID and tab; no cross-tab send |
| BCE-CHAT-008 | Try a blank prompt, no selected conversation and a prompt over 50,000 characters | The UI rejects invalid input before creating a job or sending anything |
| BCE-CHAT-009 | Try exactly 50,000 characters | Input is accepted only if the composer can reliably hold and verify the complete text; otherwise a clear no-send error is shown |
| BCE-CHAT-010 | Start a job while ChatGPT is already generating in that conversation | BCE refuses to queue/send into the busy conversation or clearly reports the existing generation; no overlapping send |
| BCE-CHAT-011 | Navigate the selected tab to a different conversation before dispatch | Job is not sent to the new conversation; it enters a safe failure/review state |
| BCE-CHAT-012 | Close the selected tab before dispatch | No alternate tab is selected automatically; job is paused/failed/reviewed according to its persisted state |
| BCE-CHAT-013 | Close the tab or lose extension contact during send | Job becomes needs_review; BCE does not automatically resend an uncertain prompt |
| BCE-CHAT-014 | Restart the extension service worker while a send is in progress | In-flight send becomes needs_review; same-conversation lock remains until manual resolution |
| BCE-CHAT-015 | Restart the worker while a response is being monitored | The persisted response monitor is restored where possible; no duplicate prompt is sent |
| BCE-CHAT-016 | Pause / Stop an active job during generation | Current response is allowed to settle; no next repeat is dispatched |
| BCE-CHAT-017 | Stop a queued job | It stops immediately and never sends |
| BCE-CHAT-018 | Use global Stop all with queued, active and needs_review jobs | Queued jobs stop immediately; active jobs stop after the current response; uncertain jobs remain locked for manual review |
| BCE-CHAT-019 | Force a lost or ambiguous completion signal | Job enters needs_review; user can inspect ChatGPT and choose an explicit resolution; BCE never guesses |
| BCE-CHAT-020 | Ask for Thinking mode / another ChatGPT UI mode | BCE changes the mode only if it finds and verifies the exact supported control and resulting state; otherwise it reports unavailable and does not send under a falsely claimed mode |

## C. Teams reader regression checks

| ID | Scenario | Expected result |
|---|---|---|
| BCE-TEAMS-001 | Add a currently open Teams group | Group name and stable conversation ID are verified before it is saved |
| BCE-TEAMS-002 | Add a group whose stable ID cannot be read | UI explains the Copy link recovery path; it does not save a name-only ambiguous target |
| BCE-TEAMS-003 | Select last-five vs only-new when adding a group | Only the selected behavior is applied to that group |
| BCE-TEAMS-004 | Enable Live message reading | Only selected groups are monitored; new in-app notification cards are processed |
| BCE-TEAMS-005 | Receive multiple messages from one selected group | Group heading is announced once, followed by messages in order with the configured pause |
| BCE-TEAMS-006 | Receive the same message/card more than once | Duplicate message/card IDs are ignored |
| BCE-TEAMS-007 | Receive a message from an unselected group | It is not spoken or treated as a selected-group event |
| BCE-TEAMS-008 | Turn Live message reading OFF during speech/audio | Monitoring stops and extension-started speech/audio is stopped |
| BCE-TEAMS-009 | Receive a visible audio player or direct audio link | Audio playback starts only when a source is actually exposed; speech waits until playback ends |
| BCE-TEAMS-010 | Receive an audio notification with no exposed media source | BCE does not claim playback succeeded and does not invent a media URL |

## D. Privacy and failure behavior

| ID | Scenario | Expected result |
|---|---|---|
| BCE-SEC-001 | Inspect extension storage after creating a test prompt job | Only expected scheduler state is stored; no cookies, passwords or API credentials are copied into job records |
| BCE-SEC-002 | Inspect console / service-worker errors during normal operation | Errors are actionable and do not dump sensitive page contents or credentials |
| BCE-SEC-003 | Remove or revoke site permission while a job is queued | The job cannot bypass the browser permission boundary |
| BCE-SEC-004 | Trigger a content-script disconnect | Job enters a safe error/review state; no blind retry |
| BCE-SEC-005 | Verify Teams reader with OpenAI API key absent | Local reader continues its supported behavior; monitored Teams messages are not silently sent to a remote model |

## Exit criteria

The browser smoke suite is complete only when:

1. Every P0 safety case (BCE-BR-001–005, BCE-CHAT-002–006, BCE-CHAT-011–020, BCE-TEAMS-004/006/007/008 and BCE-SEC-001–005) is Pass or has a documented, owner-accepted blocker.
2. No prompt is ever sent to a different conversation than the one selected.
3. No uncertain send is automatically retried.
4. Same-conversation serialization and the three-conversation concurrency ceiling are observed in Chrome.
5. Stop / pause behavior and worker-restart recovery are observed in Chrome.
6. Test evidence is redacted and tied to the exact tested commit SHA.

Do not mark the browser integration complete on the basis of unit tests alone. Re-run this matrix after changes to the manifest, service worker, prompt scheduler, ChatGPT content script, storage schema or permission model.
