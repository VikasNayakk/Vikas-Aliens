# BCE — Browser Control Extension
## Architecture Audit & Engineering Roadmap

**Repository:** `VikasNayakk/Vikas-Aliens`  
**Working branch:** `Chatgpt`  
**Audited baseline commit:** `90ab495c811e01d068f3996a83feff2d7e23a424`  
**Existing extension version:** `1.6.3`  
**Audit date:** 2026-11-17  
**Status:** Initial static audit and requirements backlog recorded. Extension-only work is in scope in this conversation.

**Conversation scope boundary:** This engineering thread owns BCE extension code only. The AI model, training, reasoning/backend and autonomous AI decision engine are being developed separately and are out of scope here. BCE work may define and implement only the extension-side connector, message contracts, permissions, execution controls and UI needed to connect to that separately developed AI.

---

## 1. Product direction captured from the owner

BCE is intended to become a browser-control and automation orchestrator. It must build on the existing extension instead of replacing it with a fresh project.

1. The owner describes a task in the extension / connected AI.
2. The AI identifies whether the task is a small action the extension can safely perform directly, or a larger task that should be routed to an already-created workflow.
3. Workflows are reusable, pre-built, named and versioned automation procedures for applications such as Excel, Microsoft To Do, OneDrive, OneNote and other software.
4. The extension invokes the selected workflow; the workflow performs the larger operation. The extension should not improvise a sequence of risky clicks when a known workflow exists.
5. BCE must support sending saved prompts repeatedly to selected ChatGPT conversations. The owner can set a finite repeat count or an unlimited run that continues until explicitly stopped.
6. Multiple ChatGPT conversations may run in parallel, but prompts for the **same conversation must be strictly sequential**. BCE must wait until the current assistant response has actually completed before sending the next prompt.
7. The AI may assist with actions that are not yet exposed as direct extension features, but it must not bypass permissions, safety checks or application state verification.
8. BCE monitors only Teams groups selected by the owner. When a new message appears to assign a task to the owner, AI presents the source group, message and proposed action, and waits for the owner's approval before running a workflow.
9. If no suitable workflow exists, AI informs the owner, asks how the task is normally performed, gathers the missing details and prepares a complete workflow-development brief.
10. ChatGPT may be asked to produce a workflow implementation and push it to the designated GitHub branch. BCE may then fetch/pull the new workflow only after integrity checks, compatibility checks and the configured approval policy pass.
11. Large application workflows are deliberately deferred until BCE and its AI control layer are stable.

**Important boundary:** workflow authoring and workflow execution are separate capabilities. A generated workflow must not become trusted executable automation merely because an AI or ChatGPT says it is complete.

---

## 2. Existing repository inventory

The audited `Extensions/BCE` folder currently contains:

| File | Current responsibility |
|---|---|
| `manifest.json` | Chrome Manifest V3 declaration, permissions, popup, service worker and Teams content script |
| `service.js` | Active service worker: Teams group state, message intake/deduplication, persistent speech queue, TTS/audio dispatch, optional OpenAI analysis message handlers |
| `teams-content.js` | Active Teams page script: message DOM extraction, selected-group notifications, incoming-message filtering, quote handling and audio source detection/playback |
| `popup.html`, `popup.js`, `popup.css` | Active toolbar popup for Teams live reading, selected groups, priority, queue and activity |
| `analyzer.js` | Local message parsing, pattern-based secret redaction, optional AI analysis prompt |
| `options.html`, `options.js`, `styles.css` | Options page: API key, model, speech rate and redaction setting |
| `sidepanel.html`, `ui.js` | Older side-panel UI containing a second Teams reader and read-only ChatGPT conversation prompt/reply extraction |
| `background.js` | Older side-panel opening handler |
| `README.md` | Existing Teams reader installation and operating notes |
| `PRIVACY.md` | Current privacy and API-key handling notes |

### Active runtime path

