import test from "node:test";
import assert from "node:assert/strict";
import {
  claimNextPromptJob,
  completeAssistantResponse,
  confirmPromptSent,
  createPromptJob,
  markPromptUncertain,
  pausePromptJob,
  promptConversationLocks,
  recoverPromptJobs,
  resolvePromptUncertainty,
  resumePromptJob,
  stopPromptJob,
  validatePromptJob
} from "../prompt-scheduler.mjs";

function job(overrides = {}) {
  return createPromptJob({
    jobId: "job-1",
    conversationId: "conversation-a",
    prompt: "Prepare the requested report.",
    repeatMode: "finite",
    repeatCount: 2,
    intervalMs: 1000,
    createdAt: 100,
    ...overrides
  });
}

function claim(jobs, dispatchId = "dispatch-1", now = 100, max = 2) {
  return claimNextPromptJob(jobs, {
    now,
    dispatchId,
    maxConcurrentConversations: max
  });
}

test("creates a finite job with a validated initial state", () => {
  const created = job();
  assert.equal(created.status, "queued");
  assert.equal(created.sentCount, 0);
  assert.equal(created.repeatCount, 2);
  assert.equal(created.nextDispatchAt, 100);
  assert.equal(created.dispatchId, null);
});

test("creates an unlimited job only with an explicit unlimited mode", () => {
  const created = job({ repeatMode: "unlimited" });
  assert.equal(created.repeatMode, "unlimited");
  assert.equal(created.repeatCount, null);
});

test("rejects invalid IDs, targets, empty prompts and unbounded schedules", () => {
  assert.throws(() => job({ jobId: "bad id" }), /jobId/);
  assert.throws(() => job({ conversationId: " " }), /conversationId/);
  assert.throws(() => job({ prompt: " " }), /prompt/);
  assert.throws(() => job({ repeatCount: 0 }), /repeatCount/);
  assert.throws(() => job({ repeatCount: 10_001 }), /repeatCount/);
  assert.throws(() => job({ intervalMs: 86_400_001 }), /intervalMs/);
  assert.throws(() => job({ repeatMode: "unlimited", repeatCount: 3 }), /repeatCount/);
});

test("claims the oldest due job and persists a dispatch lock in its conversation", () => {
  const first = job();
  const second = job({ jobId: "job-2", prompt: "Second prompt", createdAt: 110 });
  const result = claim([second, first], "dispatch-1", 120, 2);

  assert.equal(result.claimedJob.jobId, "job-1");
  assert.equal(result.claimedJob.status, "dispatching");
  assert.equal(result.claimedJob.dispatchId, "dispatch-1");
  assert.deepEqual(promptConversationLocks(result.jobs), ["conversation-a"]);
});

test("never claims two jobs for the same conversation concurrently", () => {
  const result = claim([job(), job({ jobId: "job-2", createdAt: 101 })]);
  const second = claim(result.jobs, "dispatch-2", 200, 2);

  assert.equal(result.claimedJob.jobId, "job-1");
  assert.equal(second.claimedJob, null);
});

test("allows different conversations to run concurrently up to the configured limit", () => {
  const jobs = [
    job(),
    job({ jobId: "job-2", conversationId: "conversation-b" }),
    job({ jobId: "job-3", conversationId: "conversation-c" })
  ];
  const first = claim(jobs, "dispatch-1", 100, 2);
  const second = claim(first.jobs, "dispatch-2", 100, 2);
  const third = claim(second.jobs, "dispatch-3", 100, 2);

  assert.equal(first.claimedJob.conversationId, "conversation-a");
  assert.equal(second.claimedJob.conversationId, "conversation-b");
  assert.equal(third.claimedJob, null);
  assert.deepEqual(promptConversationLocks(second.jobs), ["conversation-a", "conversation-b"]);
});

test("does not claim a job before its repeat interval is due", () => {
  const jobs = job({ nextDispatchAt: 500 });
  assert.equal(claim([jobs], "dispatch-1", 499).claimedJob, null);
  assert.equal(claim([jobs], "dispatch-2", 500).claimedJob.status, "dispatching");
});

test("increments sentCount only after the page confirms the prompt was sent", () => {
  const claimed = claim([job()]).jobs;
  assert.equal(claimed[0].sentCount, 0);
  const sent = confirmPromptSent(claimed, "job-1", "dispatch-1", 120);

  assert.equal(sent[0].status, "awaiting_response");
  assert.equal(sent[0].sentCount, 1);
  assert.equal(sent[0].dispatchId, "dispatch-1");
});

test("requires the matching assistant completion event before another repeat is queued", () => {
  const claimed = claim([job()]).jobs;
  const sent = confirmPromptSent(claimed, "job-1", "dispatch-1", 120);
  assert.equal(claim(sent, "dispatch-2", 500).claimedJob, null);

  const completed = completeAssistantResponse(sent, "job-1", "dispatch-1", 300);
  assert.equal(completed[0].status, "queued");
  assert.equal(completed[0].sentCount, 1);
  assert.equal(completed[0].nextDispatchAt, 1300);

  assert.equal(claim(completed, "dispatch-2", 1299).claimedJob, null);
  assert.equal(claim(completed, "dispatch-3", 1300).claimedJob.status, "dispatching");
});

