export function normalizeSpeechBatch(item) {
  const rawMessages=Array.isArray(item?.messages)
    ? item.messages
    : (item?.sender||item?.audioRef||item?.audioUrl||item?.text)
      ? [{
          sender:item.sender||"",
          text:item.text||"",
          messageId:item.messageId||"",
          replyTo:item.replyTo||"",
          isReply:!!item.isReply,
          audioRef:item.audioRef||"",
          audioUrl:item.audioUrl||"",
          sourceTabId:item.sourceTabId
        }]
      : [];

  return {
    groupKey:String(item?.groupKey||""),
    groupName:String(item?.groupName||"Teams group"),
    messages:rawMessages.map(message=>({
      sender:String(message.sender||""),
      text:String(message.text||""),
      messageId:String(message.messageId||message.key||""),
      replyTo:String(message.replyTo||""),
      replyToMessageId:String(message.replyToMessageId||""),
      isReply:!!message.isReply,
      audioRef:String(message.audioRef||""),
      audioUrl:String(message.audioUrl||""),
      sourceTabId:Number.isInteger(message.sourceTabId)
        ? message.sourceTabId
        : (Number.isInteger(item?.sourceTabId)?item.sourceTabId:null)
    })),
    priority:Number.isFinite(item?.priority)?item.priority:999,
    sequence:Number.isFinite(item?.sequence)?item.sequence:Date.now(),
    messageIndex:Number.isInteger(item?.messageIndex)?Math.max(0,item.messageIndex):0,
    phase:["gap","message","audio"].includes(item?.phase)?item.phase:"group",
    playbackId:String(item?.playbackId||"")
  };
}

export function speechMessageKey(message) {
  return message.messageId || [
    message.sender,
    message.text,
    message.audioRef,
    message.audioUrl
  ].join("|");
}

export function appendUniqueMessages(batch, messages) {
  const known=new Set(batch.messages.map(speechMessageKey));
  for(const message of messages) {
    const key=speechMessageKey(message);
    if(known.has(key)) continue;
    batch.messages.push(message);
    known.add(key);
  }
  return batch.messages.length;
}

function messageCount(item) {
  if(Array.isArray(item?.messages)) return item.messages.length;
  return item?.sender||item?.audioRef||item?.audioUrl||item?.text ? 1 : 0;
}

export function countPendingSpeechMessages(queue, current) {
  const queued=Array.isArray(queue)
    ? queue.reduce((total,batch)=>total+messageCount(batch),0)
    : 0;
  const currentLength=messageCount(current);
  const currentIndex=Number.isInteger(current?.messageIndex)
    ? Math.max(0,current.messageIndex)
    : 0;
  return queued+Math.max(0,currentLength-currentIndex);
}