```text
Chrome toolbar action
  └─ popup.html
       └─ popup.js
            └─ chrome.runtime.sendMessage(...)
                 └─ service.js (Manifest V3 service worker)
                      ├─ chrome.storage.local — selected groups / queue / status
                      ├─ chrome.tabs + chrome.scripting — open Teams tabs
                      └─ teams-content.js
                           ├─ visible Teams chat DOM
                           └─ Teams in-app notification cards
                                └─ TEAMS_LIVE_MESSAGE
                                     └─ service.js dedupe + persistent queue
                                          └─ Chrome TTS / visible audio playback
```

The currently active toolbar popup is a Teams reader. The existing ChatGPT extraction code is in the side-panel UI, not in the active popup flow.

---

## 3. Important audit findings

### 3.1 What already exists

- Manifest V3 extension and service worker.
- Teams group selection, removal and priority ordering.
- Teams content script for visible chat messages and in-app notification cards.
- Incoming message filtering in the selected-chat DOM path.
- Reply/quote metadata extraction and suppression of quoted originals.
- Pattern-based masking of common password, OTP and token formats.
- Persistent speech queue with group batching, TTS, optional audio playback and message deduplication.
- Last-five-message option for the currently open selected group.
- Optional OpenAI Chat Completions request handler for message analysis/testing.
- A read-only ChatGPT conversation parser exists in `ui.js` (but is part of an unregistered side-panel page).

### 3.2 Runtime and documentation mismatches

1. `manifest.json` registers `service.js` as the service worker and `popup.html` as the toolbar popup. It does **not** register `background.js` or declare `side_panel.default_path`.
2. `background.js` contains a side-panel open listener, but it is not the active service worker. `sidepanel.html` and `ui.js` are not currently registered through the manifest. Treat this code as legacy/unwired until deliberately integrated.
3. `ui.js` contains its own older Teams monitoring implementation, separate from the active `service.js` + `teams-content.js` pipeline. Maintaining both as if they were one pipeline would create conflicting state and duplicate-message risks.
4. `ui.js` contains read-only ChatGPT prompt/reply extraction and speech playback. It does not send prompts, repeat prompts, wait for assistant completion, or coordinate several conversations.
5. `analyzer.js` and the `ANALYZE_MESSAGES` / `TEST_OPENAI` service-worker handlers exist, but the active popup does not expose an Analyze action. The side-panel page has API settings, but that page is currently unregistered.
6. `README.md` describes the Teams live-reader experience and old side-panel behavior; it is not yet an accurate product-level document for the intended Browser Control Extension.
7. `service.js` contains monitor-tab helper functions (`createOrGetMonitorTab`, `ensureGroupMonitorTabs`, `restoreMonitorTabToSelectedGroup`) that are not part of the active selected-group registration path. Current group registration stores the source tab and group key; live monitoring injects into open Teams tabs and reads notification cards. The unused helper path should be reviewed before reuse.
8. The active group identity is based primarily on normalized display name. Distinct chats with identical display names can collide; a stable Teams conversation identifier should be used where the page exposes it.
9. `teamsMonitorCount` currently reports the number of open Teams tabs, not a verified count of selected-group monitors.
10. The current speech queue is persisted, but service-worker restart recovery needs explicit tests for every queue phase (group announcement, five-second gap, message speech and audio playback). A persisted in-progress item must not become permanently stuck or replay an already completed message.
11. The existing ChatGPT extraction logic relies on ChatGPT page DOM selectors. It is read-only and will require a separate, carefully tested control layer for sending prompts and detecting generation completion.
12. The current permissions cover ChatGPT, OpenAI API and Teams only. Excel, To Do, OneDrive, OneNote, Microsoft Graph and other application scopes are not yet declared or implemented.

### 3.3 What is not implemented yet

