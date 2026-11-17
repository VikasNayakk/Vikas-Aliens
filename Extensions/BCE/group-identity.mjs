function normalizedString(value,maxLength=512) {
  return typeof value==="string" ? value.trim().slice(0,maxLength) : "";
}

export function resolveTeamsGroupIdentity(groups, info, tabId) {
  const list=Array.isArray(groups)?groups:[];
  const groupKey=normalizedString(info?.groupKey,256);
  const groupName=normalizedString(info?.groupName,256);
  const chatId=normalizedString(info?.chatId,512);

  if(!groupKey||!groupName||!Number.isInteger(tabId)) {
    return {ok:false,error:"Teams group identity information is incomplete."};
  }
  if(chatId&&!/^19:/i.test(chatId)) {
    return {ok:false,error:"Teams returned an unexpected conversation ID format."};
  }

  const byName=list.find(group=>group?.key===groupKey)||null;
  const byChatId=chatId
    ? list.find(group=>group?.chatId===chatId)||null
    : null;

  if(byName&&byChatId&&byName!==byChatId) {
    return {
      ok:false,
      error:"Two saved Teams groups would share the same display name. Rename one group or remove the conflicting saved entry before adding it."
    };
  }

  if(!chatId&&byName?.chatId) {
    return {
      ok:false,
      error:"This Teams chat's stable ID is not visible right now. Reopen the same chat and add it again so BCE does not confuse it with another conversation."
    };
  }

  if(chatId&&byName?.chatId&&byName.chatId!==chatId) {
    return {
      ok:false,
      error:"Another Teams conversation with this display name is already selected. BCE cannot safely distinguish their notification cards, so this group was not added."
    };
  }

  if(chatId&&byName&&!byName.chatId&&byName!==byChatId) {
    return {
      ok:false,
      error:"This saved group predates stable conversation IDs. Remove it and add this chat again; a saved tab ID cannot prove that the tab still contains the original conversation."
    };
  }

  const existing=byChatId||byName;
  if(existing) {
    return {
      ok:true,
      created:false,
      group:{
        ...existing,
        id:chatId||existing.id||groupKey,
        key:groupKey,
        name:groupName,
        chatId:chatId||existing.chatId||""
      }
    };
  }

  return {
    ok:true,
    created:true,
    group:{
      id:chatId||groupKey,
      key:groupKey,
      name:groupName,
      chatId,
      tabIds:[],
      lastAddedTabId:null,
      priority:list.length,
      readHistory:false
    }
  };
}
