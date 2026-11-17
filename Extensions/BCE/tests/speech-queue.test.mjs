import test from "node:test";
import assert from "node:assert/strict";
import {
  appendUniqueMessages,
  countPendingSpeechMessages,
  normalizeSpeechBatch,
  speechMessageKey
} from "../speech-queue.mjs";

test("normalizes a legacy single-message batch", () => {
  const batch=normalizeSpeechBatch({
    groupKey:"operations",
    groupName:"Operations",
    sender:"V.N.",
    text:"Please update the tracker",
    messageId:"teams-101",
    sourceTabId:12
  });

  assert.equal(batch.groupKey,"operations");
  assert.equal(batch.messages.length,1);
  assert.equal(batch.messages[0].sender,"V.N.");
  assert.equal(batch.messages[0].messageId,"teams-101");
  assert.equal(batch.messages[0].sourceTabId,12);
  assert.equal(batch.phase,"group");
});

test("normalizes multi-message batches and preserves playback progress", () => {
  const batch=normalizeSpeechBatch({
    groupKey:"support",
    groupName:"Support",
    messages:[
      {sender:"A",text:"First",key:"m1"},
      {sender:"B",text:"Second",key:"m2"}
    ],
    messageIndex:1,
    phase:"audio",
    playbackId:"run-1"
  });

  assert.equal(batch.messages.length,2);
  assert.equal(batch.messages[1].messageId,"m2");
  assert.equal(batch.messageIndex,1);
  assert.equal(batch.phase,"audio");
  assert.equal(batch.playbackId,"run-1");
});

test("de-duplicates by stable message ID without dropping equal text with different IDs", () => {
  const batch={messages:[
    {sender:"A",text:"OK",messageId:"m1"}
  ]};

  const appended=appendUniqueMessages(batch,[
    {sender:"A",text:"OK",messageId:"m1"},
    {sender:"A",text:"OK",messageId:"m2"}
  ]);

  assert.equal(appended,2);
  assert.deepEqual(batch.messages.map(speechMessageKey),["m1","m2"]);
});

test("counts queued messages plus the uncompleted part of the active batch", () => {
  const queue=[
    {messages:[{messageId:"q1"},{messageId:"q2"}]},
    {sender:"legacy",text:"one legacy item"}
  ];
  const current={messages:[{messageId:"c1"},{messageId:"c2"},{messageId:"c3"}],messageIndex:1};

  assert.equal(countPendingSpeechMessages(queue,current),4);
  assert.equal(countPendingSpeechMessages([],null),0);
});

test("does not return negative pending counts for an out-of-range message index", () => {
  const current={messages:[{messageId:"c1"}],messageIndex:99};
  assert.equal(countPendingSpeechMessages([],current),0);
});
