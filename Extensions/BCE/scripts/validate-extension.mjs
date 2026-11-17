import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const rootPrefix=root+path.sep;

function isInsideRoot(target) {
  return target===root||target.startsWith(rootPrefix);
}

function resolveLocalReference(reference,baseDirectory) {
  const value=String(reference||"").trim();
  if(!value||value.startsWith("#")||/^(?:[a-z]+:|\/\/)/i.test(value)) return null;
  const clean=value.split(/[?#]/,1)[0];
  const target=path.resolve(baseDirectory,clean);
  if(!isInsideRoot(target)) {
    throw new Error("Referenced path escapes BCE directory: "+reference);
  }
  if(!fs.existsSync(target)||!fs.statSync(target).isFile()) {
    throw new Error("Referenced file does not exist: "+path.relative(root,target));
  }
  return target;
}

async function collectSourceFiles(directory) {
  const found=[];
  for(const entry of await fs.promises.readdir(directory,{withFileTypes:true})) {
    if(entry.name==="node_modules"||entry.name===".git") continue;
    const absolute=path.join(directory,entry.name);
    if(entry.isDirectory()) {
      found.push(...await collectSourceFiles(absolute));
    } else if(entry.isFile()&&/\.(?:js|mjs)$/i.test(entry.name)) {
      found.push(absolute);
    }
  }
  return found;
}

function validateHtmlReferences(htmlPath) {
  const html=fs.readFileSync(htmlPath,"utf8");
  const patterns=[
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi
  ];
  for(const pattern of patterns) {
    for(const match of html.matchAll(pattern)) {
      resolveLocalReference(match[1],path.dirname(htmlPath));
    }
  }
}

function validateManifest() {
  const manifestPath=path.join(root,"manifest.json");
  const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
  if(manifest.manifest_version!==3) {
    throw new Error("BCE must remain a Manifest V3 extension.");
  }

  const references=[
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.background?.service_worker,
    ...(manifest.content_scripts||[]).flatMap(item=>item.js||[])
  ].filter(Boolean);
  const htmlReferences=[];

  for(const reference of references) {
    const target=resolveLocalReference(reference,root);
    if(target&&/\.html?$/i.test(target)) htmlReferences.push(target);
  }
  for(const htmlPath of new Set(htmlReferences)) validateHtmlReferences(htmlPath);

  console.log("Manifest valid; "+references.length+" manifest references and local HTML assets verified.");
}

async function main() {
  const sourceFiles=await collectSourceFiles(root);
  if(!sourceFiles.length) throw new Error("No BCE JavaScript files were found.");

  for(const file of sourceFiles) {
    const source=fs.readFileSync(file,"utf8");
    const result=spawnSync(process.execPath,["--input-type=module","--check"],{
      input:source,
      encoding:"utf8"
    });
    if(result.status!==0) {
      throw new Error(
        "Syntax check failed for "+path.relative(root,file)+"\n"+
        (result.stderr||result.stdout||"Node.js returned a non-zero exit code.")
      );
    }
  }
  console.log("JavaScript syntax valid; "+sourceFiles.length+" .js/.mjs files checked.");

  validateManifest();
}

main().catch(error=>{
  console.error(error.stack||error.message||String(error));
  process.exitCode=1;
});
