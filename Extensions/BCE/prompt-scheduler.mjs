const MAX_PROMPT_LENGTH = 20_000;
const MAX_CONVERSATION_ID_LENGTH = 512;
const MAX_REPEAT_COUNT = 10_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_CONVERSATIONS = 32;
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;
const STATUSES = new Set([
  "queued",
  "dispatching",
  "awaiting_response",
  "needs_attention",
  "paused",
  "stopped",
  "completed",
  "failed"
]);
const ACTIVE_STATUSES = new Set([
  "dispatching",
  "awaiting_response",
  "needs_attention"
]);
const TERMINAL_STATUSES = new Set(["stopped", "completed", "failed"]);

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(label + " must be a stable identifier (1-128 characters).");
  }
  return value;
}

function requireTime(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(label + " must be a finite non-negative timestamp.");
  }
  return value;
}

function requireNow(value) {
  return requireTime(value, "now");
}

function requireJobCollection(jobs) {
  if (!Array.isArray(jobs)) fail("jobs must be an array.");
  const seen = new Set();
  const copy = jobs.map(job => validatePromptJob(job));
  for (const job of copy) {
    if (seen.has(job.jobId)) fail("Duplicate prompt job ID: " + job.jobId);
    seen.add(job.jobId);
  }
  return copy;
}

export function validatePromptJob(value) {
  if (!isRecord(value)) fail("Prompt job must be an object.");

  const jobId = requireIdentifier(value.jobId, "jobId");
  if (
    typeof value.conversationId !== "string" ||
    !value.conversationId.trim() ||
    value.conversationId.length > MAX_CONVERSATION_ID_LENGTH
  ) {
    fail("conversationId must be a non-empty stable conversation identifier.");
  }

  if (
    typeof value.prompt !== "string" ||
    !value.prompt.trim() ||
    value.prompt.length > MAX_PROMPT_LENGTH
  ) {
    fail("prompt must contain 1-20000 characters.");
  }

  if (value.repeatMode !== "finite" && value.repeatMode !== "unlimited") {
    fail("repeatMode must be finite or unlimited.");
  }
  if (value.repeatMode === "finite") {
    if (
      !Number.isSafeInteger(value.repeatCount) ||
      value.repeatCount < 1 ||
      value.repeatCount > MAX_REPEAT_COUNT
    ) {
      fail("Finite repeatCount must be an integer from 1 to 10000.");
    }
  } else if (value.repeatCount !== null) {
    fail("Unlimited jobs must use repeatCount: null.");
  }

  const intervalMs = value.intervalMs;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > MAX_INTERVAL_MS
  ) {
    fail("intervalMs must be an integer from 0 to 86400000.");
  }

  const sentCount = value.sentCount;
  if (!Number.isSafeInteger(sentCount) || sentCount < 0) {
    fail("sentCount must be a non-negative safe integer.");
  }
  if (value.repeatMode === "finite" && sentCount > value.repeatCount) {
    fail("sentCount cannot exceed repeatCount.");
  }

  if (!STATUSES.has(value.status)) fail("Unsupported prompt job status.");
  const createdAt = requireTime(value.createdAt, "createdAt");
  const updatedAt = requireTime(value.updatedAt, "updatedAt");
  const nextDispatchAt = requireTime(value.nextDispatchAt, "nextDispatchAt");
  if (updatedAt < createdAt) fail("updatedAt cannot be earlier than createdAt.");

  const dispatchId = value.dispatchId ?? null;
  if (dispatchId !== null) requireIdentifier(dispatchId, "dispatchId");

  const pauseRequested = value.pauseRequested ?? false;
  const stopRequested = value.stopRequested ?? false;
  if (typeof pauseRequested !== "boolean" || typeof stopRequested !== "boolean") {
    fail("pauseRequested and stopRequested must be booleans.");
  }

  const lastErrorCode = value.lastErrorCode ?? null;
  if (
    lastErrorCode !== null &&
    (typeof lastErrorCode !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(lastErrorCode))
  ) {
    fail("lastErrorCode must be a short normalized error code or null.");
  }

  if (ACTIVE_STATUSES.has(value.status) && dispatchId === null) {
    fail("Active prompt jobs must retain their dispatchId.");
  }
  if (!ACTIVE_STATUSES.has(value.status) && dispatchId !== null) {
    fail("Inactive prompt jobs cannot retain a dispatchId.");
  }
  if (value.status === "awaiting_response" && sentCount < 1) {
    fail("awaiting_response requires at least one confirmed sent prompt.");
  }
  if (value.status === "needs_attention" && !lastErrorCode) {
    fail("needs_attention requires a recovery reason.");
  }
  if (TERMINAL_STATUSES.has(value.status) && (pauseRequested || stopRequested)) {
    fail("Terminal prompt jobs cannot have pending control requests.");
  }

  return {
    jobId,
    conversationId: value.conversationId.trim(),
    prompt: value.prompt,
    repeatMode: value.repeatMode,
    repeatCount: value.repeatCount,
    sentCount,
    intervalMs,
    status: value.status,
    createdAt,
    updatedAt,
    nextDispatchAt,
    dispatchId,
    pauseRequested,
    stopRequested,
    lastErrorCode
  };
}

