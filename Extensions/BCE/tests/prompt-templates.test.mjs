import test from "node:test";
import assert from "node:assert/strict";
import {
  deletePromptTemplate,
  extractPromptTemplateVariables,
  renderPromptTemplate,
  setPromptTemplateEnabled,
  upsertPromptTemplate
} from "../prompt-templates.mjs";

const draft=(overrides={})=>({
  id:"template-1",
  name:"Daily report",
  content:"Prepare a report for {{date}} owned by {{owner}}.",
  enabled:true,
  ...overrides
});

test("creates a named template and extracts unique variables in source order",()=>{
  const result=upsertPromptTemplate([],draft(),100);
  assert.equal(result.ok,true);
  assert.equal(result.template.createdAt,100);
  assert.deepEqual(result.template.variables,["date","owner"]);
});

test("updates an existing template without changing its identity or creation time",()=>{
  const created=upsertPromptTemplate([],draft(),100);
  const updated=upsertPromptTemplate(created.templates,draft({name:"Weekly report",content:"Summary: {{week}}",updateExisting:true}),200);
  assert.equal(updated.ok,true);
  assert.equal(updated.template.id,"template-1");
  assert.equal(updated.template.createdAt,100);
  assert.equal(updated.template.updatedAt,200);
  assert.deepEqual(updated.template.variables,["week"]);
});

test("rejects duplicate names case-insensitively and preserves the source list",()=>{
  const first=upsertPromptTemplate([],draft(),100);
  const duplicate=upsertPromptTemplate(first.templates,draft({id:"template-2",name:"DAILY REPORT"}),200);
  assert.equal(duplicate.ok,false);
  assert.match(duplicate.error,/already exists/i);
  assert.equal(first.templates.length,1);
});

test("rejects stale update IDs and duplicate IDs for new templates",()=>{
  assert.equal(upsertPromptTemplate([],draft({updateExisting:true}),100).ok,false);
  const created=upsertPromptTemplate([],draft(),100);
  const duplicateId=upsertPromptTemplate(created.templates,draft({name:"Another name"}),200);
  assert.equal(duplicateId.ok,false);
  assert.match(duplicateId.error,/ID is already in use/i);
});

test("rejects invalid names, content, malformed variables and invalid enabled flags",()=>{
  assert.equal(upsertPromptTemplate([],draft({name:" "}),100).ok,false);
  assert.equal(upsertPromptTemplate([],draft({content:" "}),100).ok,false);
  assert.equal(upsertPromptTemplate([],draft({content:"Use {{2bad}}"}),100).ok,false);
  assert.equal(upsertPromptTemplate([],draft({enabled:"yes"}),100).ok,false);
  assert.throws(()=>extractPromptTemplateVariables("Unclosed {{name"),/must use/i);
});

test("enforces the maximum template count without mutating existing templates",()=>{
  const many=Array.from({length:100},(_,index)=>({id:"id-"+index,name:"Name "+index}));
  const result=upsertPromptTemplate(many,draft(),100);
  assert.equal(result.ok,false);
  assert.equal(many.length,100);
});

test("renders variables literally, including repeated variables and special characters",()=>{
  const template=draft({content:"{{name}} said {{name}}: {{text}}"});
  const rendered=renderPromptTemplate(template,{name:"A&B <team>",text:"Line 1\nLine 2"});
  assert.equal(rendered,"A&B <team> said A&B <team>: Line 1\nLine 2");
});

test("requires every variable value and bounds variable input length",()=>{
  const template=draft();
  assert.throws(()=>renderPromptTemplate(template,{date:"Today"}),/owner/i);
  assert.throws(()=>renderPromptTemplate(template,{date:"x".repeat(50001),owner:"A"}),/too long/i);
});

test("enables, disables and deletes only the selected template",()=>{
  const first=upsertPromptTemplate([],draft(),100);
  const second=upsertPromptTemplate(first.templates,draft({id:"template-2",name:"Other"}),110);
  const disabled=setPromptTemplateEnabled(second.templates,"template-1",false,120);
  assert.equal(disabled.template.enabled,false);
  assert.equal(disabled.templates[1].enabled,true);
  const removed=deletePromptTemplate(disabled.templates,"template-1");
  assert.deepEqual(removed.templates.map(item=>item.id),["template-2"]);
});

test("rejects stale IDs and invalid timestamps for template mutations",()=>{
  assert.equal(upsertPromptTemplate([],draft({id:""}),100).ok,false);
  assert.equal(upsertPromptTemplate([],draft(),-1).ok,false);
  assert.equal(setPromptTemplateEnabled([], "missing",true,100).ok,false);
  assert.equal(deletePromptTemplate([], "missing").ok,false);
});