- AI task router / capability registry.
- Workflow registry, workflow schema, workflow versioning or workflow runner.
- Direct small-task action catalog.
- Approval inbox and task lifecycle.
- Teams task/assignment classification addressed to the owner.
- Persistent prompt library and ChatGPT send scheduler.
- Per-conversation execution lock and assistant-completion detector.
- Finite / unlimited repeat controls with pause, resume and explicit stop.
- Multiple-conversation scheduling and recovery.
- Workflow discovery, workflow authoring interview, generation brief or generated-workflow validation.
- GitHub workflow publish/fetch/update pipeline.
- Excel, To Do, OneDrive, OneNote or other application workflow adapters.
- End-to-end automated tests for the above.

---

## 4. Target architecture

The system should be split into small, testable modules while retaining the current Manifest V3 extension as the delivery shell.

```text
User / Teams / Scheduled trigger
             │
             ▼
       Task Intake Layer
             │
             ▼
       External AI service
       (separate workstream)
             │ typed task decision
             ▼
       BCE integration bridge
             │
       Capability / Workflow lookup
             │
             ▼
       Workflow Registry
             │
             ▼
       Workflow Executor
                    │
             Permission / Policy Gate
                    │
             Browser + App Adapters
                    │
           Verified execution result
                    │
            Audit log + notification

Separate controlled lanes:
  ChatGPT Prompt Scheduler
  Workflow Authoring / GitHub Sync
  Human Approval Inbox
```

### Responsibilities and boundaries

- **Task Intake:** receives user instructions, Teams messages and approved future triggers. It records source, time, target app and original message reference.
- **External AI service:** the model, reasoning, training and AI decision-making are implemented in a separate workstream. BCE only exchanges typed task/context messages with that service; this conversation does not implement the AI itself.
- **BCE AI Integration Bridge:** sends permitted context to the external AI and validates the structured response before handing a proposal to the extension policy gate. It does not contain model logic.
- **BCE Capability Catalog:** describes the small extension operations that can be invoked by an approved external-AI decision, including required page, typed inputs, permissions, expected result and risk level.
- **Workflow Registry:** stores workflow ID, version, application, input schema, steps reference, permission scope, test status and compatibility requirements.
- **Workflow Executor:** deterministically executes a validated workflow, verifies preconditions/postconditions, applies timeouts/retries where safe, and reports each step.
- **Policy / Approval Gate:** blocks unapproved, destructive, externally visible or high-impact actions.
- **ChatGPT Prompt Scheduler:** independent queue manager with one lock per conversation, completion detection, finite/unlimited repeat state and explicit stop control.
- **BCE Workflow Intake / Validation:** accepts a workflow package produced by the separate AI/authoring workstream, validates its manifest, compatibility, requested permissions and tests, and keeps it inactive until approval.
- **Application Adapters:** isolate Excel, To Do, OneDrive, OneNote and other application-specific DOM/API behavior from the core executor.
- **Audit Log:** records task source, AI decision, workflow/version, approvals, execution steps, result and errors without unnecessarily storing private message content.

---

## 5. Non-negotiable correctness rules

1. **Same-conversation ChatGPT serialization:** never send another prompt to a conversation while its previous assistant response is generating, incomplete or in an unknown state.
2. **Separate-conversation concurrency:** independent conversation queues may run concurrently within a configurable resource limit.
3. **No blind completion detection:** use explicit page state / DOM evidence and timeouts. A timeout is an uncertain state, not proof that the response completed.
4. **Idempotency:** duplicate Teams notifications, service-worker restarts and repeated user events must not silently execute the same task twice.
5. **Finite and unlimited repetition:** finite runs stop at the exact configured count. Unlimited runs stop only through the explicit owner stop action or a configured safety stop.
6. **Pause / resume / stop:** these are distinct states. Stop must cancel future dispatch and safely handle the currently running operation.
7. **Approval before action:** a Teams message is a task candidate, not permission to execute it.
8. **Workflow trust:** a generated workflow remains untrusted until schema validation, static checks, sandbox tests, permission review and the configured approval step pass.
9. **Least privilege:** request app permissions only when a feature requires them; do not ask for broad Microsoft account access by default.
10. **Verified outcomes:** report success only after checking the target application's resulting state. A click or keystroke alone is not success.
11. **Safe recovery:** on a lost tab, extension restart or network failure, recover from persisted state without duplicating non-idempotent actions.
12. **Owner control:** provide a global pause/stop switch, per-task cancellation and a clear execution history.