export function createPromptJob(input) {
  if (!isRecord(input)) fail("Prompt job input must be an object.");
  const createdAt = requireTime(input.createdAt, "createdAt");
  const repeatMode = input.repeatMode;
  const repeatCount = repeatMode === "unlimited" ? null : input.repeatCount;
  return validatePromptJob({
    jobId: input.jobId,
    conversationId: input.conversationId,
    prompt: input.prompt,
    repeatMode,
    repeatCount,
    sentCount: 0,
    intervalMs: input.intervalMs ?? 0,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    nextDispatchAt: createdAt,
    dispatchId: null,
    pauseRequested: false,
    stopRequested: false,
    lastErrorCode: null
  });
}

function replaceJob(jobs, replacement) {
  return jobs.map(job => job.jobId === replacement.jobId ? replacement : job);
}

function getJob(jobs, jobId) {
  const job = jobs.find(item => item.jobId === jobId);
  if (!job) fail("Unknown prompt job: " + jobId);
  return job;
}

function requireActiveDispatch(job, dispatchId, expectedStatus) {
  requireIdentifier(dispatchId, "dispatchId");
  if (job.status !== expectedStatus || job.dispatchId !== dispatchId) {
    fail("Prompt job dispatch state does not match this event.");
  }
}

function finishResponse(job, now, sentCount = job.sentCount) {
  const base = {
    ...job,
    sentCount,
    dispatchId: null,
    updatedAt: now,
    pauseRequested: false,
    stopRequested: false,
    lastErrorCode: null
  };
  if (job.stopRequested) return { ...base, status: "stopped" };
  if (job.pauseRequested) return { ...base, status: "paused" };
  if (job.repeatMode === "finite" && sentCount >= job.repeatCount) {
    return { ...base, status: "completed" };
  }
  return {
    ...base,
    status: "queued",
    nextDispatchAt: now + job.intervalMs
  };
}

/**
 * Claims one due job. Only one active job may own a conversation at a time.
 * Callers must persist the returned jobs before interacting with the page.
 */
export function claimNextPromptJob(jobs, options) {
  const copy = requireJobCollection(jobs);
  if (!isRecord(options)) fail("claim options must be an object.");
  const now = requireNow(options.now);
  const maxConcurrent = options.maxConcurrentConversations;
  if (
    !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > MAX_CONCURRENT_CONVERSATIONS
  ) {
    fail("maxConcurrentConversations must be an integer from 1 to 32.");
  }
  const dispatchId = requireIdentifier(options.dispatchId, "dispatchId");
  if (copy.some(job => job.dispatchId === dispatchId)) {
    fail("dispatchId is already in use.");
  }

  const activeConversations = new Set(
    copy.filter(job => ACTIVE_STATUSES.has(job.status)).map(job => job.conversationId)
  );
  if (activeConversations.size >= maxConcurrent) {
    return { jobs: copy, claimedJob: null };
  }

  const candidates = copy
    .filter(job =>
      job.status === "queued" &&
      job.nextDispatchAt <= now &&
      !activeConversations.has(job.conversationId)
    )
    .sort((left, right) =>
      left.nextDispatchAt - right.nextDispatchAt ||
      left.createdAt - right.createdAt ||
      left.jobId.localeCompare(right.jobId)
    );

  const selected = candidates[0];
  if (!selected) return { jobs: copy, claimedJob: null };

  const claimedJob = validatePromptJob({
    ...selected,
    status: "dispatching",
    dispatchId,
    updatedAt: now,
    lastErrorCode: null
  });
  return {
    jobs: replaceJob(copy, claimedJob),
    claimedJob
  };
}

/** Records that the content script verified the prompt was accepted by ChatGPT. */
export function confirmPromptSent(jobs, jobId, dispatchId, now) {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  requireActiveDispatch(job, dispatchId, "dispatching");
  const next = validatePromptJob({
    ...job,
    status: "awaiting_response",
    sentCount: job.sentCount + 1,
    updatedAt: requireNow(now),
    lastErrorCode: null
  });
  return replaceJob(copy, next);
}

