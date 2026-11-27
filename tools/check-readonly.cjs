#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..");
const TARGETS = ["src", "bin", "dist"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs"]);
const FS_MODULES = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);

// Filesystem APIs that create, delete, move, rename or modify content.
const MUTATORS = new Set([
  "appendFile", "appendFileSync",
  "chmod", "chmodSync", "chown", "chownSync",
  "copyFile", "copyFileSync", "cp", "cpSync",
  "createWriteStream", "fchmod", "fchmodSync", "fchown", "fchownSync",
  "ftruncate", "ftruncateSync", "futimes", "futimesSync",
  "lchmod", "lchmodSync", "lchown", "lchownSync",
  "link", "linkSync", "lutimes", "lutimesSync",
  "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync",
  "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync",
  "symlink", "symlinkSync",
  "truncate", "truncateSync", "unlink", "unlinkSync",
  "utimes", "utimesSync",
  "write", "writeFile", "writeFileSync", "writeSync", "writev", "writevSync",
]);

const DESTRUCTIVE_COMMANDS = new Set([
  "attrib", "cacls", "chmod", "chown", "clear-recyclebin", "copy", "dd", "del",
  "diskpart", "erase", "format", "icacls", "mkfs", "move", "rd", "reg",
  "regedit", "ren", "rename", "rm", "rmdir", "robocopy", "sdelete", "shred",
  "takeown", "truncate", "xcopy",
]);

const FORBIDDEN_TEXT = [
  "SHFileOperation",
  "IFileOperation",
  "NativeRecycle",
  "RecycleBin.Native",
  "windows-recycle-bin.ps1",
  "Remove-Item",
  "Clear-RecycleBin",
];

const findings = [];
let scanned = 0;

function add(file, node, message) {
  const line = node && node.loc ? node.loc.start.line : 0;
  const column = node && node.loc ? node.loc.start.column + 1 : 0;
  findings.push(`${path.relative(ROOT, file)}:${line}:${column} ${message}`);
}

function chain(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    const object = chain(node.object);
    if (!object) return "";
    const property = node.computed ? null : node.property.name;
    return property ? `${object}.${property}` : `${object}[...]`;
  }
  if (node.type === "CallExpression") {
    const callee = chain(node.callee);
    if (callee === "require" && node.arguments.length > 0 && node.arguments[0].type === "Literal") {
      return `require("${node.arguments[0].value}")`;
    }
  }
  return "";
}

function isFsReceiver(receiver, namespaces) {
  if (!receiver) return false;
  if (namespaces.has(receiver)) return true;
  if (receiver.includes('require("node:fs")') || receiver.includes('require("fs")')) return true;
  for (const name of namespaces) {
    if (receiver === `${name}.promises` || receiver.startsWith(`${name}.promises.`)) return true;
  }
  return /(^|\.)(fs|fsp|promises|node_fs_\d+)(\.promises)?$/.test(receiver);
}

function openFlagsWrite(node) {
  if (node.arguments.length < 2) return false;
  const flags = node.arguments[1];
  return flags && flags.type === "Literal" && typeof flags.value === "string" && /[wa+x]/.test(flags.value);
}

function commandName(node) {
  if (node.arguments.length === 0) return null;
  const first = node.arguments[0];
  if (!first || first.type !== "Literal" || typeof first.value !== "string") return null;
  return path.basename(first.value).toLowerCase();
}

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value === "object") {
      walk(value, visit);
    }
  }
}

