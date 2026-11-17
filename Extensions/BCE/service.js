import {localAnalyze,redactSensitiveText,SYSTEM_PROMPT} from "./analyzer.js";
import {appendUniqueMessages,countPendingSpeechMessages,normalizeSpeechBatch} from "./speech-queue.mjs";
import {resolveTeamsGroupIdentity} from "./group-identity.mjs";
import {createMessageFingerprint,isTeamsContentSender,normalizeTeamsLiveMessage} from "./message-contracts.mjs";
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
  resolveUncertainPromptJob,
  resumePromptJob,
  selectDispatchablePromptJobs
} from "./prompt-scheduler.mjs";

chrome.runtime.onMessage.addListener((m,s,send)=>{if(m?.type==="ANALYZE_MESSAGES"){analyze(m.text).then(send).catch(e=>send({output:"Analysis error: "+e.message,remote:false}));return true;}if(m?.type==="TEST_OPENAI"){testApi().then(send).catch(e=>send({ok:false,error:e.message}));return true;}});
async function requestOpenAI(key,model,messages){let r;try{r=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({model,temperature:0,messages})});}catch(e){throw Error("Network/CORS error: "+e.message);}const data=await r.json().catch(()=>({}));if(!r.ok){const detail=data?.error?.message||data?.error?.code||("HTTP "+r.status);throw Error("OpenAI API "+r.status+": "+detail);}const output=data.choices?.[0]?.message?.content?.trim();if(!output)throw Error("OpenAI returned an empty response.");return output;}
async function testApi(){const s=await chrome.storage.local.get(["apiKey","model"]);if(!s.apiKey)throw Error("Save an API key first.");await requestOpenAI(s.apiKey,s.model||"gpt-4.1-mini",[{role:"user",content:"Reply with exactly: API connection successful"}]);return {ok:true,model:s.model||"gpt-4.1-mini"};}
async function analyze(input){const s=await chrome.storage.local.get(["apiKey","model","redact"]);const safe=s.redact===false?String(input):redactSensitiveText(input);if(!s.apiKey)return {output:localAnalyze(safe),remote:false};const output=await requestOpenAI(s.apiKey,s.model||"gpt-4.1-mini",[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:safe}]);return {output,remote:true};}


const PROMPT_JOBS_KEY = "chatgptPromptJobs";
const PROMPT_MAX_CONCURRENT = 3;
const PROMPT_MAX_ACTIVE_JOBS = 50;
let promptMutationQueue = Promise.resolve();
let promptDispatching = false;

const TEAMS_LIVE_KEY = "teamsLiveEnabled";
const TEAMS_GROUPS_KEY = "teamsSelectedGroups";
const TEAMS_READ_COUNT = "teamsReadCount";
const TEAMS_RECENT_EVENTS = "teamsRecentEvents";
const recentMessageIds = new Map();
const processedMessageIds = new Set();
let processedMessageIdsLoaded = false;
let speechQueue = [];
let speechCurrent = null;
let speechQueueLoaded = false;
let speechQueueHydration = null;
let speechProcessing = false;
let speechDispatchTimer = null;
let groupDelayTimer = null;
let speechAdvanceTimer = null;

const teamsUrl = url => /^https:\/\/(teams\.cloud\.microsoft|teams\.microsoft\.com)\//i.test(url || "");
const normalizeGroup = value => String(value || "").normalize("NFKC").replace(/\s+/g," ").trim().toLowerCase();

