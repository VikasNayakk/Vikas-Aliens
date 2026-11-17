const ACTIVE_CONVERSATION_STATES=new Set([
  "sending",
  "awaiting_response",
  "needs_review"
]);

const TERMINAL_STATES=new Set([
  "completed",
  "stopped",
  "failed"
]);

const CONVERSATION_LOCK_STATES=new Set([...ACTIVE_CONVERSATION_STATES,"waiting_interval"]);
const MIN_REPEAT_INTERVAL_SECONDS=30;
const MAX_REPEAT_INTERVAL_SECONDS=86400;
function validRepeatInterval(value) {
  return Number.isInteger(value)&&(value===0||(value>=MIN_REPEAT_INTERVAL_SECONDS&&value<=MAX_REPEAT_INTERVAL_SECONDS));
}

const MAX_PROMPT_RUN_HISTORY=100;
function appendPromptRun(job,run) {
  const history=Array.isArray(job.runHistory)?job.runHistory:[];
  return [...history,run].slice(-MAX_PROMPT_RUN_HISTORY);
}
function updateLatestPromptRun(job,updates) {
  const history=Array.isArray(job.runHistory)?job.runHistory.slice():[];
  if(!history.length) return history;
  const index=history.length-1;
  history[index]={...history[index],...updates};
  return history;
}
function promptRunDuration(run,endedAt) {
  return validTime(run?.startedAt)&&validTime(endedAt)?Math.max(0,endedAt-run.startedAt):null;
}

function validTime(value) {
  return typeof value==="number"&&Number.isFinite(value)&&value>=0;
}

function findJob(jobs,jobId) {
  return Array.isArray(jobs)?jobs.find(job=>job?.id===jobId):undefined;
}

function replaceJob(jobs,updated) {
  return jobs.map(job=>job.id===updated.id?updated:job);
}

function errorResult(error) {
  return {ok:false,error};
}

export function createPromptJob(input,now=Date.now()) {
  if(!input||typeof input!=="object"||Array.isArray(input)) {
    throw new TypeError("Prompt job input must be an object.");
  }
  const id=typeof input.id==="string"?input.id.trim():"";
  const conversationId=typeof input.conversationId==="string"?input.conversationId.trim():"";
  const prompt=typeof input.prompt==="string"?input.prompt.trim():"";
  const tabId=input.tabId;
  const repeatLimit=input.repeatLimit;
  const repeatIntervalSeconds=input.repeatIntervalSeconds??0;

  if(!id||id.length>128) throw new TypeError("Prompt job ID must contain 1–128 characters.");
  if(!conversationId||conversationId.length>256) throw new TypeError("A valid ChatGPT conversation ID is required.");
  if(!Number.isInteger(tabId)||tabId<0) throw new TypeError("A valid ChatGPT tab ID is required.");
  if(!prompt||prompt.length>50000) throw new TypeError("Prompt must contain 1–50,000 characters.");
  if(repeatLimit!==null&&(!Number.isInteger(repeatLimit)||repeatLimit<1||repeatLimit>100000)) {
    throw new TypeError("Repeat limit must be a positive integer or null for unlimited mode.");
  }
  if(!validRepeatInterval(repeatIntervalSeconds)) {
    throw new TypeError("Repeat interval must be 0 (immediate) or 30–86,400 seconds.");
  }
  if(!validTime(now)) throw new TypeError("Creation time must be a non-negative timestamp.");

  return {
    id,
    conversationId,
    tabId,
    prompt,
    repeatLimit,
    repeatIntervalSeconds,
    attemptCount:0,
    runHistory:[],
    nextRunAt:null,
    remainingDelayMs:null,
    sentCount:0,
    completedCount:0,
    status:"queued",
    currentToken:null,
    responseBaseline:null,
    uncertaintyKind:null,
    pauseRequested:false,
    stopRequested:false,
    createdAt:now,
    updatedAt:now,
    lastSentAt:null,
    lastCompletedAt:null,
    lastError:""
  };
}

