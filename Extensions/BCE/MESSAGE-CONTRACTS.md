# BCE Runtime Message Contracts

**Scope:** Active Manifest V3 runtime only
**Working branch:** `Chatgpt`
**Last reviewed:** 2026-11-17

This document records the current message boundary between the toolbar popup, the service worker and the Teams content script. Treat message names and fields as public internal contracts: change them only with caller tracing, compatibility handling and tests.

## Active runtime topology

```text
popup.js  ⇄  service.js  ⇄  teams-content.js
              │
              └── chrome.storage.local (persistent extension state)
```

The active manifest entry points are:
- Toolbar popup: `popup.html` + `popup.js`
- Service worker: `service.js`
- Teams content script: `teams-content.js`

`sidepanel.html`, `ui.js` and `background.js` are not registered in the current manifest runtime. Their old message paths are not part of this active contract.

## 1. Popup → Service worker

| Message type | Request fields | Response |
|---|---|---|
| `GET_TEAMS_LIVE_STATUS` | None | Live-state snapshot |
| `SET_TEAMS_LIVE` | `enabled: boolean` | Live-state snapshot |
| `ADD_CURRENT_TEAMS_GROUP` | None; active tab must be a Teams tab | `{ ok, group, baselineCount, state }` or `{ ok:false, error }` |
| `REMOVE_TEAMS_GROUP` | `groupKey: string` | Live-state snapshot |
| `REORDER_TEAMS_GROUPS` | `order: string[]` | Live-state snapshot |
| `READ_LAST_FIVE_TEAMS_MESSAGES` | `groupKey: string` | Live-state snapshot or `{ error }` |

### Live-state snapshot

Current fields returned by `GET_TEAMS_LIVE_STATUS` and broadcast through `TEAMS_LIVE_STATE_UPDATED`:

| Field | Type | Meaning |
|---|---|---|
| `teamsLiveEnabled` | boolean | Teams live reader switch |
| `teamsTabCount` | number | Open Teams tabs |
| `teamsMonitorCount` | number | Legacy-compatible alias of open Teams tab count; not a count of verified selected-group monitors |
| `teamsMonitorMissing` | string[] | Reserved legacy field; currently empty |
| `teamsGroupCount` | number | Number of selected groups |
| `teamsSelectedGroups` | object[] | Selected groups and saved ordering |
| `teamsReadCount` | number | Count of accepted/detected new messages; it does not guarantee speech playback completed |
| `teamsRecentEvents` | object[] | Up to eight recent accepted messages |
| `teamsQueueCount` | number | Messages waiting in queued batches plus the current batch's uncompleted messages |
| `teamsLastStatus` | string | Latest human-readable status |
| `teamsPopupTheme` | string | `light` or `dark` |

Do not use `teamsMonitorCount` as evidence that each selected Teams group has a dedicated monitor tab. The popup label now says “Teams tabs open”.

## 2. Service worker → Teams content script

| Message type | Request fields | Expected response |
|---|---|---|
| `TEAMS_GET_GROUP_INFO_V17` | None; send to the active Teams tab, main frame | `{ ok, groupName, groupKey, chatId, baselineCount, error? }` |
| `TEAMS_READ_LAST_FIVE_V16` | `groupKey: string` | `{ ok, groupName, messages }` or `{ ok:false, error }` |
| `TEAMS_PLAY_AUDIO` | `audioRef?: string, audioUrl?: string, playbackId: string` | `{ ok:true, started:true }` or `{ ok:false, error }` |
| `TEAMS_STOP_AUDIO` | None | `{ ok:true }` |

The active group-registration path requires `chatId` to be a stable Teams conversation ID beginning with `19:`. BCE will not create or merge a newly selected group using only its display name. When Teams does not expose the ID, the UI error asks the owner to open a message's **More options → Copy link** and retry. Existing display-name-only saved groups are not automatically migrated because a tab ID cannot prove the tab still points to the original chat; remove and re-add those groups once.

A message item returned by `TEAMS_READ_LAST_FIVE_V16` may contain:

- `key`: stable DOM message key when available
- `sender`: sender display name
- `text`: extracted and redacted message text
- `timestamp`: visible Teams timestamp
- `own`: whether the message belongs to the signed-in user
- `replyTo`, `replyToMessageId`, `isReply`: quote/reply metadata
- `audioRef` or `audioUrl`: audio source information when exposed by the page

The service worker must still validate returned values before persisting or using them.

## 3. Teams content script → Service worker

### `TEAMS_LIVE_MESSAGE`