const chatgptUrl = url => /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(url||"");
function conversationIdFromUrl(url) {
  try {
    const parsed=new URL(url);
    if(!chatgptUrl(parsed.href)) return "";
    const match=parsed.pathname.match(/(?:^|\/)c\/([A-Za-z0-9_-]{8,})(?:\/|$)/);
    return match?decodeURIComponent(match[1]):"";
  } catch (_) {
    return "";
  }
}
function isChatGPTContentSender(sender) {
  if(!Number.isInteger(sender?.tab?.id)) return false;
  if(sender.frameId!==0&&sender.frameId!==undefined) return false;
  const url=sender.url||sender.tab.url||"";
  return chatgptUrl(url)&&!!conversationIdFromUrl(url);
}
async function sendChatGPTTabMessage(tabId,message) {
  const tab=await chrome.tabs.get(tabId);
  if(!chatgptUrl(tab?.url)) throw new Error("The selected tab is not an allowed ChatGPT conversation.");
  try {
    return await chrome.tabs.sendMessage(tabId,message);
  } catch (_) {
    await chrome.scripting.executeScript({target:{tabId},files:["chatgpt-content.js"]});
    return chrome.tabs.sendMessage(tabId,message);
  }
}
async function getStoredPromptJobs() {
  const saved=await chrome.storage.local.get(PROMPT_JOBS_KEY);
  return Array.isArray(saved[PROMPT_JOBS_KEY])?saved[PROMPT_JOBS_KEY]:[];
}
async function mutatePromptJobs(mutator) {
  const operation=promptMutationQueue.then(async()=>{
    const jobs=await getStoredPromptJobs();
    const result=await mutator(jobs);
    if(Array.isArray(result?.jobs)) {
      await chrome.storage.local.set({[PROMPT_JOBS_KEY]:result.jobs});
    }
    return result;
  });
  promptMutationQueue=operation.then(()=>undefined,()=>undefined);
  return operation;
}
async function publishPromptJobs() {
  const jobs=await getStoredPromptJobs();
  const state={
    jobs,
    activeCount:jobs.filter(job=>["sending","awaiting_response","needs_review"].includes(job.status)).length,
    queuedCount:jobs.filter(job=>job.status==="queued").length,
    needsReviewCount:jobs.filter(job=>job.status==="needs_review").length
  };
  chrome.runtime.sendMessage({type:"CHATGPT_PROMPT_JOBS_UPDATED",state},()=>void chrome.runtime.lastError);
  return state;
}
async function getChatGPTTabInfo(tabId) {
  const tab=await chrome.tabs.get(tabId);
  if(!chatgptUrl(tab?.url)) throw new Error("Open a ChatGPT conversation tab first.");
  const info=await sendChatGPTTabMessage(tabId,{type:"CHATGPT_GET_CONVERSATION_INFO"});
  const expectedId=conversationIdFromUrl(tab.url);
  if(!info?.ok||!info.conversationId||info.conversationId!==expectedId) {
    throw new Error(info?.error||"The active ChatGPT conversation could not be verified.");
  }
  return {
    tabId,
    conversationId:info.conversationId,
    title:String(info.title||"ChatGPT conversation").slice(0,180),
    url:tab.url,
    composerAvailable:info.composerAvailable===true,
    sendAvailable:info.sendAvailable===true,
    generating:info.generating===true
  };
}
async function listChatGPTConversations() {
  const tabs=await chrome.tabs.query({});
  const candidates=tabs
    .filter(tab=>Number.isInteger(tab.id)&&chatgptUrl(tab.url))
    .sort((a,b)=>Number(!!b.active)-Number(!!a.active));
  const results=await Promise.all(candidates.map(async tab=>{
    try {
      const info=await getChatGPTTabInfo(tab.id);
      return {...info,active:tab.active===true,windowId:tab.windowId,index:tab.index};
    } catch (_) {
      return null;
    }
  }));

  const seen=new Set();
  return results.filter(info=>{
    if(!info||seen.has(info.conversationId)) return false;
    seen.add(info.conversationId);
    return true;
  });
}
async function startPromptResponseMonitor(job) {
  if(!job?.responseBaseline) {
    const result=await mutatePromptJobs(jobs=>
      markPromptResponseUncertain(jobs,job.id,job.currentToken,
        "The send was confirmed but no response baseline was saved. Verify the ChatGPT conversation manually.")
    );
    await publishPromptJobs();
    return result;
  }
  try {
    const result=await sendChatGPTTabMessage(job.tabId,{
      type:"CHATGPT_START_RESPONSE_MONITOR",
      jobId:job.id,
      token:job.currentToken,
      conversationId:job.conversationId,
      baseline:job.responseBaseline,
      prompt:job.prompt
    });
    if(!result?.ok) throw new Error(result?.error||"The ChatGPT response monitor could not be attached.");
    return {ok:true};
  } catch(error) {
    const result=await mutatePromptJobs(jobs=>
      markPromptResponseUncertain(jobs,job.id,job.currentToken,
        "The prompt was sent, but completion monitoring failed: "+error.message)
    );
    await publishPromptJobs();
    return result;
  }
}
async function dispatchOnePromptJob(jobId) {
  const token=crypto.randomUUID();
  const begun=await mutatePromptJobs(jobs=>beginPromptSend(jobs,jobId,token));
  if(!begun?.ok) return;
  await publishPromptJobs();

  const job=begun.job;
  let response;
  try {
    const tab=await chrome.tabs.get(job.tabId);
    if(!chatgptUrl(tab?.url)||conversationIdFromUrl(tab.url)!==job.conversationId) {
      throw new Error("The selected ChatGPT tab is no longer on the conversation assigned to this job.");
    }
    response=await sendChatGPTTabMessage(job.tabId,{
      type:"CHATGPT_SEND_PROMPT",
      jobId:job.id,
      token,
      conversationId:job.conversationId,
      prompt:job.prompt
    });
  } catch(error) {
    await mutatePromptJobs(jobs=>markPromptDispatchUncertain(
      jobs,job.id,token,
      "The extension lost contact with ChatGPT during the send. The prompt may have been sent; check the conversation before retrying. "+error.message
    ));
    await publishPromptJobs();
    return;
  }

  if(!response?.ok) {
    if(response?.uncertain) {
      await mutatePromptJobs(jobs=>markPromptDispatchUncertain(
        jobs,job.id,token,response.error||"The send result is uncertain.",Date.now(),response.baseline||null
      ));
    } else {
      await mutatePromptJobs(jobs=>failPromptDispatch(
        jobs,job.id,token,response?.error||"ChatGPT rejected the prompt before sending."
      ));
    }
    await publishPromptJobs();
    return;
  }

  if(!response.baseline||!Number.isInteger(response.baseline.assistantCount)||
    !Number.isInteger(response.baseline.userCount)||!response.baseline.sentUserKey) {
    await mutatePromptJobs(jobs=>markPromptDispatchUncertain(
      jobs,job.id,token,
      "ChatGPT accepted the send action but did not return a verifiable message baseline.",
      Date.now(),response.baseline||null
    ));
    await publishPromptJobs();
    return;
  }

  const confirmed=await mutatePromptJobs(jobs=>
    confirmPromptSent(jobs,job.id,token,Date.now(),response.baseline)
  );
  if(!confirmed?.ok) return;
  await publishPromptJobs();
  await startPromptResponseMonitor(confirmed.job);
}
async function dispatchPromptJobs() {
  if(promptDispatching) return;
  promptDispatching=true;
  try {
    const jobs=await getStoredPromptJobs();
    const selected=selectDispatchablePromptJobs(jobs,PROMPT_MAX_CONCURRENT);
    await Promise.all(selected.map(jobId=>dispatchOnePromptJob(jobId)));
  } finally {
    promptDispatching=false;
    await publishPromptJobs();
    const pending=selectDispatchablePromptJobs(await getStoredPromptJobs(),PROMPT_MAX_CONCURRENT);
    if(pending.length) setTimeout(()=>dispatchPromptJobs().catch(()=>{}),0);
  }
}
async function createChatGPTPromptJob(request) {
  const tabId=request?.tabId;
  const prompt=typeof request?.prompt==="string"?request.prompt.trim():"";
  const repeatLimit=request?.repeatLimit;
  if(!Number.isInteger(tabId)||tabId<0) throw new Error("Select an open ChatGPT conversation tab.");
  if(!prompt||prompt.length>50000) throw new Error("Prompt must contain 1–50,000 characters.");
  if(repeatLimit!==null&&(!Number.isInteger(repeatLimit)||repeatLimit<1||repeatLimit>100000)) {
    throw new Error("Repeat count must be 1–100,000, or choose unlimited mode.");
  }

  const info=await getChatGPTTabInfo(tabId);
  if(!info.composerAvailable||!info.sendAvailable) {
    throw new Error("The selected conversation does not currently expose a usable prompt composer and Send control.");
  }
  if(info.generating) {
    throw new Error("ChatGPT is already generating a response in this conversation. Wait for it to finish before creating a prompt job.");
  }

  const result=await mutatePromptJobs(jobs=>{
    const active=jobs.filter(job=>!["completed","stopped","failed"].includes(job.status)).length;
    if(active>=PROMPT_MAX_ACTIVE_JOBS) {
      return {ok:false,error:"BCE already has 50 active prompt jobs. Finish or stop an existing job first."};
    }
    const job=createPromptJob({
      id:crypto.randomUUID(),
      conversationId:info.conversationId,
      tabId,
      prompt,
      repeatLimit
    });
    const activeJobs=jobs.filter(item=>!["completed","stopped","failed"].includes(item.status));
    const recentTerminal=jobs.filter(item=>["completed","stopped","failed"].includes(item.status)&&
      Date.now()-item.updatedAt<30*24*60*60*1000).slice(-150);
    const retained=[...activeJobs,...recentTerminal];
    return {ok:true,jobs:[...retained,job],job};
  });
  if(!result?.ok) throw new Error(result?.error||"Could not create the prompt job.");
  await publishPromptJobs();
  dispatchPromptJobs().catch(()=>{});
  return result.job;
}
async function mutatePromptJob(jobId,action,decision) {
  const now=Date.now();
  const result=await mutatePromptJobs(jobs=>{
    if(action==="pause") return requestPromptPause(jobs,jobId,now);
    if(action==="stop") return requestPromptStop(jobs,jobId,now);
    if(action==="resume") return resumePromptJob(jobs,jobId,now);
    if(action==="resolve") return resolveUncertainPromptJob(jobs,jobId,decision,now);
    return {ok:false,error:"Unsupported prompt-job action."};
  });
  if(!result?.ok) throw new Error(result?.error||"Could not update this prompt job.");

  if(action==="resolve"&&decision==="confirm_not_sent") {
    const job=result.job;
    if(Number.isInteger(job.tabId)) {
      try { await sendChatGPTTabMessage(job.tabId,{type:"CHATGPT_STOP_RESPONSE_MONITOR",jobId}); } catch (_) {}
    }
    dispatchPromptJobs().catch(()=>{});
  } else if(action==="resolve"&&result.job.status==="awaiting_response") {
    await startPromptResponseMonitor(result.job);
  } else if(action==="resolve"&&["completed","stopped","failed","queued"].includes(result.job.status)) {
    try { await sendChatGPTTabMessage(result.job.tabId,{type:"CHATGPT_STOP_RESPONSE_MONITOR",jobId}); } catch (_) {}
    if(result.job.status==="queued") dispatchPromptJobs().catch(()=>{});
  } else if(action==="resume") {
    dispatchPromptJobs().catch(()=>{});
  }
  await publishPromptJobs();
  return result.job;
}
async function resumePromptMonitorsForTab(tabId,conversation) {
  const jobs=await getStoredPromptJobs();
  const pending=jobs.filter(job=>
    job.tabId===tabId&&job.conversationId===conversation&&job.status==="awaiting_response"
  );
  for(const job of pending) await startPromptResponseMonitor(job);
}
async function handleChatGPTContentEvent(message,sender) {
  if(!isChatGPTContentSender(sender)) return;
  const tabId=sender.tab.id;
  const pageUrl=sender.url||sender.tab.url||"";
  const actualConversation=conversationIdFromUrl(pageUrl);
  if(message?.type==="CHATGPT_TAB_READY") {
    if(message.conversationId!==actualConversation) return;
    await resumePromptMonitorsForTab(tabId,actualConversation);
    return;
  }

  const jobId=typeof message.jobId==="string"?message.jobId:"";
  const token=typeof message.token==="string"?message.token:"";
  if(!jobId||jobId.length>128||!token||token.length>128||message.conversationId!==actualConversation) return;
  const jobs=await getStoredPromptJobs();
  const job=jobs.find(item=>item.id===jobId);
  if(!job||job.tabId!==tabId||job.conversationId!==actualConversation||job.currentToken!==token) return;

  if(message.type==="CHATGPT_RESPONSE_COMPLETED") {
    if(!Number.isInteger(message.responseLength)||message.responseLength<1||message.responseLength>500000) return;
    const result=await mutatePromptJobs(current=>completePromptResponse(current,jobId,token,Date.now()));
    if(result?.ok) {
      await publishPromptJobs();
      dispatchPromptJobs().catch(()=>{});
    }
  } else if(message.type==="CHATGPT_RESPONSE_UNCERTAIN") {
    const reason=typeof message.reason==="string"?message.reason.slice(0,500):"ChatGPT response completion could not be verified.";
    const result=await mutatePromptJobs(current=>markPromptResponseUncertain(current,jobId,token,reason));
    if(result?.ok) await publishPromptJobs();
  }
}
async function recoverPromptJobs() {
  const jobs=await getStoredPromptJobs();
  for(const job of jobs) {
    if(job.status==="sending") {
      await mutatePromptJobs(current=>markPromptDispatchUncertain(
        current,job.id,job.currentToken,
        "The extension restarted while a prompt send was in progress. Check ChatGPT before deciding whether to retry."
      ));
    }
  }
  const refreshed=await getStoredPromptJobs();
  for(const job of refreshed) {
    if(job.status==="awaiting_response") {
      try {
        const tab=await chrome.tabs.get(job.tabId);
        if(!chatgptUrl(tab?.url)||conversationIdFromUrl(tab.url)!==job.conversationId) {
          await mutatePromptJobs(current=>markPromptResponseUncertain(
            current,job.id,job.currentToken,
            "The ChatGPT tab was closed or navigated away while the response was pending."
          ));
        } else {
          await startPromptResponseMonitor(job);
        }
      } catch (_) {
        await mutatePromptJobs(current=>markPromptResponseUncertain(
          current,job.id,job.currentToken,
          "The ChatGPT tab is unavailable while the response is pending."
        ));
      }
    }
  }
  await publishPromptJobs();
  dispatchPromptJobs().catch(()=>{});
}
async function handlePromptTabRemoved(tabId) {
  const jobs=await getStoredPromptJobs();
  for(const job of jobs) {
    if(job.tabId!==tabId) continue;
    if(job.status==="sending") {
      await mutatePromptJobs(current=>markPromptDispatchUncertain(
        current,job.id,job.currentToken,
        "The ChatGPT tab closed during prompt dispatch. Check the conversation before retrying."
      ));
    } else if(job.status==="awaiting_response") {
      await mutatePromptJobs(current=>markPromptResponseUncertain(
        current,job.id,job.currentToken,
        "The ChatGPT tab closed before response completion could be verified."
      ));
    }
  }
  await publishPromptJobs();
}

