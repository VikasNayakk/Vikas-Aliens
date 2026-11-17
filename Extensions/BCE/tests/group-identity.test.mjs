import test from "node:test";
import assert from "node:assert/strict";
import { resolveTeamsGroupIdentity } from "../group-identity.mjs";

test("creates a new group with stable Teams conversation identity", () => {
  const result=resolveTeamsGroupIdentity([],{
    groupKey:"operations",
    groupName:"Operations",
    chatId:"19:chat-a"
  },11);

  assert.equal(result.ok,true);
  assert.equal(result.created,true);
  assert.equal(result.group.id,"19:chat-a");
  assert.equal(result.group.key,"operations");
  assert.equal(result.group.chatId,"19:chat-a");
});

test("reuses the same conversation after its display name changes", () => {
  const old={id:"19:chat-a",key:"ops",name:"Ops",chatId:"19:chat-a",tabIds:[11]};
  const result=resolveTeamsGroupIdentity([old],{
    groupKey:"operations",
    groupName:"Operations",
    chatId:"19:chat-a"
  },12);

  assert.equal(result.ok,true);
  assert.equal(result.created,false);
  assert.equal(result.group.id,"19:chat-a");
  assert.equal(result.group.key,"operations");
  assert.equal(result.group.name,"Operations");
});

test("rejects a second conversation with the same display name", () => {
  const first={id:"19:chat-a",key:"operations",name:"Operations",chatId:"19:chat-a"};
  const result=resolveTeamsGroupIdentity([first],{
    groupKey:"operations",
    groupName:"Operations",
    chatId:"19:chat-b"
  },12);

  assert.equal(result.ok,false);
  assert.match(result.error,/cannot safely distinguish/i);
});

test("allows a safe legacy upgrade only from a tab already linked to the group", () => {
  const legacy={id:"operations",key:"operations",name:"Operations",tabIds:[11],lastAddedTabId:11};
  const result=resolveTeamsGroupIdentity([legacy],{
    groupKey:"operations",
    groupName:"Operations",
    chatId:"19:chat-a"
  },11);

  assert.equal(result.ok,true);
  assert.equal(result.group.chatId,"19:chat-a");
});

test("does not guess when a legacy same-name group has no matching source tab", () => {
  const legacy={id:"operations",key:"operations",name:"Operations",tabIds:[11],lastAddedTabId:11};
  const result=resolveTeamsGroupIdentity([legacy],{
    groupKey:"operations",
    groupName:"Operations",
    chatId:"19:chat-b"
  },12);

  assert.equal(result.ok,false);
  assert.match(result.error,/remove that saved group/i);
});

test("rejects a group when its stable ID is temporarily unavailable", () => {
  const saved={id:"19:chat-a",key:"operations",name:"Operations",chatId:"19:chat-a"};
  const result=resolveTeamsGroupIdentity([saved],{
    groupKey:"operations",
    groupName:"Operations",
    chatId:""
  },11);

  assert.equal(result.ok,false);
  assert.match(result.error,/stable ID is not visible/i);
});