---

## 6. Engineering backlog

Status meanings: **DONE** = verified from the current static source; **IN PROGRESS** = partially inspected or designed; **PENDING** = not implemented; **BLOCKED** = requires a prerequisite or owner decision.

### Phase 0 — Baseline and requirements capture

- [x] BCE folder and repository structure inspected.
- [x] Manifest V3 entry point and active service-worker path mapped.
- [x] Teams content-script and message-queue path inspected.
- [x] Legacy/unregistered side-panel path identified.
- [x] Current OpenAI analysis path and privacy notes inspected.
- [x] Working branch `Chatgpt` and baseline commit recorded.
- [ ] Load extension in a real Chrome profile and run a baseline smoke test.
- [ ] Capture baseline test cases and known-good behavior before code refactoring.

### Phase 1 — Stabilize the existing BCE foundation

- [ ] Add a reproducible local development/test setup without changing existing user data.
- [x] Add CI validation for JavaScript / ES-module syntax and Manifest V3 referenced files.
- [x] Document active `chrome.runtime` message contracts in `MESSAGE-CONTRACTS.md`.
- [x] Validate Teams message payload types, field sizes, required routing fields and audio URL protocols at the service-worker boundary.
- [ ] Fix group identity to prefer stable Teams conversation IDs; retain safe migration for saved groups.
- [ ] Review and remove or deliberately reconnect obsolete monitor-tab helpers.
- [ ] Decide whether the side panel becomes the primary workspace; wire it intentionally or retire its unreachable code.
- [ ] Consolidate the duplicate Teams reader so only one authoritative pipeline is active.
- [x] Correct popup labels and make the pending counter include the active batch's uncompleted messages. Separate spoken / failed counts remain pending.
- [x] Add persisted speech queue recovery on service-worker wake and serialize concurrent queue hydration.
- [x] Add unit tests for queue normalization, stable-ID de-duplication and pending-message counts.
- [ ] Add browser/integration tests for notification duplicates, virtualized chat history, own messages, replies, audio and tab closure.
- [ ] Update README and privacy documentation to match actual behavior.

### Phase 2 — BCE-side AI integration bridge (AI implementation excluded)

- [ ] Define a provider-agnostic extension-to-AI request/response contract.
- [ ] Implement the BCE-side connector transport to the separately developed AI service; do not implement model logic or training here.
- [ ] Define and validate typed task-decision payloads received from the external AI.
- [ ] Add request IDs, timeouts, cancellation and stale-response protection.
- [ ] Add connection status, retry policy and user-visible AI-service errors.
- [ ] Keep application context, tab identity and permissions bounded to the task being evaluated.
- [ ] Create the BCE capability catalog for extension actions and workflow invocation.
- [ ] Add BCE-side policy checks and owner approval requirements.
- [ ] Add the extension task state machine: received, awaiting-AI, awaiting-input, awaiting-approval, queued, running, succeeded, failed, cancelled.
- [ ] Add execution logs with redaction and user-visible status.
- [ ] Add global pause/stop and per-task cancellation.

### Phase 3 — Workflow platform (no business workflows yet)

- [ ] Design a declarative workflow manifest and versioned workflow ID.
- [ ] Define typed inputs, outputs, variables and reusable step contracts.
- [ ] Define supported step types (navigate, locate, read, enter, click, wait, verify, branch, repeat and report) with strict allowlists.
- [ ] Add preconditions, postconditions, timeouts and bounded retries.
- [ ] Add idempotency keys and recovery checkpoints.
- [ ] Add workflow permission scopes and risk classification.
- [ ] Build workflow registry discovery and compatibility checks.
- [ ] Build deterministic workflow executor and step-level telemetry.
- [ ] Build a workflow dry-run / simulation mode.
- [ ] Add workflow version pinning and rollback.
- [ ] Keep application-specific details in adapters, not in the AI router.