async function getTeamsTabs() {
  const tabs=await chrome.tabs.query({});
  return tabs.filter(tab=>teamsUrl(tab.url));
}

async function getStoredGroups() {
  const saved=await chrome.storage.local.get(TEAMS_GROUPS_KEY);
  return Array.isArray(saved[TEAMS_GROUPS_KEY])?saved[TEAMS_GROUPS_KEY]:[];
}

async function getLiveState() {
  await hydrateSpeechQueue();
  const saved=await chrome.storage.local.get([
    TEAMS_LIVE_KEY,TEAMS_READ_COUNT,TEAMS_RECENT_EVENTS,
    "teamsLastStatus","teamsPopupTheme","teamsSpeechQueue","teamsSpeechCurrent"
  ]);
  const tabs=await getTeamsTabs();
  const groups=await getStoredGroups();
  const current=saved.teamsSpeechCurrent;
  return {
    teamsLiveEnabled:!!saved[TEAMS_LIVE_KEY],
    teamsTabCount:tabs.length,
    teamsMonitorCount:tabs.length,
    teamsMonitorMissing:[],
    teamsGroupCount:groups.length,
    teamsSelectedGroups:groups,
    teamsReadCount:saved[TEAMS_READ_COUNT]||0,
    teamsRecentEvents:saved[TEAMS_RECENT_EVENTS]||[],
    teamsQueueCount:countPendingSpeechMessages(saved.teamsSpeechQueue,current),
    teamsLastStatus:saved.teamsLastStatus||"",
    teamsPopupTheme:saved.teamsPopupTheme||"light"
  };
}