Required routing context:
- Message originates from an injected Teams content script.
- `sender.tab.id` must be an integer.
- `sender.url` or `sender.tab.url` must match an allowed Teams host.
- `groupKey` must match a currently selected group.

Payload fields:
- `groupName: string`
- `groupKey: string`
- `sender: string`
- `text: string` (may be empty only when audio source data is supplied)
- `timestamp: string | number`
- `messageTimestamp: string`
- `messageId: string` (preferred stable de-duplication key)
- `replyTo?: string`
- `replyToMessageId?: string`
- `isReply?: boolean`
- `audioRef?: string`
- `audioUrl?: string`

The service worker validates the payload through `message-contracts.mjs` before doing any queue work. The validator:
- requires a string sender and a normalized group key;
- rejects non-string or oversized text / routing fields (message text is limited to 50,000 characters);
- accepts only HTTPS audio URLs or blob URLs with an HTTPS origin;
- restricts audio references to a safe alphanumeric / underscore / hyphen format;
- requires message text or a valid audio source.

The service worker also checks that the originating tab URL is exactly an allowed Teams host and verifies the group is currently selected. Audio completion and status events are subject to the same Teams-tab origin check. Invalid messages are ignored and are not persisted.

### `TEAMS_LIVE_STATUS`

Payload:
- `running?: boolean`
- `text: string` (limited to 500 characters)

The message is accepted only from a verified Teams tab. It updates the service-worker status string and is informational only; it must not be treated as an execution acknowledgement.

### `TEAMS_AUDIO_ENDED` / `TEAMS_AUDIO_FAILED`

Payload:
- `playbackId: string`
- `error?: string` (for failed playback)

The sender must be a verified Teams tab, and `playbackId` must be a string of at most 128 characters matching the currently active persisted audio item. Stale completion events must be ignored.

## 4. Service worker → Popup

### `TEAMS_LIVE_STATE_UPDATED`

Payload:
- `state: LiveStateSnapshot`

The popup listens for this broadcast and re-renders its groups, counters and status.

## 5. Persistent storage keys used by the active Teams pipeline

| Key | Purpose |
|---|---|
| `teamsLiveEnabled` | Live reader enabled flag |
| `teamsSelectedGroups` | Selected group records and ordering |
| `teamsReadCount` | Accepted/detected message count |
| `teamsRecentEvents` | Recent message activity |
| `teamsSpeechQueue` | Pending speech batches |
| `teamsSpeechCurrent` | Current batch, phase and message index |
| `teamsProcessedMessageIds` | Persisted de-duplication keys |
| `teamsLastStatus` | Last status text |
| `teamsPopupTheme` | Popup theme preference |

The speech queue phase values currently used are `group`, `gap`, `message` and `audio`. The current batch also stores `messageIndex`, `sequence` and `playbackId` where relevant.

## 6. ChatGPT prompt scheduler message contracts

### Extension UI → Service worker

| Message type | Request fields | Response |
|---|---|---|
| `GET_CHATGPT_CONVERSATIONS` | None | `{ ok, conversations[] }`; one row per unique conversation ID |
| `GET_CHATGPT_PROMPT_JOBS` | None | `{ ok, jobs[] }`; each job includes up to 100 most recent per-attempt history records |
| `CREATE_CHATGPT_PROMPT_JOB` | `tabId: number, prompt: string, repeatLimit: positive integer or null, repeatIntervalSeconds?: 0 or 30–86,400` | `{ ok, job, state }` |
| `PAUSE_CHATGPT_PROMPT_JOB` | `jobId: string` | `{ ok, job, state }` |
| `STOP_CHATGPT_PROMPT_JOB` | `jobId: string` | `{ ok, job, state }` |
| `RESUME_CHATGPT_PROMPT_JOB` | `jobId: string` | `{ ok, job, state }` |
| `RESOLVE_CHATGPT_PROMPT_JOB` | `jobId: string, decision: string` | `{ ok, job, state }` |

A repeat limit of `null` means unlimited until the owner stops the job. A finite job completes only after the configured number of assistant responses has been accepted by the completion monitor. `repeatIntervalSeconds` defaults to `0` (immediate); otherwise it must be between 30 seconds and 24 hours. The interval begins after confirmed response completion, not after sending. Its absolute due timestamp is persisted and scheduled through Chrome alarms, so service-worker suspension does not depend on an in-memory timer. A job in `waiting_interval` keeps its conversation lock but does not consume one of the three active dispatch slots. Pausing preserves the remaining delay; stopping and Cancel All clear the scheduled run.

