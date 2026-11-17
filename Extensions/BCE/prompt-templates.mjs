const MAX_TEMPLATES=100;
const MAX_NAME_LENGTH=80;
const MAX_CONTENT_LENGTH=50000;
const VARIABLE_PATTERN=/{{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*}}/g;

function invalid(error){return {ok:false,error};}
function validTime(value){return typeof value==="number"&&Number.isFinite(value)&&value>=0;}

export function extractPromptTemplateVariables(content){
  if(typeof content!=="string") throw new TypeError("Template content must be text.");
  const variables=[];
  for(const match of content.matchAll(VARIABLE_PATTERN)){
    if(!variables.includes(match[1])) variables.push(match[1]);
  }
  const residue=content.replace(VARIABLE_PATTERN,"");
  if(residue.includes("{{")||residue.includes("}}")){
    throw new TypeError("Template variables must use {{variable_name}} with a letter first.");
  }
  return variables;
}

export function upsertPromptTemplate(templates,input,now=Date.now()){
  if(!Array.isArray(templates)) return invalid("Saved templates must be a list.");
  if(!input||typeof input!=="object"||Array.isArray(input)) return invalid("Template input must be an object.");
  if(!validTime(now)) return invalid("Template update time is invalid.");
  const id=typeof input.id==="string"?input.id.trim():"";
  const name=typeof input.name==="string"?input.name.trim():"";
  const content=typeof input.content==="string"?input.content:"";
  const enabled=input.enabled===undefined?true:input.enabled;
  if(id.length>128) return invalid("Template ID is invalid.");
  if(!name||name.length>MAX_NAME_LENGTH) return invalid("Template name must contain 1–80 characters.");
  if(!content.trim()||content.length>MAX_CONTENT_LENGTH) return invalid("Template content must contain 1–50,000 characters.");
  if(typeof enabled!=="boolean") return invalid("Template enabled state must be true or false.");
  let variables;
  try{variables=extractPromptTemplateVariables(content);}
  catch(error){return invalid(error.message);}
  if(!id) return invalid("A template ID must be supplied when creating a template.");
  const existingIndex=templates.findIndex(item=>item?.id===id);
  const previous=existingIndex>=0?templates[existingIndex]:null;
  const duplicate=templates.find(item=>item?.id!==previous?.id&&
    String(item?.name||"").trim().toLocaleLowerCase()===name.toLocaleLowerCase());
  if(duplicate) return invalid("A template with this name already exists.");
  if(existingIndex<0&&templates.length>=MAX_TEMPLATES) return invalid("You can save up to 100 prompt templates.");
  const template={
    id:previous?.id||id,name,content,variables,enabled,
    createdAt:previous?.createdAt??now,updatedAt:now
  };
  const next=templates.slice();
  if(existingIndex>=0) next[existingIndex]=template;
  else next.push(template);
  return {ok:true,templates:next,template};
}

export function setPromptTemplateEnabled(templates,id,enabled,now=Date.now()){
  if(!Array.isArray(templates)) return invalid("Saved templates must be a list.");
  if(typeof id!=="string"||!id.trim()) return invalid("A template ID is required.");
  if(typeof enabled!=="boolean") return invalid("Enabled state must be true or false.");
  if(!validTime(now)) return invalid("Template update time is invalid.");
  const index=templates.findIndex(item=>item?.id===id);
  if(index<0) return invalid("The selected template no longer exists. Refresh the template list.");
  const next=templates.slice();
  next[index]={...next[index],enabled,updatedAt:now};
  return {ok:true,templates:next,template:next[index]};
}

export function deletePromptTemplate(templates,id){
  if(!Array.isArray(templates)) return invalid("Saved templates must be a list.");
  if(typeof id!=="string"||!id.trim()) return invalid("A template ID is required.");
  const index=templates.findIndex(item=>item?.id===id);
  if(index<0) return invalid("The selected template no longer exists. Refresh the template list.");
  return {ok:true,templates:templates.filter(item=>item?.id!==id),deletedId:id};
}

export function renderPromptTemplate(template,values){
  if(!template||typeof template.content!=="string") throw new TypeError("A valid saved prompt template is required.");
  if(!values||typeof values!=="object"||Array.isArray(values)) throw new TypeError("Template variable values must be an object.");
  const variables=extractPromptTemplateVariables(template.content);
  for(const key of variables){
    if(!Object.prototype.hasOwnProperty.call(values,key)||typeof values[key]!=="string"){
      throw new TypeError("Enter a value for template variable: "+key);
    }
    if(values[key].length>MAX_CONTENT_LENGTH) throw new TypeError("Template variable "+key+" is too long.");
  }
  return template.content.replace(VARIABLE_PATTERN,(_,key)=>values[key]);
}