async function publishLiveState() {
  const state=await getLiveState();
  chrome.runtime.sendMessage({type:"TEAMS_LIVE_STATE_UPDATED",state},()=>void chrome.runtime.lastError);
  return state;
}

async function setStatus(text) {
  await chrome.storage.local.set({teamsLastStatus:text});
  await publishLiveState();
}

async function injectTeamsTabs() {
  const tabs=await getTeamsTabs();
  let injected=0,failed=0;
  for(const tab of tabs) {
    try {
      await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},files:["teams-content.js"]});
      injected++;
    } catch (_) { failed++; }
  }
  return {total:tabs.length,injected,failed};
}

async function setTeamsLiveEnabled(enabled) {
  await chrome.storage.local.set({[TEAMS_LIVE_KEY]:!!enabled});
  if(!enabled) {
    if(speechDispatchTimer) clearTimeout(speechDispatchTimer);
    if(groupDelayTimer) clearTimeout(groupDelayTimer);
    if(speechAdvanceTimer) clearTimeout(speechAdvanceTimer);
    speechDispatchTimer=null;
    speechAdvanceTimer=null;
    groupDelayTimer=null;
    chrome.tts.stop();
    await stopTeamsAudio();
    speechQueue=[];
    speechCurrent=null;
    speechProcessing=false;
    speechQueueLoaded=true;
    await chrome.storage.local.set({
      teamsSpeechQueue:[],
      teamsSpeechCurrent:null,
      teamsLastStatus:"Live reading is OFF. Speech queue cleared."
    });
  } else {
    const groups=await getStoredGroups();
    for(const group of groups) {
      if(Number.isInteger(group.monitorTabId)) {
        try { await chrome.tabs.remove(group.monitorTabId); } catch (_) {}
        group.monitorTabId=null;
      }
      delete group.monitorUrl;
      // Keep chatId as the stable identity of this selected conversation.
    }
    await chrome.storage.local.set({[TEAMS_GROUPS_KEY]:groups});
    const result=await injectTeamsTabs();
    const status=result.total===0
      ? "Live reading is ON, but Teams is not open. Open Teams in one browser tab to monitor its in-app notifications."
      : "Live reading is ON. Watching Teams in-app notifications across "+result.injected+" Teams tab(s). Keep Teams open and allow message previews.";
    await chrome.storage.local.set({teamsLastStatus:status});
  }
  return publishLiveState();
}

async function activeTeamsTab() {
  const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if(!tab || !tab.id || !teamsUrl(tab.url)) throw new Error("Open the Teams group you want to add in the active browser tab first.");
  return tab;
}

async function waitForMonitorTab(tabId, timeoutMs=25000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    let tab=null;
    try { tab=await chrome.tabs.get(tabId); } catch (_) { return null; }
    if(tab?.discarded) {
      try { await chrome.tabs.reload(tabId); } catch (_) {}
      await new Promise(resolve=>setTimeout(resolve,350));
      continue;
    }
    if(tab && teamsUrl(tab.url)) {
      try { await chrome.tabs.update(tabId,{autoDiscardable:false}); } catch (_) {}
    }
    if(tab && teamsUrl(tab.url) && tab.status==="complete") return tab;
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw new Error("The dedicated Teams monitor tab is still loading. Try again in a few seconds.");
}

async function sendToMonitorTab(tabId, message) {
  await waitForMonitorTab(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId,message,{frameId:0});
  } catch (_) {
    await chrome.scripting.executeScript({
      target:{tabId,frameIds:[0]},
      files:["teams-content.js"]
    });
    return chrome.tabs.sendMessage(tabId,message,{frameId:0});
  }
}

