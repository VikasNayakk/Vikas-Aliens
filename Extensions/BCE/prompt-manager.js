const $=id=>document.getElementById(id);
let conversations=[];
let jobs=[];
const selectedTabs=new Set();
let busy=false;

function setStatus(message,isError=false){
  $("connectionState").textContent=message;
  $("connectionState").style.color=isError?"#b43d4b":"";
}
function messageStatus(message,isError=false){
  $("createStatus").textContent=message;
  $("createStatus").style.color=isError?"#b43d4b":"";
}
async function request(type,payload={}){
  const result=await chrome.runtime.sendMessage({type,...payload});
  if(!result) throw new Error("The extension service worker did not return a response.");
  if(result.ok===false) throw new Error(result.error||"The request was rejected.");
  return result;
}
function setBusy(value){
  busy=value;
  $("createJobs").disabled=value||selectedTabs.size===0||!$("promptText").value.trim();
}
function renderConversations(){
  const root=$("conversations");
  root.replaceChildren();
  const available=conversations.filter(item=>item.composerAvailable&&item.sendAvailable&&!item.generating);
  if(!available.length){
    const empty=document.createElement("div");
    empty.className="pm-empty";
    empty.textContent=conversations.length
      ?"No conversation is ready. Finish any active ChatGPT response and refresh."
      :"Open one or more ChatGPT conversation tabs, then refresh this list.";
    root.append(empty);
    $("selectAll").checked=false;
    $("selectAll").disabled=true;
    $("selectedCount").textContent="0 selected";
    setBusy(false);
    return;
  }

  available.forEach(item=>{
    const label=document.createElement("label");
    label.className="pm-conversation";
    const checkbox=document.createElement("input");
    checkbox.type="checkbox";
    checkbox.checked=selectedTabs.has(item.tabId);
    checkbox.addEventListener("change",()=>{
      if(checkbox.checked) selectedTabs.add(item.tabId);
      else selectedTabs.delete(item.tabId);
      updateSelectionState();
    });

    const info=document.createElement("div");
    info.className="pm-conv-info";
    const title=document.createElement("div");
    title.className="pm-conv-title";
    title.textContent=item.title||"ChatGPT conversation";
    const meta=document.createElement("div");
    meta.className="pm-conv-meta";
    const id=document.createElement("span");
    id.textContent=item.conversationId.slice(0,18)+"…";
    meta.append(id);
    if(item.active){
      const tag=document.createElement("span");
      tag.className="pm-tag active";
      tag.textContent="Active tab";
      meta.append(tag);
    }
    const ready=document.createElement("span");
    ready.className="pm-tag";
    ready.textContent="Ready to send";
    meta.append(ready);
    info.append(title,meta);
    label.append(checkbox,info);
    root.append(label);
  });
  $("selectAll").disabled=false;
  updateSelectionState();
}
function updateSelectionState(){
  const available=conversations.filter(item=>item.composerAvailable&&item.sendAvailable&&!item.generating);
  const availableIds=new Set(available.map(item=>item.tabId));
  for(const id of [...selectedTabs]) if(!availableIds.has(id)) selectedTabs.delete(id);
  const count=selectedTabs.size;
  $("selectedCount").textContent=count+" selected";
  $("selectAll").checked=available.length>0&&available.every(item=>selectedTabs.has(item.tabId));
  $("selectAll").indeterminate=count>0&&count<available.length;
  setBusy(busy);
}
async function refreshConversations(){
  $("refreshConversations").disabled=true;
  $("conversationSummary").textContent="Checking open tabs…";
  try{
    const result=await request("GET_CHATGPT_CONVERSATIONS");
    conversations=Array.isArray(result.conversations)?result.conversations:[];
    const available=conversations.filter(item=>item.composerAvailable&&item.sendAvailable&&!item.generating).length;
    $("conversationSummary").textContent=conversations.length+" detected · "+available+" ready";
    renderConversations();
    setStatus("Connected to BCE extension");
  }catch(error){
    conversations=[];
    selectedTabs.clear();
    renderConversations();
    $("conversationSummary").textContent="Could not read open conversations";
    setStatus("Extension connection error",true);
    messageStatus(error.message,true);
  }finally{
    $("refreshConversations").disabled=false;
  }
}
function statusLabel(status){
  return ({
    queued:"Queued",
    sending:"Sending",
    awaiting_response:"Waiting for response",
    needs_review:"Needs review",
    paused:"Paused",
    completed:"Completed",
    stopped:"Stopped",
    failed:"Failed"
  })[status]||status;
}
function createActionButton(label,jobId,action,decision,variant=""){
  const button=document.createElement("button");
  button.type="button";
  button.className="pm-action"+(variant?" "+variant:"");
  button.textContent=label;
  button.addEventListener("click",()=>runJobAction(jobId,action,decision,button));
  return button;
}
function renderJob(job){
  const card=document.createElement("article");
  card.className="pm-job";

  const top=document.createElement("div");
  top.className="pm-job-top";
  const title=document.createElement("div");
  title.className="pm-job-title";
  const convo=conversations.find(item=>item.conversationId===job.conversationId);
  title.textContent=convo?.title||("Conversation "+job.conversationId.slice(0,12)+"…");
  const status=document.createElement("span");
  status.className="pm-status "+job.status;
  status.textContent=statusLabel(job.status);
  top.append(title,status);

  const meta=document.createElement("div");
  meta.className="pm-job-meta";
  const repeat=job.repeatLimit===null?"Unlimited":String(job.repeatLimit)+" runs";
  meta.textContent=repeat+" · "+job.completedCount+" completed · "+job.sentCount+" sent";
  const prompt=document.createElement("div");
  prompt.className="pm-job-prompt";
  prompt.textContent=job.prompt;

  const progress=document.createElement("div");
  progress.className="pm-progress";
  const fill=document.createElement("span");
  const percent=job.repeatLimit===null
    ?(job.completedCount===0?0:Math.min(100,job.completedCount%100))
    :(job.repeatLimit>0?Math.min(100,job.completedCount/job.repeatLimit*100):0);
  fill.style.width=percent+"%";
  progress.append(fill);
  if(job.repeatLimit===null) progress.hidden=true;
  const foot=document.createElement("div");
  foot.className="pm-job-foot";
  foot.textContent=job.repeatLimit===null
    ?job.completedCount+" responses completed · continues until stopped"
    :job.completedCount+" of "+job.repeatLimit+" responses completed";

  card.append(top,meta,prompt,progress,foot);

  if(job.lastError){
    const error=document.createElement("div");
    error.className="pm-job-error";
    error.textContent=job.lastError;
    card.append(error);
  }

  const actions=document.createElement("div");
  actions.className="pm-actions";
  if(job.status==="queued"){
    actions.append(createActionButton("Pause",job.id,"pause",null));
    actions.append(createActionButton("Stop",job.id,"stop",null,"danger"));
  }else if(job.status==="paused"){
    actions.append(createActionButton("Resume",job.id,"resume",null,"primary"));
    actions.append(createActionButton("Stop",job.id,"stop",null,"danger"));
  }else if(job.status==="sending"||job.status==="awaiting_response"){
    actions.append(createActionButton("Pause after response",job.id,"pause",null));
    actions.append(createActionButton("Stop after response",job.id,"stop",null,"danger"));
  }else if(job.status==="needs_review"){
    if(job.uncertaintyKind==="response"){
      actions.append(createActionButton("Confirm completed",job.id,"resolve","confirm_completed","primary"));
      actions.append(createActionButton("Continue waiting",job.id,"resolve","continue_waiting","warning"));
      actions.append(createActionButton("Stop job",job.id,"resolve","stop_job","danger"));
      actions.append(createActionButton("Mark failed",job.id,"resolve","confirm_failed"));
    }else{
      actions.append(createActionButton("Confirm prompt sent",job.id,"resolve","confirm_sent","primary"));
      actions.append(createActionButton("Confirm not sent",job.id,"resolve","confirm_not_sent","warning"));
      actions.append(createActionButton("Stop job",job.id,"resolve","stop_job","danger"));
    }
  }
  if(actions.children.length) card.append(actions);
  return card;
}
function renderJobs(){
  const root=$("jobs");
  root.replaceChildren();
  const terminal=["completed","stopped","failed"];
  const queued=jobs.filter(job=>job.status==="queued"||job.status==="paused").length;
  const active=jobs.filter(job=>["sending","awaiting_response"].includes(job.status)).length;
  const review=jobs.filter(job=>job.status==="needs_review").length;
  $("queuedCount").textContent=String(queued);
  $("activeCount").textContent=String(active);
  $("reviewCount").textContent=String(review);
  if(!jobs.length){
    const empty=document.createElement("div");
    empty.className="pm-empty";
    empty.textContent="No prompt jobs yet. Create one from the panel on the left.";
    root.append(empty);
    return;
  }
  [...jobs].sort((a,b)=>b.createdAt-a.createdAt).forEach(job=>root.append(renderJob(job)));
}
async function refreshJobs(){
  $("refreshJobs").disabled=true;
  try{
    const result=await request("GET_CHATGPT_PROMPT_JOBS");
    jobs=Array.isArray(result.jobs)?result.jobs:[];
    renderJobs();
  }catch(error){
    setStatus("Could not load prompt jobs",true);
    messageStatus(error.message,true);
  }finally{
    $("refreshJobs").disabled=false;
  }
}
async function runJobAction(jobId,action,decision,button){
  button.disabled=true;
  try{
    await request(
      action==="pause"?"PAUSE_CHATGPT_PROMPT_JOB":
      action==="stop"?"STOP_CHATGPT_PROMPT_JOB":
      action==="resume"?"RESUME_CHATGPT_PROMPT_JOB":
      "RESOLVE_CHATGPT_PROMPT_JOB",
      {jobId,decision}
    );
    await refreshJobs();
    messageStatus("Job updated.");
  }catch(error){
    messageStatus(error.message,true);
    button.disabled=false;
  }
}
$("promptText").addEventListener("input",()=>{
  $("promptLength").textContent=$("promptText").value.length.toLocaleString()+" / 50,000";
  setBusy(busy);
});
$("repeatCount").addEventListener("input",()=>setBusy(busy));
$("unlimited").addEventListener("change",()=>{
  $("repeatCountWrap").hidden=$("unlimited").checked;
});
$("selectAll").addEventListener("change",()=>{
  const available=conversations.filter(item=>item.composerAvailable&&item.sendAvailable&&!item.generating);
  selectedTabs.clear();
  if($("selectAll").checked) available.forEach(item=>selectedTabs.add(item.tabId));
  renderConversations();
});
$("refreshConversations").addEventListener("click",refreshConversations);
$("refreshJobs").addEventListener("click",refreshJobs);
$("createJobs").addEventListener("click",async()=>{
  const prompt=$("promptText").value.trim();
  const tabIds=[...selectedTabs];
  if(!prompt){messageStatus("Enter a prompt first.",true);return;}
  if(!tabIds.length){messageStatus("Select at least one ChatGPT conversation.",true);return;}
  const repeatLimit=$("unlimited").checked?null:Number($("repeatCount").value);
  if(repeatLimit!==null&&(!Number.isInteger(repeatLimit)||repeatLimit<1||repeatLimit>100000)){
    messageStatus("Repeat count must be between 1 and 100,000.",true);
    return;
  }
  setBusy(true);
  messageStatus("Creating "+tabIds.length+" prompt job(s)…");
  const results=await Promise.all(tabIds.map(async tabId=>{
    try{
      const result=await request("CREATE_CHATGPT_PROMPT_JOB",{tabId,prompt,repeatLimit});
      return {ok:true,title:conversations.find(item=>item.tabId===tabId)?.title||result.job.conversationId};
    }catch(error){
      return {ok:false,error:error.message};
    }
  }));
  const created=results.filter(item=>item.ok).length;
  const errors=results.filter(item=>!item.ok);
  messageStatus(
    created+" job(s) created"+(errors.length?"; "+errors.length+" could not be created: "+errors.map(item=>item.error).join(" | "):"."),
    errors.length>0
  );
  selectedTabs.clear();
  $("promptText").value="";
  $("promptLength").textContent="0 / 50,000";
  await Promise.all([refreshConversations(),refreshJobs()]);
  setBusy(false);
});
chrome.runtime.onMessage.addListener(message=>{
  if(message?.type==="CHATGPT_PROMPT_JOBS_UPDATED"&&Array.isArray(message.state?.jobs)){
    jobs=message.state.jobs;
    renderJobs();
  }
});
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==="local"&&changes.chatgptPromptJobs) refreshJobs();
});
Promise.all([refreshConversations(),refreshJobs()]);
