import test from "node:test";
import assert from "node:assert/strict";
import {
  beginPromptSend,
  completePromptResponse,
  confirmPromptSent,
  createPromptJob,
  failPromptDispatch,
  markPromptDispatchUncertain,
  markPromptResponseUncertain,
  requestPromptPause,
  requestPromptStop,
  recoverPromptJobsAfterWorkerRestart,
  resolveUncertainPromptJob,
  resumePromptJob,
  selectDispatchablePromptJobs,
  requestStopAllPromptJobs,
  releaseDuePromptJobs
} from "../prompt-scheduler.mjs";

const makeJob=(overrides={},now=1000)=>createPromptJob({
  id:"job-a",
  conversationId:"conversation-a",
  tabId:10,
  prompt:"Continue the approved task.",
  repeatLimit:3,
  ...overrides
},now);

test("stores a response baseline only after matching send acknowledgement", () => {
  const started=beginPromptSend([makeJob()],"job-a","token-a",1100);
  const baseline={
    assistantCount:2,assistantKey:"turn-2",assistantHash:"abc123",assistantLength:48,
    userCount:3,sentUserCount:4,sentUserKey:"turn-4"
  };
  const accepted=confirmPromptSent(started.jobs,"job-a","token-a",1200,baseline);

  assert.equal(accepted.job.status,"awaiting_response");
  assert.deepEqual(accepted.job.responseBaseline,baseline);
});

test("distinguishes uncertain assistant completion from uncertain prompt dispatch", () => {
  let jobs=[makeJob()];
  jobs=beginPromptSend(jobs,"job-a","token-a",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","token-a",1200).jobs;
  const uncertain=markPromptResponseUncertain(jobs,"job-a","token-a","Completion signal was lost.",1300);
  assert.equal(uncertain.job.status,"needs_review");
  assert.equal(uncertain.job.uncertaintyKind,"response");

  const resumed=resolveUncertainPromptJob(uncertain.jobs,"job-a","continue_waiting",1400);
  assert.equal(resumed.job.status,"awaiting_response");
  assert.equal(resumed.job.currentToken,"token-a");
});

test("manual confirmation of a completed response advances exactly one repeat", () => {
  let jobs=[makeJob({repeatLimit:2})];
  jobs=beginPromptSend(jobs,"job-a","token-a",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","token-a",1200).jobs;
  jobs=markPromptResponseUncertain(jobs,"job-a","token-a","Could not verify final state.",1300).jobs;
  const resolved=resolveUncertainPromptJob(jobs,"job-a","confirm_completed",1400);

  assert.equal(resolved.job.completedCount,1);
  assert.equal(resolved.job.status,"queued");
  assert.equal(resolved.job.currentToken,null);
});

test("definitive pre-send failures become terminal without a conversation lock", () => {
  let jobs=[makeJob({id:"a",conversationId:"one"}),makeJob({id:"b",conversationId:"one"})];
  jobs=beginPromptSend(jobs,"a","token-a",1100).jobs;
  const failed=failPromptDispatch(jobs,"a","token-a","Send button was not available.",1200);

  assert.equal(failed.job.status,"failed");
  assert.equal(failed.job.currentToken,null);
  assert.deepEqual(selectDispatchablePromptJobs(failed.jobs,3),["b"]);
});

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

  assert.deepEqual(selectDispatchablePromptJobs(jobs,2),["b","d"]);
});