async function addCurrentGroup() {
  const tab=await activeTeamsTab();
  await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},files:["teams-content.js"]});
  const info=await chrome.tabs.sendMessage(tab.id,{type:"TEAMS_GET_GROUP_INFO_V17"},{frameId:0});
  if(!info?.ok || !info.groupName || !info.groupKey) {
    throw new Error(info?.error || "Could not identify the currently open Teams group.");
  }

  const groups=await getStoredGroups();
  const resolved=resolveTeamsGroupIdentity(groups,info,tab.id);
  if(!resolved.ok) throw new Error(resolved.error);

  const existingIndex=groups.findIndex(item=>
    (info.chatId&&item.chatId===info.chatId) ||
    (item.key===info.groupKey&&(!info.chatId||!item.chatId))
  );
  let group=resolved.group;
  if(existingIndex>=0) {
    group={...groups[existingIndex],...resolved.group};
    groups[existingIndex]=group;
  } else {
    groups.push(group);
  }

  const tabIds=Array.isArray(group.tabIds)?group.tabIds:[];
  if(!tabIds.includes(tab.id)) tabIds.push(tab.id);
  group.tabIds=tabIds;
  group.id=info.chatId||group.id||info.groupKey;
  group.key=info.groupKey;
  group.name=info.groupName;
  group.chatId=info.chatId||group.chatId||"";
  group.lastAddedTabId=tab.id;
  delete group.monitorUrl;
  delete group.monitorTabId;
  groups.forEach((item,index)=>item.priority=index);
  await chrome.storage.local.set({[TEAMS_GROUPS_KEY]:groups});
  await setStatus("Added "+group.name+". Teams notifications from this group will be monitored.");
  return {ok:true,group,baselineCount:info.baselineCount||0};
}

async function removeGroup(groupKey) {
  const existing=await getStoredGroups();
  const removed=existing.find(group=>group.key===groupKey);
  const groups=existing.filter(group=>group.key!==groupKey);
  groups.forEach((group,index)=>group.priority=index);
  await chrome.storage.local.set({[TEAMS_GROUPS_KEY]:groups});
  if(Number.isInteger(removed?.monitorTabId)) {
    try { await chrome.tabs.remove(removed.monitorTabId); } catch (_) {}
  }
  await hydrateSpeechQueue();
  speechQueue=speechQueue.filter(item=>item.groupKey!==groupKey);
  await persistSpeechQueue();
  await setStatus("Group removed. Its background monitor and queued messages were cleared.");
  return publishLiveState();
}

async function reorderGroups(order) {
  const groups=await getStoredGroups();
  const sorted=[];
  for(const key of order||[]) {
    const group=groups.find(item=>item.key===key);
    if(group && !sorted.includes(group)) sorted.push(group);
  }
  for(const group of groups) if(!sorted.includes(group)) sorted.push(group);
  sorted.forEach((group,index)=>group.priority=index);
  await chrome.storage.local.set({[TEAMS_GROUPS_KEY]:sorted});
  await setStatus("Group priority order saved.");
  return publishLiveState();
}

async function readLastFive(groupKey) {
  const groups=await getStoredGroups();
  const group=groups.find(item=>item.key===groupKey);
  if(!group) throw new Error("This group is no longer selected.");
  const tabId=group.lastAddedTabId;
  if(!Number.isInteger(tabId)) throw new Error("Open this Teams group and add it again before reading its history.");
  const result=await sendToMonitorTab(tabId,{type:"TEAMS_READ_LAST_FIVE_V16",groupKey});
  if(!result?.ok) throw new Error(result?.error||"Could not read the last five messages from the currently open group.");
  const recentMessages=(result.messages||[]).slice(-5);
  const messages=[];
  for(const message of recentMessages){
    const messageKey=group.key+"|"+String(message.key||"");
    if(!message.key||await wasMessageProcessed(messageKey)) continue;
    messages.push(message);
  }
  if(!messages.length) {
    await setStatus("No readable incoming messages were found in "+group.name+".");
    return publishLiveState();
  }
  const items=[{
    groupKey:group.key,groupName:group.name,
    messages:messages.map(message=>({
      sender:message.sender,text:message.text,messageId:message.key,
      replyTo:message.replyTo||"",replyToMessageId:message.replyToMessageId||"",messageTimestamp:message.timestamp||"",isReply:!!message.isReply,
      audioRef:message.audioRef||"",audioUrl:message.audioUrl||"",
      sourceTabId:tabId
    })),
    historyBatch:true,priority:groups.indexOf(group),announceGroup:true,sequence:Date.now()
  }];
  await enqueueSpeech(items);
  group.readHistory=true;
  await chrome.storage.local.set({[TEAMS_GROUPS_KEY]:groups});
  await setStatus("Queued "+messages.length+" recent message(s) from "+group.name+".");
  return publishLiveState();
}