function checkJavaScript(file, text) {
  const ast = acorn.parse(text, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
  const namespaces = new Set();
  const namedMutators = new Set();

  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const initChain = chain(node.init);
      if (initChain.startsWith('require("') && FS_MODULES.has(initChain.slice(9, -2))) namespaces.add(node.id.name);
      if (node.init.type === "MemberExpression" && !node.init.computed && node.init.property.name === "promises") {
        const base = chain(node.init.object);
        if (base.startsWith('require("') && FS_MODULES.has(base.slice(9, -2))) namespaces.add(node.id.name);
      }
    }
    if (node.type === "VariableDeclarator" && node.id.type === "ObjectPattern" && node.init) {
      const initChain = chain(node.init);
      if (initChain.startsWith('require("') && FS_MODULES.has(initChain.slice(9, -2))) {
        for (const property of node.id.properties) {
          const imported = property.key && property.key.name;
          if (property.value && property.value.type === "Identifier" && MUTATORS.has(imported)) namedMutators.add(property.value.name);
          if (property.value && property.value.type === "Identifier" && imported === "promises") namespaces.add(property.value.name);
        }
      }
    }

    if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee.type === "MemberExpression" && !callee.computed) {
        const property = callee.property.name;
        const receiver = chain(callee.object);
        if (MUTATORS.has(property) && isFsReceiver(receiver, namespaces)) {
          add(file, node, `filesystem mutation API ${receiver}.${property}()`);
        }
        if ((property === "open" || property === "openSync") && isFsReceiver(receiver, namespaces) && openFlagsWrite(node)) {
          add(file, node, `writable filesystem descriptor ${receiver}.${property}()`);
        }
      }
      if (callee.type === "Identifier") {
        if (namedMutators.has(callee.name)) add(file, node, `filesystem mutation API ${callee.name}()`);
        if (["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"].includes(callee.name)) {
          const command = commandName(node);
          if (command && DESTRUCTIVE_COMMANDS.has(command)) {
            add(file, node, `filesystem-changing child process ${command}`);
          }
        }
      }
    }
  });
}

function checkTypeScript(file, text) {
  // Regex source checks are secondary to the compiled-output AST check. Strip
  // comments so prose such as "symlink (" cannot look like a call.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
  const names = [...MUTATORS].join("|");
  const mutatorPattern = new RegExp(`\\b(?:fs|fsp|promises)\\.(?:${names})\\s*\\(`);
  const match = mutatorPattern.exec(code);
  if (match) {
    const line = code.slice(0, match.index).split("\n").length;
    findings.push(`${path.relative(ROOT, file)}:${line}:1 source uses a filesystem mutation API`);
  }
  const directMutatorPattern = new RegExp(
    `\\b(?:appendFile|chmod|chown|copyFile|cp|mkdir|mkdtemp|rename|rm|rmdir|symlink|truncate|unlink|writeFile)(?:Sync)?\\s*\\(`,
  );
  const direct = directMutatorPattern.exec(code);
  if (direct) {
    const line = code.slice(0, direct.index).split("\n").length;
    findings.push(`${path.relative(ROOT, file)}:${line}:1 source calls a filesystem mutation API`);
  }
  const commandPattern = new RegExp(
    `\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\\s*\\(\\s*["'](?:${[...DESTRUCTIVE_COMMANDS].join("|")})["']`,
  );
  const command = commandPattern.exec(code);
  if (command) {
    const line = code.slice(0, command.index).split("\n").length;
    findings.push(`${path.relative(ROOT, file)}:${line}:1 source starts a filesystem-changing child process`);
  }
}

function checkFile(file) {
  const text = fs.readFileSync(file, "utf8");
  scanned++;
  for (const token of FORBIDDEN_TEXT) {
    if (text.includes(token)) findings.push(`${path.relative(ROOT, file)}:1:1 forbidden cleanup token ${token}`);
  }
  if (file.endsWith(".ts") || file.endsWith(".tsx")) checkTypeScript(file, text);
  else checkJavaScript(file, text);
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full);
    else if (EXTENSIONS.has(path.extname(entry.name))) checkFile(full);
  }
}

for (const target of TARGETS) walkFiles(path.join(ROOT, target));

if (findings.length > 0) {
  console.error("Read-only check failed:");
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log(`Read-only check passed for ${scanned} source and compiled files.`);
