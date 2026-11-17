# Voice Speakers — Aliens (BCE foundation)

Existing Chrome Manifest V3 extension being upgraded incrementally into the Aliens Browser Control Extension. The active **1.6.3** runtime currently provides selected Microsoft Teams group monitoring, message de-duplication, speech queueing and supported audio playback. It is not yet a general workflow automation engine.

## Current workflow

### Microsoft Teams group reader
1. Open a Teams group in its own browser tab and click the Voice Speakers toolbar icon.
2. Click **Add currently open Teams group**. BCE reads the group name and stable Teams conversation ID. If the ID is unavailable, open a message in that chat, choose **More options → Copy link**, then retry.
3. When prompted, choose **Yes, read last 5** or **No, only new**.
4. Add other selected groups from their normal Teams chats.
5. Move groups up or down to set priority.
6. Turn **Live message reading** ON.
7. When several messages from one group arrive together, the group name is announced once, followed by a five-second pause and then each message in order at a steady pace.
8. Repeated message/card IDs are stored and ignored. Emoji and standalone date/time lines are removed. Reply quote blocks are excluded when Teams exposes them; a reply is spoken as the original sender's name followed by the replier and the reply text.
9. Audio elements and direct audio-file links found inside a visible Teams message are played; speech waits until playback ends. The extension does not narrate the audio itself.
10. Turn OFF to stop monitoring, speech, and extension-started audio playback.

**Audio limitation:** Teams must expose an audio player element or a direct audio-file link in the visible message/notification DOM. A notification that only says an audio file was sent, without exposing its media source, cannot be played from another unopened chat in this browser-only mode.

This browser-only mode watches Teams in-app notification cards in an open Teams tab and matches each notification's group name against your selected groups. It does not use Microsoft Graph, Entra app registration, Power Automate, or separate hidden monitor tabs. Keep at least one Teams web tab open. In Teams, enable message previews in notifications and make sure chat notifications are shown as banners. Existing notification cards are ignored when monitoring first starts; new cards are processed after that. If Teams does not create an in-app notification card for a chat, the extension cannot read that message in this mode. The one-time last-five option reads from the currently open chat when you add it.

### ChatGPT prompt scheduler

1. Open the ChatGPT conversations you want to target in separate browser tabs. Each conversation must have a visible prompt composer and an enabled Send control.
2. Click the BCE toolbar icon and choose **Open ChatGPT Prompt Scheduler**.
3. Enter the prompt, select one or more available conversations, and choose a finite repeat count or **Unlimited**.
4. Click **Create prompt jobs**. BCE creates one independent job per selected conversation.
5. BCE can dispatch up to three different conversations concurrently. Within one conversation, only one prompt job can send at a time; the next repeat waits for the current assistant response to be considered complete.
6. Use **Pause after response** or **Stop after response** for an active job. Queued jobs can be paused or stopped immediately.
7. If the send or response state is uncertain, the job enters **Needs review**. Check the ChatGPT conversation and explicitly resolve it. BCE does not automatically resend an uncertain prompt.

**Current limitation:** the ChatGPT adapter uses page DOM controls and generation indicators. It requires a matching new user-message echo after sending, then waits for a new assistant message to remain stable after visible generation indicators disappear. This is a conservative browser-DOM heuristic, not a server-confirmed completion event. Live Chrome / ChatGPT UI smoke testing is still pending. Saved prompt templates, repeat intervals, Thinking-mode selection and automated login / rate-limit recovery are not implemented yet.

## Install locally
1. Download or clone this repository.
2. Open chrome://extensions and enable Developer mode.
3. Choose **Load unpacked** and select the `Extensions/BCE` folder.
4. Open Microsoft Teams and click the extension icon.

## Current implementation boundaries
- The active manifest uses `popup.html` / `popup.js` as the toolbar UI, `service.js` as the service worker, `teams-content.js` as the Teams content script and `chatgpt-content.js` as the controlled ChatGPT page adapter. The toolbar popup opens `prompt-manager.html` for ChatGPT job creation and control.
- `sidepanel.html`, `ui.js` and `background.js` are legacy, unregistered files. Their old Teams reader and read-only ChatGPT parser are not active. Do not load that old side panel alongside the active Teams reader.
- ChatGPT prompt sending and finite / unlimited repeated jobs are implemented as an initial extension feature; live web-page behavior is pending manual browser smoke testing. General workflow execution, Teams task approvals and Microsoft application adapters are not implemented yet.
- The optional OpenAI analysis handler remains in the source, but the active Teams live reader does not automatically send monitored messages to OpenAI.
- Chrome speech voices and available audio codecs depend on the browser and operating system.

## Development checks

No npm package installation is required. Use Node.js 22 or later.

From this folder, run:

```bash
npm run check
```

This validates JavaScript / ES-module syntax, the Manifest V3 declaration, local files referenced by the manifest and active HTML pages, and the BCE unit tests.

To run only the unit tests:

```bash
npm test
```

GitHub Actions runs the same `npm run check` command for changes to the BCE extension.