async function hydrateSpeechQueue(options={}) {
  if(speechQueueLoaded) return;
  if(speechQueueHydration) {
    await speechQueueHydration;
    return;
  }

  const hydration=(async()=>{
    const saved=await chrome.storage.local.get([TEAMS_LIVE_KEY,"teamsSpeechQueue","teamsSpeechCurrent"]);
    speechQueue=(Array.isArray(saved.teamsSpeechQueue)?saved.teamsSpeechQueue:[])
      .map(normalizeSpeechBatch).filter(batch=>batch.messages.length>0);
    speechCurrent=saved.teamsSpeechCurrent?normalizeSpeechBatch(saved.teamsSpeechCurrent):null;
    speechQueueLoaded=true;

    if(!saved[TEAMS_LIVE_KEY]) return;

    // If the event that woke the service worker is the completion signal for
    // the persisted audio item, consume that signal instead of replaying it.
    if(
      speechCurrent?.phase==="audio" &&
      options.completedPlaybackId &&
      options.completedPlaybackId===speechCurrent.playbackId
    ) return;

    if(speechCurrent?.phase==="gap") {
      const sequence=speechCurrent.sequence;
      groupDelayTimer=setTimeout(()=>{
        if(speechCurrent?.sequence===sequence&&speechCurrent.phase==="gap") {
          speechCurrent.phase="message";
          persistSpeechQueue().then(speakCurrentPhase);
        }
      },5000);
      return;
    }

    if(speechCurrent) {
      const recovered=speechCurrent;
      try { chrome.tts.stop(); } catch (_) {}
      if(recovered.phase==="audio") {
        await stopTeamsAudio();
        if(speechCurrent!==recovered) return;
        recovered.phase="message";
        recovered.playbackId="";
      }
      await persistSpeechQueue();
      if(speechCurrent===recovered) speakCurrentPhase();
      return;
    }

    scheduleSpeechQueue();
  })();

  speechQueueHydration=hydration;
  try {
    await hydration;
  } finally {
    if(speechQueueHydration===hydration) speechQueueHydration=null;
  }
}
async function persistSpeechQueue() {
  await chrome.storage.local.set({
    teamsSpeechQueue:speechQueue,
    teamsSpeechCurrent:speechCurrent
  });
}
async function enqueueSpeech(items) {
  await hydrateSpeechQueue();
  for(const raw of items||[]){
    const batch=normalizeSpeechBatch(raw);
    if(!batch.messages.length) continue;
    let target=null;
    if(speechCurrent?.groupKey===batch.groupKey) target=speechCurrent;
    if(!target) target=speechQueue.find(item=>item.groupKey===batch.groupKey);
    if(target) {
      appendUniqueMessages(target,batch.messages);
    } else {
      batch.phase="group";
      batch.messageIndex=0;
      speechQueue.push(batch);
    }
  }
  await persistSpeechQueue();
  scheduleSpeechQueue();
}
function scheduleSpeechQueue() {
  if(speechCurrent||speechDispatchTimer||!speechQueue.length) return;
  speechDispatchTimer=setTimeout(()=>{
    speechDispatchTimer=null;
    processSpeechQueue();
  },850);
}
async function currentGroupPriority(groupKey) {
  const groups=await getStoredGroups();
  const index=groups.findIndex(group=>group.key===groupKey);
  return index<0?999:index;
}
async function processSpeechQueue() {
  if(speechProcessing) return;
  await hydrateSpeechQueue();
  if(speechCurrent||!speechQueue.length) return;
  speechProcessing=true;
  try{
    for(const item of speechQueue) item.priority=await currentGroupPriority(item.groupKey);
    speechQueue.sort((a,b)=>(a.priority-b.priority)||(a.sequence-b.sequence));
    speechCurrent=speechQueue.shift();
    speechCurrent.messageIndex=0;
    speechCurrent.phase="group";
    speechCurrent.playbackId="";
    await persistSpeechQueue();
    speakCurrentPhase();
  }finally{
    speechProcessing=false;
  }
}
function formattedMessage(message){
  const sender=message.sender||"Unknown sender";
  const body=String(message.text||"").trim();
  if(message.replyTo) return message.replyTo+" ke message ka reply "+sender+" ne diya"+(body?": "+body:"")+".";
  if(message.isReply) return sender+" ne ek purane message ka reply diya"+(body?": "+body:"")+".";
  return sender+" ne kaha"+(body?": "+body:"")+".";
}
function scheduleNextMessage(delay=350){
  if(!speechCurrent) return;
  const sequence=speechCurrent.sequence;
  if(speechAdvanceTimer) clearTimeout(speechAdvanceTimer);
  speechAdvanceTimer=setTimeout(()=>{
    speechAdvanceTimer=null;
    if(speechCurrent?.sequence!==sequence) return;
    speechCurrent.messageIndex++;
    if(speechCurrent.messageIndex<speechCurrent.messages.length){
      speechCurrent.phase="message";
      persistSpeechQueue().then(speakCurrentPhase);
    }else{
      finishCurrentSpeech();
    }
  },delay);
}
function startAudioPlayback(current,message){
  const tabId=message.sourceTabId;
  if(!Number.isInteger(tabId)){
    setStatus("Audio message detected, but its Teams player is not available in this tab.");
    scheduleNextMessage(350);
    return;
  }
  const playbackId=String(current.sequence)+":"+String(current.messageIndex)+":"+String(Date.now());
  current.phase="audio";
  current.playbackId=playbackId;
  persistSpeechQueue();
  chrome.tabs.sendMessage(tabId,{
    type:"TEAMS_PLAY_AUDIO",
    audioRef:message.audioRef||"",
    audioUrl:message.audioUrl||"",
    playbackId
  },response=>{
    if(chrome.runtime.lastError||!response?.ok){
      const error=chrome.runtime.lastError?.message||response?.error||"Audio player is not accessible.";
      setStatus("Could not play the Teams audio attachment: "+error);
      if(speechCurrent?.playbackId===playbackId) scheduleNextMessage(350);
      return;
    }
    setStatus("Playing audio attachment from "+current.groupName+". Speech is paused until audio ends.");
  });
}
function speakCurrentPhase() {
  if(!speechCurrent) return;
  const current=speechCurrent;
  if(current.phase==="gap"||current.phase==="audio") return;
  if(current.phase==="group"){
    speakText(current.groupName,{
      sequence:current.sequence,
      phase:"group"
    });
    return;
  }
  const message=current.messages[current.messageIndex];
  if(!message){finishCurrentSpeech();return;}
  if(message.audioRef||message.audioUrl){
    startAudioPlayback(current,message);
    return;
  }
  const text=formattedMessage(message);
  if(!text.replace(/[.:\s]/g,"")){scheduleNextMessage(100);return;}
  speakText(text,{sequence:current.sequence,phase:"message",sender:message.sender});
}
function speakText(text,context){
  const current=speechCurrent;
  if(!current||current.sequence!==context.sequence) return;
  const speakWithVoice=availableVoices=>{
    if(!speechCurrent||speechCurrent.sequence!==context.sequence) return;
    const voices=Array.isArray(availableVoices)?availableVoices:[];
    const voicesWithEnd=voices.filter(item=>Array.isArray(item.eventTypes)&&item.eventTypes.includes("end"));
    const voice=
      voicesWithEnd.find(item=>/^hi[-_]IN$/i.test(item.lang||""))||
      voicesWithEnd.find(item=>/^hi(?:[-_]|$)/i.test(item.lang||""))||
      voicesWithEnd.find(item=>/^en[-_]IN$/i.test(item.lang||""))||null;
    const options={
      enqueue:false,
      rate:context.phase==="group"?0.85:0.78,
      pitch:1,
      requiredEventTypes:["end"],
      desiredEventTypes:["start","end","error","interrupted","cancelled"],
      onEvent:event=>{
        if(!speechCurrent||speechCurrent.sequence!==context.sequence) return;
        if(event.type==="start"){
          setStatus(context.phase==="group"
            ?"Announcing group "+current.groupName
            :"Reading "+(context.sender||"sender")+" in "+current.groupName);
        }else if(event.type==="end"){
          if(context.phase==="group"){
            current.phase="gap";
            persistSpeechQueue().then(()=>{
              if(groupDelayTimer) clearTimeout(groupDelayTimer);
              groupDelayTimer=setTimeout(()=>{
                groupDelayTimer=null;
                if(speechCurrent?.sequence===context.sequence&&speechCurrent.phase==="gap"){
                  speechCurrent.phase="message";
                  persistSpeechQueue().then(speakCurrentPhase);
                }
              },5000);
            });
            setStatus("Group announced once. Waiting 5 seconds before its message batch.");
          }else if(current.phase==="message"){
            scheduleNextMessage(450);
          }
        }else if(["error","interrupted","cancelled"].includes(event.type)){
          if(event.type==="error") setStatus("Speech error: "+(event.errorMessage||"Chrome TTS could not read the message."));
          if(context.phase==="group") finishCurrentSpeech();
          else scheduleNextMessage(350);
        }
      }
    };
    if(voice?.voiceName){options.voiceName=voice.voiceName;options.lang=voice.lang;}
    else setStatus("No Hindi voice is installed. Trying the default Chrome speech voice.");
    chrome.tts.speak(text,options,()=>{
      if(chrome.runtime.lastError){
        setStatus("Chrome TTS error: "+chrome.runtime.lastError.message);
        if(context.phase==="group") finishCurrentSpeech();
        else scheduleNextMessage(350);
      }
    });
  };
  try{chrome.tts.getVoices(voices=>speakWithVoice(voices));}
  catch(error){
    setStatus("Could not load speech voices: "+error.message);
    speakWithVoice([]);
  }
}
async function finishCurrentSpeech() {
  speechCurrent=null;
  if(groupDelayTimer) clearTimeout(groupDelayTimer);
  if(speechAdvanceTimer) clearTimeout(speechAdvanceTimer);
  groupDelayTimer=null;
  speechAdvanceTimer=null;
  await persistSpeechQueue();
  scheduleSpeechQueue();
}
async function stopTeamsAudio(){
  for(const tab of await getTeamsTabs()){
    try{await chrome.tabs.sendMessage(tab.id,{type:"TEAMS_STOP_AUDIO"});}catch(_){}
  }
}
async function handleAudioPlaybackEvent(message,sender){
  if(!isTeamsContentSender(sender)) return;
  if(typeof message.playbackId!=="string"||message.playbackId.length>128) return;
  await hydrateSpeechQueue({completedPlaybackId:message.playbackId});
  if(!speechCurrent||speechCurrent.phase!=="audio"||speechCurrent.playbackId!==message.playbackId) return;
  if(message.type==="TEAMS_AUDIO_FAILED") await setStatus(message.error||"Teams audio playback failed.");
  scheduleNextMessage(350);
}
async function wasMessageProcessed(messageKey){
  if(!processedMessageIdsLoaded){
    const saved=await chrome.storage.local.get("teamsProcessedMessageIds");
    (Array.isArray(saved.teamsProcessedMessageIds)?saved.teamsProcessedMessageIds:[]).forEach(key=>processedMessageIds.add(key));
    processedMessageIdsLoaded=true;
  }
  if(processedMessageIds.has(messageKey)) return true;
  processedMessageIds.add(messageKey);
  if(processedMessageIds.size>10000){
    const keep=Array.from(processedMessageIds).slice(-8000);
    processedMessageIds.clear();
    keep.forEach(key=>processedMessageIds.add(key));
  }
  await chrome.storage.local.set({teamsProcessedMessageIds:Array.from(processedMessageIds)});
  return false;
}
async function onTeamsMessage(message,sender) {
  const normalizedMessage=normalizeTeamsLiveMessage(message);
  if(!normalizedMessage) return;
  message=normalizedMessage;

  const enabled=await chrome.storage.local.get(TEAMS_LIVE_KEY);
  if(!enabled[TEAMS_LIVE_KEY]) return;
  const groupKey=String(message.groupKey||"");
  const groups=await getStoredGroups();
  const group=groups.find(item=>item.key===groupKey);
  if(!group) return;

  if(!isTeamsContentSender(sender)) return;
  const tabId=sender.tab.id;

  const senderName=String(message.sender||"").trim();
  const text=String(message.text||"").trim();
  const audioRef=String(message.audioRef||"");
  const audioUrl=String(message.audioUrl||"");
  if(!senderName||(!text&&!audioRef&&!audioUrl)) return;

  const messageId=String(message.messageId||"");
  const fallbackIdentity=[senderName,text,audioRef,audioUrl,String(message.timestamp||"")].join("\u001f");
  const fallbackKey=messageId||("sha256:"+await createMessageFingerprint(fallbackIdentity));
  const stableKey=groupKey+"|"+fallbackKey;
  if(await wasMessageProcessed(stableKey)) return;
  const now=Date.now();

  // A stable Teams message ID is stronger than text similarity. Only use the
  // short-window text fallback when Teams did not expose a message ID.
  if(!messageId) {
    const recentTextKey=groupKey+"|"+senderName+"|"+text.toLocaleLowerCase()+"|"+String(!!(audioRef||audioUrl))+"|"+String(message.messageTimestamp||"");
    const recentAt=recentMessageIds.get(recentTextKey)||0;
    if(recentAt&&now-recentAt<5000) return;
    recentMessageIds.set(recentTextKey,now);
  }
  recentMessageIds.set(stableKey,now);
  if(recentMessageIds.size>5000){
    for(const [key,time] of recentMessageIds) if(now-time>120000) recentMessageIds.delete(key);
    if(recentMessageIds.size>5000) recentMessageIds.clear();
  }

  const entry={
    groupName:group.name,groupKey,sender:senderName,text,
    replyTo:String(message.replyTo||""),
    replyToMessageId:String(message.replyToMessageId||""),
    messageTimestamp:String(message.messageTimestamp||""),
    isReply:!!message.isReply,
    audioRef,audioUrl,
    sourceTabId:tabId,
    messageId:messageId||stableKey,
    receivedAt:now
  };
  const saved=await chrome.storage.local.get([TEAMS_READ_COUNT,TEAMS_RECENT_EVENTS]);
  const recent=[entry,...(saved[TEAMS_RECENT_EVENTS]||[])].slice(0,8);
  await chrome.storage.local.set({
    [TEAMS_READ_COUNT]:(saved[TEAMS_READ_COUNT]||0)+1,
    [TEAMS_RECENT_EVENTS]:recent,
    teamsLastStatus:audioRef||audioUrl
      ?"Audio message detected in "+group.name+"."
      :"New message in "+group.name+" from "+senderName+"."
  });
  await enqueueSpeech([{
    groupKey,groupName:group.name,
    messages:[{
      sender:senderName,text,messageId:entry.messageId,
      replyTo:entry.replyTo,replyToMessageId:entry.replyToMessageId,messageTimestamp:entry.messageTimestamp,isReply:entry.isReply,
      audioRef,audioUrl,sourceTabId:tabId
    }],
    priority:groups.indexOf(group),
    sequence:now
  }]);
  await publishLiveState();
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.type==="GET_CHATGPT_CONVERSATIONS") {
    listChatGPTConversations().then(conversations=>sendResponse({ok:true,conversations}))
      .catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==="GET_CHATGPT_PROMPT_JOBS") {
    getStoredPromptJobs().then(jobs=>sendResponse({ok:true,jobs}))
      .catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==="CREATE_CHATGPT_PROMPT_JOB") {
    createChatGPTPromptJob(message).then(async job=>{
      sendResponse({ok:true,job,state:await publishPromptJobs()});
    }).catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  const promptActions={
    PAUSE_CHATGPT_PROMPT_JOB:"pause",
    STOP_CHATGPT_PROMPT_JOB:"stop",
    RESUME_CHATGPT_PROMPT_JOB:"resume",
    RESOLVE_CHATGPT_PROMPT_JOB:"resolve"
  };
  if(promptActions[message?.type]) {
    mutatePromptJob(message.jobId,promptActions[message.type],message.decision)
      .then(async job=>sendResponse({ok:true,job,state:await publishPromptJobs()}))
      .catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(
    ["CHATGPT_TAB_READY","CHATGPT_RESPONSE_COMPLETED","CHATGPT_RESPONSE_UNCERTAIN"].includes(message?.type) &&
    isChatGPTContentSender(sender)
  ) {
    handleChatGPTContentEvent(message,sender).catch(()=>{});
  }

  if(message?.type==="GET_TEAMS_LIVE_STATUS") {
    getLiveState().then(sendResponse).catch(error=>sendResponse({teamsLastStatus:error.message}));
    return true;
  }
  if(message?.type==="SET_TEAMS_LIVE") {
    setTeamsLiveEnabled(!!message.enabled).then(sendResponse).catch(error=>sendResponse({teamsLastStatus:error.message}));
    return true;
  }
  if(message?.type==="ADD_CURRENT_TEAMS_GROUP") {
    addCurrentGroup().then(async result=>sendResponse({...result,state:await publishLiveState()}))
      .catch(error=>sendResponse({ok:false,error:error.message}));
    return true;
  }
  if(message?.type==="REMOVE_TEAMS_GROUP") {
    removeGroup(message.groupKey).then(sendResponse).catch(error=>sendResponse({error:error.message}));
    return true;
  }
  if(message?.type==="REORDER_TEAMS_GROUPS") {
    reorderGroups(message.order).then(sendResponse).catch(error=>sendResponse({error:error.message}));
    return true;
  }
  if(message?.type==="READ_LAST_FIVE_TEAMS_MESSAGES") {
    readLastFive(message.groupKey).then(sendResponse).catch(error=>sendResponse({error:error.message}));
    return true;
  }
  if(message?.type==="TEAMS_LIVE_MESSAGE" && isTeamsContentSender(sender)) {
    onTeamsMessage(message,sender).catch(error=>setStatus("Teams message pipeline error: "+error.message));
  }
  if(
    (message?.type==="TEAMS_AUDIO_ENDED"||message?.type==="TEAMS_AUDIO_FAILED") &&
    isTeamsContentSender(sender)
  ) {
    handleAudioPlaybackEvent(message,sender).catch(()=>{});
  }
  if(message?.type==="TEAMS_LIVE_STATUS" && isTeamsContentSender(sender)) {
    const text=typeof message.text==="string"?message.text.slice(0,500):"";
    if(text) chrome.storage.local.set({teamsLastStatus:text});
  }
});