### Phase 4 — ChatGPT prompt automation (mandatory core capability)

- [ ] Add saved prompt templates with names, variables and enabled/disabled state.
- [ ] Allow each prompt job to select one or more exact ChatGPT conversations.
- [ ] Add finite repeat count and unlimited-until-stopped modes.
- [ ] Add repeat interval / dispatch policy configuration.
- [ ] Persist job state, next prompt index and conversation identity.
- [ ] Implement one serial queue and exclusive lock per conversation.
- [ ] Allow independent conversation queues to run concurrently with a configurable limit.
- [ ] Add ChatGPT content-script controls for prompt composer detection and safe send.
- [ ] Add assistant-generation state detection and verify completion before next send.
- [ ] Detect login, network, rate-limit, model-selection and page-error states.
- [ ] Add pause, resume, stop and cancel-all controls.
- [ ] Recover after tab reload or service-worker restart without duplicate prompt sends.
- [ ] Add run history: prompt number, conversation, start/end, completion state and error.
- [ ] Test identical prompts, empty prompts, very long prompts, failed sends and interrupted generations.
- [ ] Add the requested ability to request a ChatGPT UI mode (for example Thinking) only when the current page exposes a verifiable control; otherwise ask the AI/user for a supported path and never pretend it was enabled.

### Phase 5 — Teams task intake and approval inbox (BCE side)

- [ ] Reuse the current selected-group source rather than monitoring every group by default.
- [ ] Preserve original Teams group, sender, timestamp and message reference for every candidate.
- [ ] Package relevant message context for the external AI service; do not implement the AI classifier in this extension workstream.
- [ ] Receive and validate the external AI's task-candidate result and target/owner metadata.
- [ ] Deduplicate the same task across notifications and visible chat DOM.
- [ ] Show the task summary, exact source message and proposed workflow.
- [ ] Ask the owner to approve, reject, defer or request clarification.
- [ ] Run a workflow only after the required approval is recorded.
- [ ] Report completion/failure back to the owner; do not post back into Teams without a separate permission/approval rule.
- [ ] Support task expiry and reassignment/manual ownership correction.

### Phase 6 — BCE workflow intake, GitHub sync and validation

- [ ] Receive a missing-workflow request from the external AI and present the proposed requirements interview to the owner.
- [ ] Capture the owner's procedure, expected result, edge cases and approval boundaries as structured extension data.
- [ ] Send the completed workflow requirements package through the extension-to-AI bridge; workflow prompt/model generation remains in the separate AI workstream.
- [ ] Keep generated code on the designated `Chatgpt` branch and avoid writing to other branches.
- [ ] Fetch the generated commit from the designated branch and verify branch, changed paths and workflow manifest.
- [ ] Run static validation, unit tests and sandbox simulations before trust is granted.
- [ ] Display changed files, permissions and proposed behavior for review.
- [ ] Require the configured approval before activating a newly generated workflow.
- [ ] Add workflow version pinning, rollback and disable controls.
- [ ] Never execute arbitrary code, shell commands or unrestricted scripts supplied by model output.

### Phase 7 — Application adapters (after BCE + AI are stable)

- [ ] Define adapter contract and permission model.
- [ ] Excel adapter: workbook/sheet/table identity, row mapping, validation and post-write verification.
- [ ] Microsoft To Do adapter: list/task identity, due date, assignment and completion verification.
- [ ] OneDrive adapter: file/folder identity, upload/download/move/rename rules and collision handling.
- [ ] OneNote adapter: notebook/section/page identity, content insertion and verification.
- [ ] Add other applications only through isolated, documented adapters.
- [ ] Decide per operation whether to use supported application UI automation or an official API; document the trade-offs and required consent.

### Phase 8 — Quality, security and release

