(() => {
  const STATE_KEY="__aliensBceChatGPTBridgeV1";
  if(window[STATE_KEY]) return;

  const state=window[STATE_KEY]={
    monitors:new Map(),
    pendingSends:new Map()
  };

  const ALLOWED_HOSTS=new Set(["chatgpt.com","chat.openai.com"]);
  const clean=value=>String(value||"").replace(/\u200b/g,"").replace(/\u00a0/g," ").replace(/\s+/g," ").trim();
  const normalize=value=>clean(value).normalize("NFKC");
  const visible=node=>!!node&&node.getClientRects().length>0;
  const now=()=>Date.now();

  function conversationId(){
    const match=location.pathname.match(/(?:^|\/)c\/([A-Za-z0-9_-]{8,})(?:\/|$)/);
    return match?decodeURIComponent(match[1]):"";
  }

  function pageTitle(){
    return clean(document.title)
      .replace(/\s*[|—-]\s*ChatGPT\s*$/i,"")
      .slice(0,180);
  }

  function composer(){
    const selectors=[
      '[data-testid="composer-text-input"]',
      "#prompt-textarea",
      '[contenteditable="true"][data-testid*="composer" i]',
      '[contenteditable="true"][data-placeholder]',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="ask" i]',
      'textarea[placeholder*="prompt" i]'
    ];
    for(const selector of selectors){
      const node=Array.from(document.querySelectorAll(selector)).find(candidate=>{
        if(!visible(candidate)) return false;
        const placeholder=clean(candidate.getAttribute("placeholder")||candidate.getAttribute("data-placeholder"));
        return selector.includes("composer")||selector.includes("prompt-textarea")||/message|ask|prompt|chat/i.test(placeholder);
      });
      if(node) return node;
    }
    return null;
  }

  function sendButton(input=composer()){
    if(!input) return null;
    const form=input.closest("form");
    if(!form) return null;
    const candidates=[
      form.querySelector('button[data-testid="send-button"]'),
      form.querySelector('button[data-testid*="send" i]'),
      form.querySelector('button[aria-label*="send" i]'),
      form.querySelector('button[type="submit"]')
    ];
    return candidates.find(node=>visible(node)&&!node.disabled&&node.getAttribute("aria-disabled")!=="true")||null;
  }

  function extractMessageText(node,role){
    const turn=node.closest('[data-testid^="conversation-turn-"]')||node.closest("article")||node;
    let content=node;
    if(role==="user"){
      content=turn.querySelector("[data-user-message-bubble]")||
        turn.querySelector(".whitespace-pre-wrap")||
        turn.querySelector("[data-message-content]")||node;
    }else{
      content=turn.querySelector('[data-markdown-text-style="assistant-message"]')||
        turn.querySelector(".markdown")||
        turn.querySelector("[data-message-content]")||node;
    }
    const clone=content.cloneNode(true);
    clone.querySelectorAll("button,[role='button'],svg,script,style,nav,[aria-hidden='true'],[data-testid*='toolbar'],[data-testid*='action']").forEach(item=>item.remove());
    return clean(clone.innerText||clone.textContent);
  }

  function messageRecords(role){
    const selectors=role==="assistant"
      ? ['[data-conversation-role="assistant"]','[data-message-author-role="assistant"]']
      : ['[data-conversation-role="user"]','[data-message-author-role="user"]'];
    let nodes=[];
    for(const selector of selectors){
      nodes=Array.from(document.querySelectorAll(selector)).filter(visible);
      if(nodes.length) break;
    }
    const roleAttr=nodes[0]?.hasAttribute("data-conversation-role")
      ?"data-conversation-role":"data-message-author-role";
    const unique=nodes.filter(node=>{
      const roleValue=node.getAttribute(roleAttr);
      return !node.parentElement?.closest("["+roleAttr+'="'+roleValue+'"]');
    });
    return unique.map((node,index)=>{
      const turn=node.closest('[data-testid^="conversation-turn-"]')||node.closest("article")||node;
      const text=extractMessageText(node,role);
      const key=turn.getAttribute("data-testid")||turn.id||node.id||
        role+"-"+index+"-"+text.slice(0,80);
      return {key,text,index};
    }).filter(item=>item.text);
  }

  function textFingerprint(value){
    let hash=2166136261;
    for(let index=0;index<value.length;index++){
      hash^=value.charCodeAt(index);
      hash=Math.imul(hash,16777619);
    }
    return (hash>>>0).toString(36);
  }

  function assistantSnapshot(){
    const records=messageRecords("assistant");
    const last=records[records.length-1]||null;
    return {
      count:records.length,
      lastKey:last?.key||"",
      lastHash:last?textFingerprint(last.text):"",
      lastLength:last?.text.length||0
    };
  }

  function userSnapshot(){
    const records=messageRecords("user");
    const last=records[records.length-1]||null;
    return {
      count:records.length,
      lastKey:last?.key||"",
      lastHash:last?textFingerprint(last.text):"",
      lastLength:last?.text.length||0
    };
  }

  function snapshot(){
    return {
      assistant:assistantSnapshot(),
      user:userSnapshot(),
      conversationId:conversationId()
    };
  }

  function pageInfo(){
    const id=conversationId();
    const input=composer();
    return {
      ok:ALLOWED_HOSTS.has(location.hostname)&&!!id,
      conversationId:id,
      title:pageTitle(),
      url:location.href,
      composerAvailable:!!input,
      sendAvailable:!!sendButton(input),
      generating:stopSignalVisible(),
      assistantMessageCount:assistantSnapshot().count
    };
  }

  function setComposerText(input,text){
    input.focus();
    if(input instanceof HTMLTextAreaElement||input instanceof HTMLInputElement){
      const prototype=input instanceof HTMLTextAreaElement
        ?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(prototype,"value")?.set;
      if(!setter) return false;
      setter.call(input,text);
      input.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:text}));
      return normalize(input.value)===normalize(text);
    }

    if(input.isContentEditable){
      try{
        document.execCommand("selectAll",false);
        document.execCommand("insertText",false,text);
      }catch(_){}
      if(normalize(input.innerText||input.textContent)===normalize(text)) return true;
      return false;
    }
    return false;
  }

  function waitForUserEcho(prompt,baselineCount,timeoutMs=10000){
    return new Promise(resolve=>{
      const started=now();
      let settled=false;
      let observer=null;
      const finish=result=>{
        if(settled) return;
        settled=true;
        observer?.disconnect();
        clearInterval(poller);
        clearTimeout(timer);
        resolve(result);
      };
      const scan=()=>{
        const users=messageRecords("user");
        const newMessages=users.slice(baselineCount);
        if(newMessages.length){
          const match=newMessages.find(item=>normalize(item.text)===normalize(prompt));
          if(match){
            finish({ok:true,record:match,count:users.length});
            return;
          }
          if(now()-started>1200){
            finish({ok:false,error:"A different user message appeared after the send attempt. The send result is ambiguous; the job needs review."});
          }
        }
      };
      observer=new MutationObserver(scan);
      observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true});
      const poller=setInterval(scan,250);
      const timer=setTimeout(()=>{
        finish({ok:false,uncertain:true,error:"ChatGPT did not expose a matching user-message confirmation within 10 seconds. Check the conversation before retrying."});
      },timeoutMs);
      scan();
    });
  }

  function stopSignalVisible(){
    const selectors=[
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop" i]',
      'button[aria-label*="stop generating" i]',
      'button[aria-label="Stop"]',
      'button[title*="stop generating" i]',
      '[data-is-streaming="true"]',
      '[data-message-status="streaming"]',
      '[aria-busy="true"][data-message-author-role="assistant"]',
      '[aria-busy="true"][data-conversation-role="assistant"]'
    ];
    return selectors.some(selector=>Array.from(document.querySelectorAll(selector)).some(visible));
  }

  function stopMonitor(jobId){
    const monitor=state.monitors.get(jobId);
    if(monitor){
      monitor.observer?.disconnect();
      clearInterval(monitor.poller);
      clearTimeout(monitor.timeout);
      state.monitors.delete(jobId);
    }
    // Also clear a send record when monitor creation failed before registration.
    state.pendingSends.delete(jobId);
  }

  function sendRuntime(type,payload){
    try{
      chrome.runtime.sendMessage({type,...payload},()=>void chrome.runtime.lastError);
    }catch(_){}
  }

  function startMonitor(message){
    const {jobId,token,conversationId:expectedConversationId,baseline,prompt}=message||{};
    if(typeof jobId!=="string"||typeof token!=="string"||!baseline) {
      return {ok:false,error:"The response-monitor request is incomplete."};
    }
    if(conversationId()!==expectedConversationId) {
      return {ok:false,error:"This tab is no longer on the ChatGPT conversation assigned to this job."};
    }
    const existing=state.monitors.get(jobId);
    if(existing&&existing.token===token) return {ok:true,alreadyMonitoring:true};
    if(existing) stopMonitor(jobId);

    const monitor={
      jobId,token,conversationId:expectedConversationId,baseline,prompt,
      startedAt:now(),lastFingerprint:"",lastChangeAt:now(),
      sawNewAssistant:false,completed:false,observer:null,poller:null,timeout:null
    };

    function scan(){
      if(monitor.completed||state.monitors.get(jobId)!==monitor) return;
      if(conversationId()!==monitor.conversationId){
        monitor.completed=true;
        stopMonitor(jobId);
        sendRuntime("CHATGPT_RESPONSE_UNCERTAIN",{
          jobId,token,conversationId:monitor.conversationId,
          reason:"The ChatGPT tab navigated to a different conversation while the response was pending."
        });
        return;
      }

      const current=snapshot();
      const assistant=current.assistant;
      const users=current.user;

      if(users.count>baseline.sentUserCount||
        (users.count===baseline.sentUserCount&&users.lastKey&&users.lastKey!==baseline.sentUserKey)){
        monitor.completed=true;
        stopMonitor(jobId);
        sendRuntime("CHATGPT_RESPONSE_UNCERTAIN",{
          jobId,token,conversationId:monitor.conversationId,
          reason:"Another user message appeared while this prompt was awaiting a response."
        });
        return;
      }

      const isNewAssistant=assistant.count>baseline.assistantCount||
        (assistant.lastKey&&assistant.lastKey!==baseline.assistantKey)||
        (assistant.lastHash&&assistant.lastHash!==baseline.assistantHash);
      if(isNewAssistant&&assistant.lastLength>0){
        monitor.sawNewAssistant=true;
      }

      const fingerprint=[assistant.count,assistant.lastKey,assistant.lastHash,assistant.lastLength,stopSignalVisible()].join("|");
      if(fingerprint!==monitor.lastFingerprint){
        monitor.lastFingerprint=fingerprint;
        monitor.lastChangeAt=now();
      }

      const generating=stopSignalVisible();
      const stableFor=now()-monitor.lastChangeAt;
      const age=now()-monitor.startedAt;
      if(monitor.sawNewAssistant&&!generating&&assistant.lastLength>0&&stableFor>=5000&&age>=5000){
        monitor.completed=true;
        stopMonitor(jobId);
        sendRuntime("CHATGPT_RESPONSE_COMPLETED",{
          jobId,token,conversationId:monitor.conversationId,
          completedAt:now(),
          responseLength:assistant.lastLength
        });
      }
    }

    state.monitors.set(jobId,monitor);
    monitor.observer=new MutationObserver(scan);
    monitor.observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true});
    monitor.poller=setInterval(scan,700);
    monitor.timeout=setTimeout(()=>{
      if(state.monitors.get(jobId)!==monitor) return;
      monitor.completed=true;
      stopMonitor(jobId);
      sendRuntime("CHATGPT_RESPONSE_UNCERTAIN",{
        jobId,token,conversationId:monitor.conversationId,
        reason:"No verified assistant completion was detected within 30 minutes. Check the conversation manually."
      });
    },30*60*1000);
    scan();
    return {ok:true,monitoring:true};
  }

  async function sendPrompt(message){
    const jobId=String(message.jobId||"");
    const token=String(message.token||"");
    const targetConversationId=String(message.conversationId||"");
    const prompt=typeof message.prompt==="string"?message.prompt.trim():"";

    if(!jobId||jobId.length>128||!token||token.length>128||!prompt||prompt.length>50000) {
      return {ok:false,error:"The prompt-send request contains invalid fields."};
    }
    if(!ALLOWED_HOSTS.has(location.hostname)||conversationId()!==targetConversationId) {
      return {ok:false,error:"This tab does not match the requested ChatGPT conversation."};
    }
    const anotherJobOwnsConversation=
      Array.from(state.monitors.values()).some(monitor=>
        monitor.conversationId===targetConversationId&&!monitor.completed&&monitor.jobId!==jobId
      )||
      Array.from(state.pendingSends.entries()).some(([activeJobId,pending])=>
        activeJobId!==jobId&&pending.conversationId===targetConversationId
      );
    if(stopSignalVisible()||anotherJobOwnsConversation) {
      return {ok:false,error:"ChatGPT is already generating a response or another prompt is active in this conversation. No prompt was sent."};
    }

    const existing=state.pendingSends.get(jobId);
    if(existing){
      if(existing.token!==token) return {ok:false,error:"A different send token is already active for this job."};
      return {ok:true,alreadySent:true,sendConfirmed:!!existing.echoConfirmed,baseline:existing.baseline};
    }

    const input=composer();
    const button=sendButton(input);
    if(!input||!button) return {ok:false,error:"ChatGPT composer or enabled Send button was not found. No prompt was sent."};

    const before=snapshot();
    if(!setComposerText(input,prompt)) {
      return {ok:false,error:"Could not reliably enter the prompt into the ChatGPT composer. No send was attempted."};
    }

    await new Promise(resolve=>setTimeout(resolve,120));
    const readyButton=sendButton(input);
    if(!readyButton) {
      return {ok:false,error:"The ChatGPT Send control did not become available after entering the prompt."};
    }

    const pending={
      token,
      conversationId:targetConversationId,
      prompt,
      echoConfirmed:false,
      baseline:{
        assistantCount:before.assistant.count,
        assistantKey:before.assistant.lastKey,
        assistantHash:before.assistant.lastHash,
        assistantLength:before.assistant.lastLength,
        userCount:before.user.count,
        sentUserCount:0,
        sentUserKey:""
      }
    };
    state.pendingSends.set(jobId,pending);
    readyButton.click();

    const echo=await waitForUserEcho(prompt,before.user.count);
    if(!echo.ok) {
      return {
        ok:false,
        uncertain:true,
        baseline:pending.baseline,
        error:echo.error||"The prompt may have been sent, but the user-message acknowledgement could not be verified."
      };
    }

    pending.echoConfirmed=true;
    pending.baseline.sentUserCount=echo.count;
    pending.baseline.sentUserKey=echo.record.key;
    return {ok:true,baseline:pending.baseline};
  }

  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(message?.type==="CHATGPT_GET_CONVERSATION_INFO"){
      sendResponse(pageInfo());
      return true;
    }
    if(message?.type==="CHATGPT_SEND_PROMPT"){
      sendPrompt(message).then(sendResponse).catch(error=>sendResponse({ok:false,error:error?.message||"Prompt send failed."}));
      return true;
    }
    if(message?.type==="CHATGPT_START_RESPONSE_MONITOR"){
      sendResponse(startMonitor(message));
      return true;
    }
    if(message?.type==="CHATGPT_STOP_RESPONSE_MONITOR"){
      const jobId=String(message.jobId||"");
      stopMonitor(jobId);
      state.pendingSends.delete(jobId);
      sendResponse({ok:true});
      return true;
    }
  });

  if(ALLOWED_HOSTS.has(location.hostname)){
    const info=pageInfo();
    if(info.conversationId){
      sendRuntime("CHATGPT_TAB_READY",{
        conversationId:info.conversationId,
        title:info.title,
        url:info.url,
        composerAvailable:info.composerAvailable,
        sendAvailable:info.sendAvailable
      });
    }
  }
})();