export function selectDispatchablePromptJobs(jobs,maxConcurrentConversations=3) {
  if(!Array.isArray(jobs)) throw new TypeError("Prompt jobs must be an array.");
  if(!Number.isInteger(maxConcurrentConversations)||maxConcurrentConversations<1||maxConcurrentConversations>20) {
    throw new TypeError("Concurrent conversation limit must be an integer from 1 to 20.");
  }

  const activeJobs=jobs.filter(job=>ACTIVE_CONVERSATION_STATES.has(job?.status));
  const locked=new Set(jobs.filter(job=>CONVERSATION_LOCK_STATES.has(job?.status)).map(job=>job.conversationId));
  const availableSlots=maxConcurrentConversations-activeJobs.length;
  if(availableSlots<=0) return [];

  const selected=[];
  const ordered=jobs
    .filter(job=>job?.status==="queued")
    .slice()
    .sort((a,b)=>(a.createdAt-b.createdAt)||a.id.localeCompare(b.id));

  for(const job of ordered) {
    if(selected.length>=availableSlots) break;
    if(locked.has(job.conversationId)) continue;
    selected.push(job.id);
    locked.add(job.conversationId);
  }
  return selected;
}

export function beginPromptSend(jobs,jobId,token,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="queued") return errorResult("Prompt job is not queued.");
  if(typeof token!=="string"||!token.trim()||token.length>128) {
    return errorResult("A valid send token is required.");
  }
  if(!validTime(now)) return errorResult("Send time is invalid.");

  const locked=jobs.some(other=>
    other.id!==jobId &&
    other.conversationId===job.conversationId &&
    CONVERSATION_LOCK_STATES.has(other.status)
  );
  if(locked) return errorResult("This ChatGPT conversation already has an active prompt job.");

  const attemptCount=(Number.isInteger(job.attemptCount)&&job.attemptCount>=0?job.attemptCount:0)+1;
  const run={
    attempt:attemptCount,
    startedAt:now,
    sendConfirmedAt:null,
    completedAt:null,
    uncertainAt:null,
    durationMs:null,
    outcome:"sending",
    error:"",
    resolution:"",
    resolvedAt:null
  };
  const updated={
    ...job,
    status:"sending",
    currentToken:token,
    attemptCount,
    runHistory:appendPromptRun(job,run),
    updatedAt:now,
    lastError:""
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function confirmPromptSent(jobs,jobId,token,now=Date.now(),responseBaseline=null) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="sending"||job.currentToken!==token) {
    return errorResult("Prompt send acknowledgement is stale or does not match the active send.");
  }
  if(!validTime(now)) return errorResult("Send acknowledgement time is invalid.");

  const baseline=responseBaseline&&typeof responseBaseline==="object"
    ?{
      assistantCount:Number.isInteger(responseBaseline.assistantCount)?Math.max(0,responseBaseline.assistantCount):0,
      assistantKey:String(responseBaseline.assistantKey||"").slice(0,256),
      assistantHash:String(responseBaseline.assistantHash||"").slice(0,32),
      assistantLength:Number.isInteger(responseBaseline.assistantLength)?Math.max(0,responseBaseline.assistantLength):0,
      userCount:Number.isInteger(responseBaseline.userCount)?Math.max(0,responseBaseline.userCount):0,
      sentUserCount:Number.isInteger(responseBaseline.sentUserCount)?Math.max(0,responseBaseline.sentUserCount):0,
      sentUserKey:String(responseBaseline.sentUserKey||"").slice(0,256)
    }
    :null;
  const updated={
    ...job,
    status:"awaiting_response",
    runHistory:updateLatestPromptRun(job,{sendConfirmedAt:now,outcome:"awaiting_response"}),
    responseBaseline:baseline,
    uncertaintyKind:null,
    sentCount:job.sentCount+1,
    lastSentAt:now,
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function completePromptResponse(jobs,jobId,token,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="awaiting_response"||job.currentToken!==token) {
    return errorResult("Assistant completion event is stale or does not match the active prompt.");
  }
  if(!validTime(now)) return errorResult("Completion time is invalid.");

  const completedCount=job.completedCount+1;
  let status="queued";
  if(job.stopRequested) status="stopped";
  else if(job.repeatLimit!==null&&completedCount>=job.repeatLimit) status="completed";
  else if(job.pauseRequested) status="paused";

  const repeatIntervalSeconds=validRepeatInterval(job.repeatIntervalSeconds)?job.repeatIntervalSeconds:0;
  const nextRunAt=status==="queued"&&repeatIntervalSeconds>0?now+repeatIntervalSeconds*1000:null;
  const remainingDelayMs=status==="paused"&&repeatIntervalSeconds>0?repeatIntervalSeconds*1000:null;
  if(nextRunAt!==null) status="waiting_interval";
  const updated={
    ...job,
    status,
    completedCount,
    currentToken:null,
    responseBaseline:null,
    uncertaintyKind:null,
    pauseRequested:false,
    stopRequested:false,
    nextRunAt,
    remainingDelayMs,
    runHistory:updateLatestPromptRun(job,{
      outcome:"completed",
      completedAt:now,
      durationMs:promptRunDuration((Array.isArray(job.runHistory)?job.runHistory:[]).at(-1),now),
      error:""
    }),
    lastCompletedAt:now,
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function requestPromptPause(jobs,jobId,now=Date.now()) {
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(TERMINAL_STATES.has(job.status)) return errorResult("A terminal prompt job cannot be paused.");
  if(!validTime(now)) return errorResult("Pause time is invalid.");

  const waitingInterval=job.status==="waiting_interval";
  const updated={
    ...job,
    status:job.status==="queued"||waitingInterval?"paused":job.status,
    pauseRequested:ACTIVE_CONVERSATION_STATES.has(job.status)?true:false,
    nextRunAt:waitingInterval?null:job.nextRunAt??null,
    remainingDelayMs:waitingInterval?Math.max(0,(job.nextRunAt||now)-now):job.remainingDelayMs??null,
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function requestPromptStop(jobs,jobId,now=Date.now()) {
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(TERMINAL_STATES.has(job.status)) return errorResult("Prompt job is already terminal.");
  if(!validTime(now)) return errorResult("Stop time is invalid.");

  const active=ACTIVE_CONVERSATION_STATES.has(job.status);
  const updated={
    ...job,
    status:active?job.status:"stopped",
    stopRequested:active,
    nextRunAt:null,
    remainingDelayMs:null,
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function resumePromptJob(jobs,jobId,now=Date.now()) {
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="paused") return errorResult("Only a paused prompt job can be resumed.");
  if(!validTime(now)) return errorResult("Resume time is invalid.");

  const remainingDelayMs=validTime(job.remainingDelayMs)?job.remainingDelayMs:0;
  const waiting=remainingDelayMs>0;
  const updated={
    ...job,
    status:waiting?"waiting_interval":"queued",
    pauseRequested:false,
    nextRunAt:waiting?now+remainingDelayMs:null,
    remainingDelayMs:null,
    updatedAt:now,
    lastError:""
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function markPromptDispatchUncertain(jobs,jobId,token,error,now=Date.now(),responseBaseline=null) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="sending"||job.currentToken!==token) {
    return errorResult("Uncertain dispatch does not match the active send.");
  }
  if(!validTime(now)) return errorResult("Uncertain dispatch time is invalid.");

  const updated={
    ...job,
    status:"needs_review",
    runHistory:updateLatestPromptRun(job,{
      outcome:"uncertain_dispatch",
      uncertainAt:now,
      durationMs:promptRunDuration((Array.isArray(job.runHistory)?job.runHistory:[]).at(-1),now),
      error:String(error||"The send result could not be confirmed. Check ChatGPT before retrying.").slice(0,500)
    }),
    uncertaintyKind:"dispatch",
    responseBaseline:responseBaseline&&typeof responseBaseline==="object"?responseBaseline:job.responseBaseline,
    lastError:String(error||"The send result could not be confirmed. Check the ChatGPT conversation before retrying.").slice(0,500),
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function markPromptResponseUncertain(jobs,jobId,token,error,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="awaiting_response"||job.currentToken!==token) {
    return errorResult("Response uncertainty does not match the active prompt.");
  }
  if(!validTime(now)) return errorResult("Response uncertainty time is invalid.");

  const updated={
    ...job,
    status:"needs_review",
    runHistory:updateLatestPromptRun(job,{
      outcome:"uncertain_response",
      uncertainAt:now,
      durationMs:promptRunDuration((Array.isArray(job.runHistory)?job.runHistory:[]).at(-1),now),
      error:String(error||"Assistant completion could not be verified. Check the ChatGPT conversation.").slice(0,500)
    }),
    uncertaintyKind:"response",
    lastError:String(error||"Assistant completion could not be verified. Check the ChatGPT conversation.").slice(0,500),
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function failPromptDispatch(jobs,jobId,token,error,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="sending"||job.currentToken!==token) {
    return errorResult("Prompt failure does not match the active send.");
  }
  if(!validTime(now)) return errorResult("Prompt failure time is invalid.");

  const updated={
    ...job,
    status:"failed",
    runHistory:updateLatestPromptRun(job,{
      outcome:"failed",
      completedAt:now,
      durationMs:promptRunDuration((Array.isArray(job.runHistory)?job.runHistory:[]).at(-1),now),
      error:String(error||"The prompt was not sent.").slice(0,500)
    }),
    currentToken:null,
    responseBaseline:null,
    uncertaintyKind:null,
    nextRunAt:null,
    remainingDelayMs:null,
    lastError:String(error||"The prompt was not sent.").slice(0,500),
    updatedAt:now
  };
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function releaseDuePromptJobs(jobs,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  if(!validTime(now)) return errorResult("Interval release time is invalid.");
  const releasedJobIds=[];
  const updatedJobs=jobs.map(job=>{
    if(job?.status!=="waiting_interval") return job;
    if(!validTime(job.nextRunAt)) return {
      ...job,status:"failed",nextRunAt:null,remainingDelayMs:null,
      lastError:"The saved repeat interval schedule is invalid. This job was stopped safely and was not sent again.",
      updatedAt:now
    };
    if(job.nextRunAt>now) return job;
    releasedJobIds.push(job.id);
    return {...job,status:"queued",nextRunAt:null,remainingDelayMs:null,updatedAt:now};
  });
  return {ok:true,jobs:updatedJobs,releasedJobIds};
}

export function recoverPromptJobsAfterWorkerRestart(jobs,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  if(!validTime(now)) return errorResult("Recovery time is invalid.");

  let recovered=jobs.slice();
  const recoveredJobIds=[];
  for(const job of jobs) {
    if(job?.status!=="sending"||!job.currentToken) continue;
    const result=markPromptDispatchUncertain(
      recovered,
      job.id,
      job.currentToken,
      "The extension worker restarted while a prompt send was in progress. Check ChatGPT before deciding whether it was sent.",
      now
    );
    if(!result.ok) return result;
    recovered=result.jobs;
    recoveredJobIds.push(job.id);
  }
  return {ok:true,jobs:recovered,recoveredJobIds};
}

export function resolveUncertainPromptJob(jobs,jobId,decision,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  const job=findJob(jobs,jobId);
  if(!job) return errorResult("Prompt job was not found.");
  if(job.status!=="needs_review") return errorResult("Prompt job does not need review.");
  if(!validTime(now)) return errorResult("Resolution time is invalid.");

  let updated;
  if(job.uncertaintyKind!=="response"&&decision==="stop_job") {
    updated={
      ...job,
      status:"stopped",
      runHistory:updateLatestPromptRun(job,{
        outcome:"stopped_after_review",
        resolution:"Owner stopped the job after reviewing an uncertain send.",
        resolvedAt:now
      }),
      currentToken:null,
      responseBaseline:null,
      uncertaintyKind:null,
      pauseRequested:false,
      stopRequested:false,
      updatedAt:now,
      lastError:""
    };
  } else if(job.uncertaintyKind==="response") {
    if(decision==="confirm_completed") {
      const awaiting={...job,status:"awaiting_response",uncertaintyKind:null,lastError:""};
      return completePromptResponse(replaceJob(jobs,awaiting),jobId,job.currentToken,now);
    }
    if(decision==="continue_waiting") {
      updated={
        ...job,
        status:"awaiting_response",
        runHistory:updateLatestPromptRun(job,{outcome:"awaiting_response",resolution:"Owner chose to continue waiting.",resolvedAt:now,error:""}),
        uncertaintyKind:null,updatedAt:now,lastError:""
      };
    } else if(decision==="stop_job") {
      updated={
        ...job,
        status:"stopped",
        runHistory:updateLatestPromptRun(job,{outcome:"stopped_after_review",resolution:"Owner stopped the job after reviewing the uncertain response.",resolvedAt:now}),
        currentToken:null,responseBaseline:null,uncertaintyKind:null,updatedAt:now,lastError:""
      };
    } else if(decision==="confirm_failed") {
      updated={
        ...job,
        status:"failed",
        runHistory:updateLatestPromptRun(job,{
          outcome:"failed",
          completedAt:now,
          durationMs:promptRunDuration((Array.isArray(job.runHistory)?job.runHistory:[]).at(-1),now),
          resolution:"Owner marked the response failed after manual review.",
          resolvedAt:now,
          error:"The current prompt response was marked failed after manual review."
        }),
        currentToken:null,responseBaseline:null,uncertaintyKind:null,updatedAt:now,lastError:"The current prompt response was marked failed after manual review."
      };
    } else {
      return errorResult("For a response review, choose confirm_completed, continue_waiting, stop_job or confirm_failed.");
    }
  } else if(decision==="confirm_sent") {
    updated={
      ...job,
      status:"awaiting_response",
      runHistory:updateLatestPromptRun(job,{sendConfirmedAt:now,outcome:"awaiting_response",resolution:"Owner confirmed the prompt was sent.",resolvedAt:now,error:""}),
      uncertaintyKind:null,
      sentCount:job.sentCount+1,
      lastSentAt:now,
      updatedAt:now,
      lastError:""
    };
  } else if(decision==="confirm_not_sent") {
    updated={
      ...job,
      runHistory:updateLatestPromptRun(job,{
        outcome:"not_sent_confirmed",
        completedAt:now,
        durationMs:promptRunDuration((Array.isArray(job.runHistory)?job.runHistory:[]).at(-1),now),
        resolution:"Owner confirmed the prompt was not sent.",
        resolvedAt:now
      }),
      status:job.stopRequested?"stopped":job.pauseRequested?"paused":"queued",
      currentToken:null,
      responseBaseline:null,
      uncertaintyKind:null,
      pauseRequested:false,
      stopRequested:false,
      updatedAt:now,
      lastError:""
    };
  } else {
    return errorResult("For an uncertain send, choose confirm_sent or confirm_not_sent after checking the ChatGPT conversation.");
  }
  return {ok:true,jobs:replaceJob(jobs,updated),job:updated};
}

export function requestStopAllPromptJobs(jobs,now=Date.now()) {
  if(!Array.isArray(jobs)) return errorResult("Prompt jobs must be an array.");
  if(!validTime(now)) return errorResult("Stop-all time is invalid.");

  let queuedStopped=0;
  let activeStopRequested=0;
  let reviewUnchanged=0;
  const updatedJobs=jobs.map(job=>{
    if(!job||TERMINAL_STATES.has(job.status)) return job;
    if(job.status==="queued"||job.status==="paused"||job.status==="waiting_interval") {
      queuedStopped++;
      return {
        ...job,
        status:"stopped",
        pauseRequested:false,
        stopRequested:false,
        currentToken:null,
        responseBaseline:null,
        uncertaintyKind:null,
        nextRunAt:null,
        remainingDelayMs:null,
        updatedAt:now
      };
    }
    if(job.status==="sending"||job.status==="awaiting_response") {
      activeStopRequested++;
      return {...job,stopRequested:true,updatedAt:now};
    }
    if(job.status==="needs_review") {
      reviewUnchanged++;
    }
    return job;
  });

  return {
    ok:true,
    jobs:updatedJobs,
    summary:{queuedStopped,activeStopRequested,reviewUnchanged}
  };
}