- [ ] Unit tests for router, state machines, queues and workflow contracts.
- [ ] Integration tests with mock application pages and controlled fixtures.
- [ ] End-to-end tests for the BCE ChatGPT page-control and repeat scheduler.
- [ ] End-to-end tests for Teams task → approval → workflow → verified result.
- [ ] Regression tests for the existing Teams reader.
- [ ] Permission/security review and secret-redaction tests.
- [ ] Accessibility and UI state review.
- [ ] Failure-injection tests: closed tab, stale DOM, lost network, browser restart and duplicate events.
- [ ] Version bump, changelog and install/upgrade instructions.
- [ ] Release checklist and known-limitations documentation.

---

## 7. Suggested delivery gates

| Gate | Exit condition |
|---|---|
| G0 — Baseline understood | Existing runtime paths, dead code and known behaviors documented; browser smoke test recorded |
| G1 — Stable foundation | One authoritative Teams pipeline; restart-safe queues; regression tests pass |
| G2 — AI control plane | AI can classify tasks and propose actions, but execution is policy-gated |
| G3 — Workflow engine | Validated sample workflow executes deterministically in a controlled test page |
| G4 — ChatGPT automation | Finite/infinite repeat, multi-conversation concurrency and same-conversation serialization pass tests |
| G5 — Teams approval | Selected-group task is detected, shown to owner and runs only after approval |
| G6 — Workflow authoring | Missing workflow can be specified, generated, validated, reviewed and safely activated |
| G7 — App adapters | Each requested application has verified, tested workflow capabilities |
| G8 — Release-ready | Security, regression, recovery and end-to-end gates pass |

---

## 8. Progress meter and measurement policy

The target product is much larger than the existing Voice Speakers release. Static source inspection, unit tests and real-browser verification are measured separately. No feature is counted as complete solely because its code has been written.

**Current verified baseline (2026-11-17):**

- Existing-source static audit: **100%** for the files listed in Section 2.
- Phase 1 foundation stabilization: **6 of 13 tasks complete (46%)**; 7 tasks remain.
- BCE JavaScript / ES-module syntax validation: **passed** for all 11 `.js` / `.mjs` files in the audited folder.
- BCE unit tests: **10 / 10 passed** (speech queue normalization / recovery helpers and Teams message payload validation).
- Manifest V3 JSON and referenced-file validation: **passed** (4 active references checked).
- Active Teams message boundary validation: **implemented and unit-tested** (required sender/group, bounded payload fields, safe audio URL protocols and audio-reference format).
- Current-commit whitespace validation: **passed**.
- Real Chrome / Teams browser smoke verification: **0%** (not run in this repository review).
- BCE-side external-AI connector bridge: **0% implemented** (AI model, training and reasoning are outside this extension workstream).
- ChatGPT prompt sending and finite / unlimited scheduling: **0% implemented**.
- Teams task intake and approval UI: **0% implemented**.
- Workflow registry and deterministic executor: **0% implemented**.
- Excel / To Do / OneDrive / OneNote adapters: **0% implemented**.

There is no single weighted overall-product percentage yet; the feature groups have different scope and dependencies. The Phase 1 percentage is task-count based and is not a claim that the complete extension is 38% release-ready. A task is complete only when its code and acceptance check pass. Future progress reports must include completed, in-progress, pending and blocked counts plus the tested commit SHA.

---

## 9. Working rules for this project

- Preserve the existing BCE code and extend it incrementally; do not restart from zero.
- All project code changes for this work go only to the `Chatgpt` branch.
- Do not generate the real Excel / To Do / OneDrive / OneNote business workflows until the owner confirms BCE and its external AI integration are ready.
- In this extension workstream, implement only BCE-side integration contracts and browser-extension behavior; do not modify the separate AI model/backend.
- Prefer small commits with a single purpose and verify the changed files after every commit.
- Do not rename or remove existing public message contracts, DOM selectors, CSS classes or IDs without tracing all callers and adding migration/tests.
- Do not claim browser behavior is verified when only static source inspection has been performed.
- When new requirements arrive, update this backlog and its progress meter before changing the architecture.
