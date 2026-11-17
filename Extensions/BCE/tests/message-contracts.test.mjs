import test from "node:test";
import assert from "node:assert/strict";
import { createMessageFingerprint, isTeamsContentSender, normalizeTeamsLiveMessage } from "../message-contracts.mjs";

test("accepts a valid Teams text message and normalizes its group key", () => {
  const message=normalizeTeamsLiveMessage({
    groupName:"Operations",
    groupKey:"  OPERATIONS  ",
    sender:" V.N. ",
    text:" Update the weekly sheet ",
    timestamp:1763373000000,
    messageTimestamp:"3:20 PM",
    messageId:"teams-message-1",
    isReply:false
  });

  assert.ok(message);
  assert.equal(message.groupKey,"operations");
  assert.equal(message.sender,"V.N.");
  assert.equal(message.text,"Update the weekly sheet");
  assert.equal(message.messageId,"teams-message-1");
});

test("accepts HTTPS and Teams-origin blob audio URLs", () => {
  const httpsMessage=normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",audioUrl:"https://cdn.example.com/voice.ogg"
  });
  const blobMessage=normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",audioUrl:"blob:https://teams.microsoft.com/voice-id"
  });

  assert.ok(httpsMessage);
  assert.ok(blobMessage);
});

test("rejects missing routing identity and empty messages", () => {
  assert.equal(normalizeTeamsLiveMessage({sender:"A",text:"hello"}),null);
  assert.equal(normalizeTeamsLiveMessage({groupKey:"operations",text:"hello"}),null);
  assert.equal(normalizeTeamsLiveMessage({groupKey:"operations",sender:"A",text:"  "}),null);
  assert.equal(normalizeTeamsLiveMessage(null),null);
});

test("rejects unsafe audio URL protocols and malformed audio references", () => {
  assert.equal(normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",audioUrl:"javascript:alert(1)"
  }),null);
  assert.equal(normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",audioUrl:"http://example.com/voice.ogg"
  }),null);
  assert.equal(normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",audioRef:"unsafe/ref"
  }),null);
});

test("rejects non-string and oversized message fields", () => {
  assert.equal(normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",text:42
  }),null);
  assert.equal(normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",text:"x".repeat(50001)
  }),null);
  assert.equal(normalizeTeamsLiveMessage({
    groupKey:"operations",sender:"A",audioUrl:"https://example.com/"+"x".repeat(2100)
  }),null);
});

test("accepts only verified Teams content-script senders", () => {
  assert.equal(isTeamsContentSender({
    tab:{id:42,url:"https://teams.microsoft.com/v2/"}
  }),true);
  assert.equal(isTeamsContentSender({
    tab:{id:43},
    url:"https://teams.cloud.microsoft/"
  }),true);
  assert.equal(isTeamsContentSender({
    url:"https://teams.microsoft.com/"
  }),false);
  assert.equal(isTeamsContentSender({
    tab:{id:44,url:"https://teams.microsoft.com.evil.example/"}
  }),false);
  assert.equal(isTeamsContentSender({
    tab:{id:45,url:"https://example.com/"}
  }),false);
});

test("fingerprints fallback message identity without storing raw message text", async () => {
  const source="V.N.\u001fPlease update the confidential spreadsheet\u001f\u001f\u001f1763373000000";
  const first=await createMessageFingerprint(source);
  const second=await createMessageFingerprint(source);
  const changed=await createMessageFingerprint(source+" ");

  assert.match(first,/^[a-f0-9]{64}$/);
  assert.equal(first,second);
  assert.notEqual(first,changed);
  assert.equal(first.includes("confidential"),false);
});