/** Completes a run only after the page has verifiably finished the assistant response. */
export function completeAssistantResponse(jobs, jobId, dispatchId, now) {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  requireActiveDispatch(job, dispatchId, "awaiting_response");
  const next = validatePromptJob(finishResponse(job, requireNow(now)));
  return replaceJob(copy, next);
}

export function pausePromptJob(jobs, jobId, now) {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  const updatedAt = requireNow(now);
  if (TERMINAL_STATUSES.has(job.status)) fail("Terminal prompt jobs cannot be paused.");
  if (job.status === "paused") return copy;
  const next = ACTIVE_STATUSES.has(job.status)
    ? { ...job, pauseRequested: true, updatedAt }
    : { ...job, status: "paused", updatedAt };
  return replaceJob(copy, validatePromptJob(next));
}

export function resumePromptJob(jobs, jobId, now) {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  if (job.status !== "paused") fail("Only paused prompt jobs can be resumed.");
  const updatedAt = requireNow(now);
  const next = validatePromptJob({
    ...job,
    status: "queued",
    updatedAt,
    nextDispatchAt: updatedAt,
    pauseRequested: false,
    stopRequested: false,
    lastErrorCode: null
  });
  return replaceJob(copy, next);
}

/**
 * Stops future repeats. An active prompt keeps its conversation lock until
 * completion/explicit recovery; it is never silently abandoned mid-response.
 */
export function stopPromptJob(jobs, jobId, now) {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  const updatedAt = requireNow(now);
  if (TERMINAL_STATUSES.has(job.status)) return copy;
  const next = ACTIVE_STATUSES.has(job.status)
    ? { ...job, stopRequested: true, pauseRequested: false, updatedAt }
    : {
        ...job,
        status: "stopped",
        dispatchId: null,
        pauseRequested: false,
        stopRequested: false,
        updatedAt
      };
  return replaceJob(copy, validatePromptJob(next));
}

/** A send whose outcome cannot be proven is quarantined, never auto-retried. */
export function markPromptUncertain(jobs, jobId, dispatchId, now, reason = "dispatch_outcome_unknown") {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  if (job.status !== "dispatching" && job.status !== "awaiting_response") {
    fail("Only an in-flight prompt can be marked uncertain.");
  }
  requireActiveDispatch(job, dispatchId, job.status);
  if (typeof reason !== "string" || !/^[a-z][a-z0-9_.-]{0,95}$/.test(reason)) {
    fail("reason must be a short normalized error code.");
  }
  const next = validatePromptJob({
    ...job,
    status: "needs_attention",
    updatedAt: requireNow(now),
    lastErrorCode: reason
  });
  return replaceJob(copy, next);
}

/**
 * Service-worker recovery converts an unconfirmed dispatch to needs_attention.
 * Confirmed in-flight responses remain locked for the page bridge to reconcile.
 */
export function recoverPromptJobs(jobs, now) {
  const copy = requireJobCollection(jobs);
  const updatedAt = requireNow(now);
  return copy.map(job => {
    if (job.status !== "dispatching") return job;
    return validatePromptJob({
      ...job,
      status: "needs_attention",
      updatedAt,
      lastErrorCode: "worker_restarted_during_dispatch"
    });
  });
}

/**
 * Manual reconciliation is required for an uncertain dispatch. The operator
 * must decide whether a prompt was sent; the scheduler never guesses.
 */
export function resolvePromptUncertainty(jobs, jobId, dispatchId, now, resolution) {
  const copy = requireJobCollection(jobs);
  const job = getJob(copy, jobId);
  requireActiveDispatch(job, dispatchId, "needs_attention");
  const updatedAt = requireNow(now);
  if (resolution !== "sent_and_completed" && resolution !== "not_sent") {
    fail("resolution must be sent_and_completed or not_sent.");
  }
  let next;
  if (resolution === "sent_and_completed") {
    const sentCount = job.sentCount + (job.status === "needs_attention" && job.sentCount === 0 ? 1 : 0);
    next = finishResponse(job, updatedAt, sentCount);
  } else {
    next = {
      ...job,
      status: job.stopRequested ? "stopped" : job.pauseRequested ? "paused" : "queued",
      dispatchId: null,
      updatedAt,
      nextDispatchAt: updatedAt,
      pauseRequested: false,
      stopRequested: false,
      lastErrorCode: null
    };
  }
  return replaceJob(copy, validatePromptJob(next));
}

export function promptConversationLocks(jobs) {
  const copy = requireJobCollection(jobs);
  return [...new Set(copy.filter(job => ACTIVE_STATUSES.has(job.status)).map(job => job.conversationId))];
}
