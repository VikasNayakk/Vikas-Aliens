const LIMITS = Object.freeze({
  groupKey: 256,
  groupName: 256,
  sender: 120,
  text: 50000,
  messageId: 1024,
  replyTo: 120,
  replyToMessageId: 1024,
  messageTimestamp: 100,
  audioRef: 180,
  audioUrl: 2048
});

function boundedString(value, maxLength) {
  if(typeof value!=="string") return "";
  return value.replace(/\u0000/g,"").trim().slice(0,maxLength);
}

function normalizeGroupKey(value) {
  return boundedString(value,LIMITS.groupKey)
    .normalize("NFKC")
    .replace(/\s+/g," ")
    .trim()
    .toLowerCase();
}

function normalizeAudioUrl(value) {
  const raw=boundedString(value,LIMITS.audioUrl);
  if(!raw) return "";
  try {
    const url=new URL(raw);
    if(url.protocol==="https:") return url.href;
    if(url.protocol==="blob:"&&new URL(url.pathname).protocol==="https:") return url.href;
  } catch (_) {}
  return null;
}

export function normalizeTeamsLiveMessage(payload) {
  if(!payload||typeof payload!=="object"||Array.isArray(payload)) return null;

  for(const [field,maxLength] of Object.entries(LIMITS)) {
    const value=payload[field];
    if(value!=null&&(typeof value!=="string"||value.length>maxLength)) return null;
  }
  if(payload.isReply!=null&&typeof payload.isReply!=="boolean") return null;
  if(
    payload.timestamp!=null &&
    typeof payload.timestamp!=="string" &&
    typeof payload.timestamp!=="number"
  ) return null;
  if(typeof payload.timestamp==="number"&&!Number.isFinite(payload.timestamp)) return null;
  if(typeof payload.timestamp==="string"&&payload.timestamp.length>LIMITS.messageTimestamp) return null;

  const groupKey=normalizeGroupKey(payload.groupKey);
  const groupName=boundedString(payload.groupName,LIMITS.groupName);
  const sender=boundedString(payload.sender,LIMITS.sender);
  const text=boundedString(payload.text,LIMITS.text);
  const messageId=boundedString(payload.messageId,LIMITS.messageId);
  const replyTo=boundedString(payload.replyTo,LIMITS.replyTo);
  const replyToMessageId=boundedString(payload.replyToMessageId,LIMITS.replyToMessageId);
  const messageTimestamp=boundedString(payload.messageTimestamp,LIMITS.messageTimestamp);
  const rawAudioRef=boundedString(payload.audioRef,LIMITS.audioRef);
  const audioUrl=normalizeAudioUrl(payload.audioUrl);

  if(!groupKey||!sender) return null;
  if(payload.audioUrl&&audioUrl===null) return null;
  if(rawAudioRef&&!/^[A-Za-z0-9_-]+$/.test(rawAudioRef)) return null;
  if(!text&&!rawAudioRef&&!audioUrl) return null;

  const timestamp=typeof payload.timestamp==="number"&&Number.isFinite(payload.timestamp)
    ? payload.timestamp
    : boundedString(payload.timestamp,LIMITS.messageTimestamp);

  return {
    groupName,
    groupKey,
    sender,
    text,
    timestamp,
    messageTimestamp,
    messageId,
    replyTo,
    replyToMessageId,
    isReply:payload.isReply===true,
    audioRef:rawAudioRef,
    audioUrl:audioUrl||""
  };
}

export function isTeamsContentSender(sender) {
  const tabId=sender?.tab?.id;
  const sourceUrl=sender?.url||sender?.tab?.url||"";
  return Number.isInteger(tabId) &&
    /^https:\/\/(?:teams\.cloud\.microsoft|teams\.microsoft\.com)\//i.test(sourceUrl);
}