### Prompt template operations

The Prompt Manager calls these service-worker APIs:
| Message type | Request fields | Response |
|---|---|---|
| `GET_CHATGPT_PROMPT_TEMPLATES` | None | `{ ok, templates[] }` |
| `SAVE_CHATGPT_PROMPT_TEMPLATE` | `id?: string, name: string, content: string, enabled?: boolean` | `{ ok, template }` |
| `SET_CHATGPT_PROMPT_TEMPLATE_ENABLED` | `id: string, enabled: boolean` | `{ ok, template }` |
| `DELETE_CHATGPT_PROMPT_TEMPLATE` | `id: string` | `{ ok, id }` |

Templates are stored locally under `chatgptPromptTemplates`. The template model limits the library to 100 entries, names to 80 characters and prompt content to 50,000 characters. Names are unique case-insensitively. Variables use `{{variable_name}}`, with a letter first and up to 40 alphanumeric / underscore characters. Missing values block insertion. Disabled templates remain saved but cannot be applied. Template values are inserted as plain text into the prompt editor; the extension does not interpret them as HTML or code.

### Service worker → ChatGPT content script

| Message type | Request fields | Response |
|---|---|---|
| `CHATGPT_GET_CONVERSATION_INFO` | None | `{ ok, conversationId, title, url, composerAvailable, sendAvailable, generating, assistantMessageCount }` |
| `CHATGPT_SEND_PROMPT` | `jobId, token, conversationId, prompt` | `{ ok, baseline }`, or an explicit failure / uncertain result |
| `CHATGPT_START_RESPONSE_MONITOR` | `jobId, token, conversationId, baseline, prompt` | `{ ok, monitoring }` |
| `CHATGPT_STOP_RESPONSE_MONITOR` | `jobId` | `{ ok:true }` |

### ChatGPT content script → Service worker

- `CHATGPT_TAB_READY`: `conversationId, title, url, composerAvailable, sendAvailable`. Accepted only from a top-level allowed ChatGPT tab, with the conversation ID checked against the sender URL.
- `CHATGPT_RESPONSE_COMPLETED`: `jobId, token, conversationId, completedAt, responseLength`. Accepted only when tab ID, conversation ID, token and active job state all match.
- `CHATGPT_RESPONSE_UNCERTAIN`: `jobId, token, conversationId, reason`. Moves the matching active response to manual review; it does not trigger an automatic resend.

Each job retains a maximum of 100 recent attempt records with a monotonic attempt number, start / send-confirmation / completion timestamps, outcome, duration and bounded error / manual-review details. Attempt history excludes prompt text, assistant response text and page contents. The response baseline stores message counts, DOM keys, fingerprints and lengths—not the assistant's full response text. The content script determines generation completion from observed page controls and a stable new assistant message. This is a DOM heuristic, not a server-confirmed completion event.

### Prompt job storage

`chatgptPromptJobs` stores the prompt text, conversation / tab identity, finite or unlimited repeat limit, repeat interval, persisted next-run timestamp / paused remaining delay, sent and completed counters, current send token, response baseline, pause / stop flags, status, timestamps and bounded error details. Data remains in Chrome extension local storage and is not encrypted by BCE.

`chatgptPromptTemplates` stores the reusable template records, including ID, name, source content, extracted variable names, enabled state and creation / update timestamps. It is local extension storage and is not encrypted by BCE.

## 7. Existing but inactive / legacy message paths

These paths are not part of the active popup workflow:

- `OPEN_SIDE_PANEL`: the handler remains in `background.js`, which is not the manifest service worker.
- The old `ui.js` Teams reader contains a separate page-level monitoring implementation and must not run alongside the active `service.js` + `teams-content.js` pipeline.
- The former `TEAMS_GET_CHAT_INFO_V16` message and dedicated monitor-tab creation / restoration helpers have been removed. Legacy `monitorTabId` values are only checked to close stale tabs during migration or group removal; BCE no longer creates dedicated Teams monitor tabs.

Before reconnecting any legacy UI, first choose one authoritative Teams message pipeline and migrate its state deliberately. Do not activate both pipelines in parallel.

## 8. Change policy

1. Keep message type strings stable unless migration is explicit.
2. Validate sender, type, required fields and payload size at the service-worker boundary.
3. Treat content-script DOM values as untrusted input.
4. Include source tab/frame context where the operation depends on a particular page.
5. Ignore stale IDs, stale playback IDs and messages from unselected groups.
6. Add or update tests whenever a contract is changed.