chrome.tabs.onUpdated.addListener(async(tabId,changeInfo,tab)=>{
  if(changeInfo.status!=="complete") return;
  if(chatgptUrl(tab?.url)) {
    const jobs=await getStoredPromptJobs();
    const hasPending=jobs.some(job=>job.tabId===tabId&&job.status==="awaiting_response");
    if(hasPending) {
      try {
        const info=await getChatGPTTabInfo(tabId);
        await resumePromptMonitorsForTab(tabId,info.conversationId);
      } catch (_) {}
    }
    return;
  }
  if(!teamsUrl(tab?.url)) return;
  const enabled=await chrome.storage.local.get(TEAMS_LIVE_KEY);
  if(enabled[TEAMS_LIVE_KEY]) {
    try {
      await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},files:["teams-content.js"]});
      await setStatus("Teams notification observer attached to the open Teams tab.");
    } catch(error) {
      await setStatus("Could not attach Teams notification observer: "+error.message);
    }
  }
});
chrome.tabs.onRemoved.addListener(async tabId=>{
  const groups=await getStoredGroups();
  let changed=false;
  for(const group of groups) {
    const before=(group.tabIds||[]).length;
    group.tabIds=(group.tabIds||[]).filter(id=>id!==tabId);
    if(before!==group.tabIds.length) changed=true;
    if(group.lastAddedTabId===tabId){group.lastAddedTabId=null;changed=true;}
    if(group.monitorTabId===tabId){group.monitorTabId=null;changed=true;}
  }
  if(changed) await chrome.storage.local.set({[TEAMS_GROUPS_KEY]:groups});
  await handlePromptTabRemoved(tabId);
  publishLiveState();
});
chrome.runtime.onStartup.addListener(async()=>{
  const enabled=await chrome.storage.local.get(TEAMS_LIVE_KEY);
  if(enabled[TEAMS_LIVE_KEY]) {
    const result=await injectTeamsTabs();
    await setStatus("Teams notification observers restored: "+result.injected+"/"+result.total+" tab(s).");
  }
  await recoverPromptJobs();
});
chrome.runtime.onInstalled.addListener(async()=>{
  const enabled=await chrome.storage.local.get(TEAMS_LIVE_KEY);
  if(enabled[TEAMS_LIVE_KEY]) {
    const result=await injectTeamsTabs();
    await setStatus("Teams notification observers attached: "+result.injected+"/"+result.total+" tab(s).");
  }
  await recoverPromptJobs();
});