test("does not select two jobs for the same conversation in one dispatch cycle", () => {
  const jobs=[
    makeJob({id:"a",conversationId:"one"},20),
    makeJob({id:"b",conversationId:"one"},10),
    makeJob({id:"c",conversationId:"two"},30)
  ];

  assert.deepEqual(selectDispatchablePromptJobs(jobs,3),["b","c"]);
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

test("an uncertain dispatch can be stopped directly without retrying the prompt", () => {
  let jobs=[
    makeJob({id:"uncertain",conversationId:"one"}),
    makeJob({id:"next",conversationId:"one"})
  ];
  jobs=beginPromptSend(jobs,"uncertain","token-a",1100).jobs;
  jobs=markPromptDispatchUncertain(jobs,"uncertain","token-a","Send result is uncertain.",1200).jobs;

  const stopped=resolveUncertainPromptJob(jobs,"uncertain","stop_job",1300);
  assert.equal(stopped.ok,true);
  assert.equal(stopped.job.status,"stopped");
  assert.equal(stopped.job.currentToken,null);
  assert.deepEqual(selectDispatchablePromptJobs(stopped.jobs,3),["next"]);
});

test("worker restart moves an in-flight send to review and preserves its conversation lock", () => {
  let jobs=[
    makeJob({id:"sending",conversationId:"one"}),
    makeJob({id:"queued",conversationId:"one"}),
    makeJob({id:"other",conversationId:"two"})
  ];
  jobs=beginPromptSend(jobs,"sending","token-a",1100).jobs;

  const recovered=recoverPromptJobsAfterWorkerRestart(jobs,1200);
  assert.equal(recovered.ok,true);
  assert.deepEqual(recovered.recoveredJobIds,["sending"]);
  assert.equal(recovered.jobs[0].status,"needs_review");
  assert.equal(recovered.jobs[0].currentToken,"token-a");
  assert.deepEqual(selectDispatchablePromptJobs(recovered.jobs,3),["other"]);
});

test("worker restart leaves safely queued and awaiting-response jobs unchanged", () => {
  let jobs=[
    makeJob({id:"queued",conversationId:"one"}),
    makeJob({id:"waiting",conversationId:"two"})
  ];
  jobs=beginPromptSend(jobs,"waiting","token-b",1100).jobs;
  jobs=confirmPromptSent(jobs,"waiting","token-b",1200).jobs;

  const recovered=recoverPromptJobsAfterWorkerRestart(jobs,1300);
  assert.equal(recovered.ok,true);
  assert.deepEqual(recovered.recoveredJobIds,[]);
  assert.equal(recovered.jobs[0].status,"queued");
  assert.equal(recovered.jobs[1].status,"awaiting_response");
  assert.deepEqual(selectDispatchablePromptJobs(recovered.jobs,3),["queued"]);
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

test("counts active conversations against the global concurrency limit", () => {
  const jobs = [
    {...makeJob({id:"active-a",conversationId:"one"}),status:"awaiting_response"},
    {...makeJob({id:"active-b",conversationId:"two"}),status:"needs_review"},
    makeJob({id:"queued-c",conversationId:"three"},30),
    makeJob({id:"queued-d",conversationId:"four"},40)
  ];
  assert.deepEqual(selectDispatchablePromptJobs(jobs,3),["queued-c"]);
});

test("dispatches nothing when active jobs already fill the concurrency limit", () => {
  const jobs = [
    {...makeJob({id:"active-a",conversationId:"one"}),status:"sending"},
    {...makeJob({id:"active-b",conversationId:"two"}),status:"awaiting_response"},
    {...makeJob({id:"active-c",conversationId:"three"}),status:"needs_review"},
    makeJob({id:"queued-d",conversationId:"four"})
  ];
  assert.deepEqual(selectDispatchablePromptJobs(jobs,3),[]);
});

test("counts every active job conservatively when persisted data repeats a conversation", () => {
  const jobs = [
    {...makeJob({id:"active-a",conversationId:"one"}),status:"awaiting_response"},
    {...makeJob({id:"active-b",conversationId:"one"}),status:"needs_review"},
    makeJob({id:"queued-c",conversationId:"two"})
  ];
  assert.deepEqual(selectDispatchablePromptJobs(jobs,2),[]);
});


test("stop-all stops queued jobs and requests safe completion of active jobs", () => {
  let jobs=[
    makeJob({id:"queued",conversationId:"one"}),
    {...makeJob({id:"paused",conversationId:"two"}),status:"paused"},
    {...makeJob({id:"sending",conversationId:"three"}),status:"sending",currentToken:"t1"},
    {...makeJob({id:"waiting",conversationId:"four"}),status:"awaiting_response",currentToken:"t2"},
    {...makeJob({id:"review",conversationId:"five"}),status:"needs_review",currentToken:"t3"},
    {...makeJob({id:"done",conversationId:"six"}),status:"completed"}
  ];

  const result=requestStopAllPromptJobs(jobs,2000);
  assert.equal(result.ok,true);
  assert.deepEqual(result.summary,{queuedStopped:2,activeStopRequested:2,reviewUnchanged:1});
  assert.equal(result.jobs[0].status,"stopped");
  assert.equal(result.jobs[1].status,"stopped");
  assert.equal(result.jobs[2].status,"sending");
  assert.equal(result.jobs[2].stopRequested,true);
  assert.equal(result.jobs[3].status,"awaiting_response");
  assert.equal(result.jobs[3].stopRequested,true);
  assert.equal(result.jobs[4].status,"needs_review");
  assert.equal(result.jobs[4].stopRequested,false);
  assert.equal(result.jobs[5].status,"completed");
});

test("stop-all preserves active conversation locks until current work is resolved", () => {
  const jobs=[
    {...makeJob({id:"active",conversationId:"same"}),status:"awaiting_response",currentToken:"t1"},
    makeJob({id:"queued-next",conversationId:"same"})
  ];
  const stopped=requestStopAllPromptJobs(jobs,2100);
  assert.equal(stopped.jobs[0].stopRequested,true);
  assert.deepEqual(selectDispatchablePromptJobs(stopped.jobs,3),[]);
});

test("stop-all rejects invalid input and timestamps without mutating source jobs", () => {
  const jobs=[makeJob()];
  assert.equal(requestStopAllPromptJobs(null,2000).ok,false);
  assert.equal(requestStopAllPromptJobs(jobs,-1).ok,false);
  assert.equal(jobs[0].status,"queued");
});

test("stores a repeat interval with a zero default and validates supported bounds",()=>{
  assert.equal(makeJob().repeatIntervalSeconds,0);
  assert.equal(makeJob({repeatIntervalSeconds:30}).repeatIntervalSeconds,30);
  assert.equal(makeJob({repeatIntervalSeconds:86400}).repeatIntervalSeconds,86400);
  assert.throws(()=>makeJob({repeatIntervalSeconds:1}),/30–86,400 seconds/i);
  assert.throws(()=>makeJob({repeatIntervalSeconds:29}),/30–86,400 seconds/i);
  assert.throws(()=>makeJob({repeatIntervalSeconds:86401}),/30–86,400 seconds/i);
  assert.throws(()=>makeJob({repeatIntervalSeconds:30.5}),/30–86,400 seconds/i);
});
test("starts the repeat interval only after a confirmed assistant response completes",()=>{
  let jobs=[makeJob({repeatIntervalSeconds:60,repeatLimit:3})];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  const completed=completePromptResponse(jobs,"job-a","t1",5000);
  assert.equal(completed.job.status,"waiting_interval");
  assert.equal(completed.job.nextRunAt,65000);
  assert.equal(completed.job.completedCount,1);
});
test("interval-waiting jobs lock only their own conversation and do not consume a dispatch slot",()=>{
  const waiting={...makeJob({id:"waiting",conversationId:"one",repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:90000};
  const same=makeJob({id:"same",conversationId:"one"},20);
  const other=makeJob({id:"other",conversationId:"two"},30);
  assert.deepEqual(selectDispatchablePromptJobs([waiting,same,other],1),["other"]);
});
test("releases only interval jobs whose persisted due timestamp has arrived",()=>{
  const waiting={...makeJob({repeatIntervalSeconds:30}),status:"waiting_interval",nextRunAt:5000};
  const early=releaseDuePromptJobs([waiting],4999);
  assert.deepEqual(early.releasedJobIds,[]);
  assert.equal(early.jobs[0].status,"waiting_interval");
  const due=releaseDuePromptJobs(early.jobs,5000);
  assert.deepEqual(due.releasedJobIds,["job-a"]);
  assert.equal(due.jobs[0].status,"queued");
  assert.equal(due.jobs[0].nextRunAt,null);
});
test("pause preserves the remaining interval and resume rebuilds an absolute due time",()=>{
  const waiting={...makeJob({repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:70000};
  const paused=requestPromptPause([waiting],"job-a",50000);
  assert.equal(paused.job.status,"paused");
  assert.equal(paused.job.nextRunAt,null);
  assert.equal(paused.job.remainingDelayMs,20000);
  const resumed=resumePromptJob(paused.jobs,"job-a",80000);
  assert.equal(resumed.job.status,"waiting_interval");
  assert.equal(resumed.job.nextRunAt,100000);
  assert.equal(resumed.job.remainingDelayMs,null);
});
test("resuming a paused interval whose remaining delay reached zero queues immediately",()=>{
  const paused={...makeJob({repeatIntervalSeconds:60}),status:"paused",remainingDelayMs:0};
  const resumed=resumePromptJob([paused],"job-a",90000);
  assert.equal(resumed.job.status,"queued");
  assert.equal(resumed.job.nextRunAt,null);
});
test("stopping an interval-waiting job clears its future dispatch timestamp",()=>{
  const waiting={...makeJob({repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:70000};
  const stopped=requestPromptStop([waiting],"job-a",50000);
  assert.equal(stopped.job.status,"stopped");
  assert.equal(stopped.job.nextRunAt,null);
  assert.equal(stopped.job.remainingDelayMs,null);
});
test("finite final completion and pause-after-response do not schedule another interval",()=>{
  let jobs=[makeJob({repeatLimit:1,repeatIntervalSeconds:60})];
  jobs=beginPromptSend(jobs,"job-a","t1",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t1",1200).jobs;
  const final=completePromptResponse(jobs,"job-a","t1",5000);
  assert.equal(final.job.status,"completed");
  assert.equal(final.job.nextRunAt,null);
  jobs=[makeJob({repeatLimit:3,repeatIntervalSeconds:60})];
  jobs=beginPromptSend(jobs,"job-a","t2",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t2",1200).jobs;
  jobs=requestPromptPause(jobs,"job-a",1300).jobs;
  const paused=completePromptResponse(jobs,"job-a","t2",5000);
  assert.equal(paused.job.status,"paused");
  assert.equal(paused.job.nextRunAt,null);
  assert.equal(paused.job.remainingDelayMs,60000);

  jobs=[makeJob({repeatLimit:1,repeatIntervalSeconds:60})];
  jobs=beginPromptSend(jobs,"job-a","t3",1100).jobs;
  jobs=confirmPromptSent(jobs,"job-a","t3",1200).jobs;
  jobs=requestPromptPause(jobs,"job-a",1300).jobs;
  const finalWhilePauseRequested=completePromptResponse(jobs,"job-a","t3",5000);
  assert.equal(finalWhilePauseRequested.job.status,"completed");
  assert.equal(finalWhilePauseRequested.job.nextRunAt,null);
});
test("stop-all stops interval-waiting jobs instead of leaving an alarm armed",()=>{
  const waiting={...makeJob({repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:70000};
  const result=requestStopAllPromptJobs([waiting],50000);
  assert.equal(result.summary.queuedStopped,1);
  assert.equal(result.jobs[0].status,"stopped");
  assert.equal(result.jobs[0].nextRunAt,null);
});
test("an invalid persisted interval timestamp fails safely rather than dispatching",()=>{
  const waiting={...makeJob({repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:null};
  const result=releaseDuePromptJobs([waiting],50000);
  assert.equal(result.jobs[0].status,"failed");
  assert.match(result.jobs[0].lastError,/schedule is invalid/i);
});

test("begin-send independently refuses a conversation locked by a future repeat interval",()=>{
  const waiting={...makeJob({id:"waiting",conversationId:"same",repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:90000};
  const next=makeJob({id:"next",conversationId:"same"});
  const result=beginPromptSend([waiting,next],"next","token-next",50000);
  assert.equal(result.ok,false);
  assert.match(result.error,/already has an active prompt job/i);
});

test("worker recovery preserves a valid waiting interval and its absolute due timestamp",()=>{
  const waiting={...makeJob({repeatIntervalSeconds:60}),status:"waiting_interval",nextRunAt:90000};
  const recovered=recoverPromptJobsAfterWorkerRestart([waiting],50000);
  assert.equal(recovered.ok,true);
  assert.equal(recovered.jobs[0].status,"waiting_interval");
  assert.equal(recovered.jobs[0].nextRunAt,90000);
});
