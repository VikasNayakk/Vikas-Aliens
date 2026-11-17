import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../chatgpt-content.js", import.meta.url), "utf8");
const conversationId = "abcdefgh12345678";
const pageUrl = "https://chatgpt.com/c/" + conversationId;

function bootContentScript({ stopVisible = false } = {}) {
  let listener = null;
  const stopControl = { getClientRects: () => [{}] };
  const document = {
    title: "ChatGPT",
    documentElement: {},
    querySelectorAll(selector) {
      return stopVisible && selector.toLowerCase().includes("stop") ? [stopControl] : [];
    }
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(callback) { listener = callback; }
      },
      sendMessage(_message, callback) { callback?.(); }
    }
  };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  const window = {};
  vm.runInNewContext(source, {
    window,
    document,
    location: { hostname: "chatgpt.com", pathname: "/c/" + conversationId, href: pageUrl },
    chrome,
    MutationObserver: FakeMutationObserver,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {}
  });
  assert.equal(typeof listener, "function");
  return { listener, pageUrl };
}

function sendContentMessage(adapter, message) {
  return new Promise(resolve => {
    const handled = adapter.listener(
      message,
      { tab: { id: 17, url: adapter.pageUrl }, frameId: 0, url: adapter.pageUrl },
      resolve
    );
    assert.equal(handled, true);
  });
}

test("refuses to send while ChatGPT exposes an active generation control", async () => {
  const adapter = bootContentScript({ stopVisible: true });
  const result = await sendContentMessage(adapter, {
    type: "CHATGPT_SEND_PROMPT",
    jobId: "job-a",
    token: "token-a",
    conversationId,
    prompt: "Do not send while the previous response is running."
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /already generating/i);
});

test("refuses a new job while another job has a response monitor for the same conversation", async () => {
  const adapter = bootContentScript();
  const monitor = await sendContentMessage(adapter, {
    type: "CHATGPT_START_RESPONSE_MONITOR",
    jobId: "job-a",
    token: "token-a",
    conversationId,
    prompt: "Existing prompt",
    baseline: {
      assistantCount: 0,
      assistantKey: "",
      assistantHash: "",
      assistantLength: 0,
      userCount: 0,
      sentUserCount: 1,
      sentUserKey: "user-turn-1"
    }
  });
  assert.equal(monitor.ok, true);
  const result = await sendContentMessage(adapter, {
    type: "CHATGPT_SEND_PROMPT",
    jobId: "job-b",
    token: "token-b",
    conversationId,
    prompt: "Wait for the earlier response."
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /another prompt is active/i);
});