test("finite jobs complete at the exact requested count", () => {
  let current = [job({ repeatCount: 2 })];
  let result = claim(current, "dispatch-1", 100);
  current = confirmPromptSent(result.jobs, "job-1", "dispatch-1", 101);
  current = completeAssistantResponse(current, "job-1", "dispatch-1", 102);
  result = claim(current, "dispatch-2", 1102);
  current = confirmPromptSent(result.jobs, "job-1", "dispatch-2", 1103);
  current = completeAssistantResponse(current, "job-1", "dispatch-2", 1104);

  assert.equal(current[0].sentCount, 2);
  assert.equal(current[0].status, "completed");
  assert.equal(claim(current, "dispatch-3", 5000).claimedJob, null);
});

test("unlimited jobs keep scheduling until explicitly stopped", () => {
  let current = [job({ repeatMode: "unlimited" })];
  for (let index = 1; index <= 3; index++) {
    const dispatchId = "dispatch-" + index;
    const result = claim(current, dispatchId, 100 + (index - 1) * 1000);
    current = confirmPromptSent(result.jobs, "job-1", dispatchId, 101 + (index - 1) * 1000);
    current = completeAssistantResponse(current, "job-1", dispatchId, 102 + (index - 1) * 1000);
  }
  assert.equal(current[0].sentCount, 3);
  assert.equal(current[0].status, "queued");
});

test("pause and resume preserve an active response lock until completion", () => {
  const claimed = claim([job()]).jobs;
  const sent = confirmPromptSent(claimed, "job-1", "dispatch-1", 120);
  const paused = pausePromptJob(sent, "job-1", 130);
  assert.equal(paused[0].status, "awaiting_response");
  assert.equal(paused[0].pauseRequested, true);
  assert.deepEqual(promptConversationLocks(paused), ["conversation-a"]);

  const finished = completeAssistantResponse(paused, "job-1", "dispatch-1", 150);
  assert.equal(finished[0].status, "paused");
  assert.deepEqual(promptConversationLocks(finished), []);
  const resumed = resumePromptJob(finished, "job-1", 200);
  assert.equal(resumed[0].status, "queued");
  assert.equal(resumed[0].nextDispatchAt, 200);
});

test("stop prevents future repeats but keeps an active conversation locked", () => {
  const claimed = claim([job()]).jobs;
  const sent = confirmPromptSent(claimed, "job-1", "dispatch-1", 120);
  const requested = stopPromptJob(sent, "job-1", 130);
  assert.equal(requested[0].status, "awaiting_response");
  assert.equal(requested[0].stopRequested, true);
  const finished = completeAssistantResponse(requested, "job-1", "dispatch-1", 150);
  assert.equal(finished[0].status, "stopped");
  assert.deepEqual(promptConversationLocks(finished), []);
});

test("pause or stop applies immediately to a job that is not in flight", () => {
  const paused = pausePromptJob([job()], "job-1", 110);
  assert.equal(paused[0].status, "paused");
  const stopped = stopPromptJob(paused, "job-1", 120);
  assert.equal(stopped[0].status, "stopped");
});

test("worker restart never silently retries a possibly sent prompt", () => {
  const claimed = claim([job()]).jobs;
  const recovered = recoverPromptJobs(claimed, 200);

  assert.equal(recovered[0].status, "needs_attention");
  assert.equal(recovered[0].dispatchId, "dispatch-1");
  assert.equal(recovered[0].lastErrorCode, "worker_restarted_during_dispatch");
  assert.equal(claim(recovered, "dispatch-2", 300).claimedJob, null);
});

test("confirmed in-flight responses remain locked across worker recovery", () => {
  const claimed = claim([job()]).jobs;
  const sent = confirmPromptSent(claimed, "job-1", "dispatch-1", 120);
  const recovered = recoverPromptJobs(sent, 200);

  assert.equal(recovered[0].status, "awaiting_response");
  assert.deepEqual(promptConversationLocks(recovered), ["conversation-a"]);
});

test("manual uncertainty resolution requires an explicit operator decision", () => {
  const claimed = claim([job()]).jobs;
  const uncertain = recoverPromptJobs(claimed, 200);
  const notSent = resolvePromptUncertainty(
    uncertain, "job-1", "dispatch-1", 210, "not_sent"
  );
  assert.equal(notSent[0].status, "queued");
  assert.equal(notSent[0].sentCount, 0);

  const secondClaim = claim([job()], "dispatch-2", 100).jobs;
  const secondUncertain = recoverPromptJobs(secondClaim, 200);
  const sent = resolvePromptUncertainty(
    secondUncertain, "job-1", "dispatch-1", 210, "sent_and_completed"
  );
  assert.equal(sent[0].sentCount, 1);
  assert.equal(sent[0].status, "queued");
});

test("rejects stale dispatch IDs and corrupted persisted snapshots", () => {
  const claimed = claim([job()]).jobs;
  assert.throws(
    () => confirmPromptSent(claimed, "job-1", "stale-dispatch", 120),
    /does not match/
  );
  assert.throws(
    () => validatePromptJob({ ...job(), status: "awaiting_response" }),
    /dispatchId/
  );
  assert.throws(
    () => claim([job(), job({ jobId: "job-1" })], "dispatch-2", 200),
    /Duplicate prompt job ID/
  );
});
