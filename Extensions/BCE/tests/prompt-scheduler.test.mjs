import test from "node:test";
import assert from "node:assert/strict";
import {
  beginPromptSend,
  completePromptResponse,
  confirmPromptSent,
  createPromptJob,
  markPromptDispatchUncertain,
  requestPromptPause,
  requestPromptStop,
  resolveUncertainPromptJob,
  resumePromptJob,
  selectDispatchablePromptJobs
} from "../prompt-scheduler.mjs";

const makeJob=(overrides={},now=1000)=>createPromptJob({
  id:"job-a",
  conversationId:"conversation-a",
  tabId:10,
  prompt:"Continue the approved task.",
  repeatLimit:3,
  ...overrides
},now);

test("creates finite and unlimited prompt jobs with independent progress counters", () => {
  const finite=makeJob();
  const unlimited=makeJob({id:"job-b",repeatLimit:null});

  assert.equal(finite.status,"queued");
  assert.equal(finite.repeatLimit,3);
  assert.equal(finite.completedCount,0);
  assert.equal(finite.sentCount,0);
  assert.equal(unlimited.repeatLimit,null);
});

test("rejects empty prompt, missing conversation and invalid repeat limits", () => {
  assert.throws(()=>makeJob({prompt:"   "}),/Prompt must contain/i);
  assert.throws(()=>makeJob({conversationId:""}),/conversation ID/i);
  assert.throws(()=>makeJob({repeatLimit:0}),/positive integer/i);
  assert.throws(()=>makeJob({repeatLimit:1.5}),/positive integer/i);
});

test("selects queued jobs from separate conversations up to concurrency limit", () => {
  const jobs=[
    makeJob({id:"a",conversationId:"one"},40),
    makeJob({id:"b",conversationId:"two"},10),
    makeJob({id:"c",conversationId:"three"},30),
    makeJob({id:"d",conversationId:"four"},20)
  ];

  assert.deepEqual(selectDispatchablePromptJobs(jobs,2),["a","b"]);
});

test("does not select two jobs for the same conversation in one dispatch cycle", () => {
  const jobs=[
    makeJob({id:"a",conversationId:"one"},20),
    makeJob({id:"b",conversationId:"one"},10),
    makeJob({id:"c",conversationId:"two"},30)
  ];

  assert.deepEqual(selectDispatchablePromptJobs(jobs,3),["a","c"]);
});

test("an active or uncertain job locks its conversation but not other conversations", () => {
  const jobs=[
    {...makeJob({id:"a",conversationId:"one"}),status:"awaiting_response"},
    makeJob({id:"b",conversationId:"one"}),
    {...makeJob({id:"c",conversationId:"two"}),status:"needs_review"}
  ];

  assert.deepEqual(selectDispatchablePromptJobs(jobs,3),[]);
  assert.deepEqual(selectDispatchablePromptJobs([
    jobs[0],jobs[1],makeJob({id:"d",conversationId:"three"})
  ],3),["d"]);
});

test("begins one send and refuses a second active send for the same conversation", () => {
  const jobs=[
    makeJob({id:"a",conversationId:"one"}),
    makeJob({id:"b",conversationId:"one"})
  ];
  const started=beginPromptSend(jobs,"a","send-token-1",1100);
  assert.equal(started.ok,true);
  assert.equal(started.job.status,"sending");

  const blocked=beginPromptSend(started.jobs,"b","send-token-2",1101);
  assert.equal(blocked.ok,false);
  assert.match(blocked.error,/already has an active prompt job/i);
});

test("requires a matching send acknowledgement before response waiting begins", () => {
  const started=beginPromptSend([makeJob()],"job-a","token-a",1100);
  const stale=confirmPromptSent(started.jobs,"job-a","wrong-token",1200);
  assert.equal(stale.ok,false);

  const accepted=confirmPromptSent(started.jobs,"job-a","token-a",1200);
  assert.equal(accepted.ok,true);
  assert.equal(accepted.job.status,"awaiting_response");
  assert.equal(accepted.job.sentCount,1);
});

test("finite jobs complete only after the configured number of assistant responses", () => {
  let jobs=[makeJob({repeatLimit:2})];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  const first=completePromptResponse(jobs,"job-a","t1",1300);
  assert.equal(first.job.completedCount,1);
  assert.equal(first.job.status,"queued");

  jobs=beginPromptSend(first.jobs,"job-a","t2",1400).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t2",1500).jobs;
  const second=completePromptResponse(jobs,"job-a","t2",1600);
  assert.equal(second.job.completedCount,2);
  assert.equal(second.job.status,"completed");
});

test("unlimited jobs keep queuing after each confirmed assistant completion", () => {
  let jobs=[makeJob({repeatLimit:null})];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  const done=completePromptResponse(jobs,"job-a","t1",1300);

  assert.equal(done.job.completedCount,1);
  assert.equal(done.job.status,"queued");
  assert.equal(done.job.repeatLimit,null);
});

test("a completion event with a stale token cannot unlock or advance the job", () => {
  let jobs=[makeJob()];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  const stale=completePromptResponse(jobs,"job-a","old-token",1300);

  assert.equal(stale.ok,false);
  assert.equal(jobs[0].status,"awaiting_response");
  assert.equal(jobs[0].completedCount,0);
});

test("stop during generation prevents the next repeat but lets the current response finish", () => {
  let jobs=[makeJob({repeatLimit:null})];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  jobs=requestPromptStop(jobs,"job-a",1250).jobs;
  assert.equal(jobs[0].status,"awaiting_response");
  assert.equal(jobs[0].stopRequested,true);

  const done=completePromptResponse(jobs,"job-a","t1",1300);
  assert.equal(done.job.status,"stopped");
  assert.equal(done.job.completedCount,1);
});

test("pause and resume preserve progress while keeping the current conversation locked", () => {
  let jobs=[makeJob()];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  jobs=requestPromptPause(jobs,"job-a",1250).jobs;
  assert.equal(jobs[0].status,"awaiting_response");
  assert.equal(jobs[0].pauseRequested,true);

  const done=completePromptResponse(jobs,"job-a","t1",1300);
  assert.equal(done.job.status,"paused");
  assert.equal(done.job.completedCount,1);

  const resumed=resumePromptJob(done.jobs,"job-a",1400);
  assert.equal(resumed.job.status,"queued");
  assert.equal(resumed.job.completedCount,1);
});

test("uncertain send outcomes lock the conversation until explicitly resolved", () => {
  let jobs=[makeJob({id:"a",conversationId:"one"}),makeJob({id:"b",conversationId:"one"})];
  jobs=beginPromptSend(jobs,"a","t1",1100).jobs;
  jobs=markPromptDispatchUncertain(jobs,"a","t1","Could not verify whether ChatGPT accepted the send.",1200).jobs;
  assert.equal(jobs[0].status,"needs_review");
  assert.deepEqual(selectDispatchablePromptJobs(jobs,3),[]);

  const resolved=resolveUncertainPromptJob(jobs,"a","confirm_not_sent",1300);
  assert.equal(resolved.job.status,"queued");
  assert.equal(resolved.job.currentToken,null);
  assert.deepEqual(selectDispatchablePromptJobs(resolved.jobs,3),["a"]);
});
