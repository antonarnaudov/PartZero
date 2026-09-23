/**
 * The compact CadScript reference in the designer's cached prompt prefix, generated from the
 * `@aicad/std` declarations (`packages/cadscript/std/index.d.ts`, shipped as `STD_DTS`). It is the
 * same documentation editors show, restructured for a model: the package rules verbatim, then
 * every builtin with its signature, parameter docs and examples, and every option type with its
 * members. Deterministic: the same declarations give the same bytes (cache-stable).
 */
import ts from "typescript";
import { STD_DTS } from "@aicad/cadscript";

interface Doc {
  text: string;
  params: { name: string; text: string }[];
  examples: string[];
  defaultValue?: string;
}

function cleanLinks(s: string): string {
  return s.replace(/\{@link\s+([^}\s|]+)(?:\s*\|\s*([^}]+))?\s*\}/g, (_m, a: string, b?: string) => `\`${b ?? a}\``);
}

function commentText(c: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  return cleanLinks(ts.getTextOfJSDocComment(c) ?? "").trim();
}

function docOf(node: ts.Node): Doc {
  const doc: Doc = { text: "", params: [], examples: [] };
  for (const d of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(d)) continue;
    const text = commentText(d.comment);
    if (text) doc.text = doc.text ? `${doc.text}\n${text}` : text;
    for (const tag of d.tags ?? []) {
      const name = tag.tagName.text;
      const body = commentText(tag.comment);
      if (name === "param" && ts.isJSDocParameterTag(tag)) doc.params.push({ name: tag.name.getText(), text: body });
      else if (name === "example") doc.examples.push(body);
      else if (name === "default") doc.defaultValue = body;
    }
  }
  return doc;
}

function oneParagraph(text: string): string {
  return text.replace(/\n(?!\s*[-*]|\s*\n)/g, " ").replace(/[ \t]+/g, " ").trim();
}

/** Doc text under a list item: paragraphs joined, nested bullets indented. */
function hanging(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => oneParagraph(para))
    .join(" ")
    .replace(/ (- `)/g, "\n  $1");
}

function packageDoc(): string {
  const m = STD_DTS.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return "";
  return m[1]!
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .filter((l) => !l.includes("@packageDocumentation"))
    .join("\n")
    .replace(/^# /gm, "## ")
    .trim();
}

function sectionOf(stmt: ts.Statement): string | undefined {
  for (const r of ts.getLeadingCommentRanges(STD_DTS, stmt.pos) ?? []) {
    const m = STD_DTS.slice(r.pos, r.end).match(/─── (.+?) ─/);
    if (m) return m[1];
  }
  return undefined;
}

function isBrandOnly(i: ts.InterfaceDeclaration): boolean {
  return i.members.length > 0 && i.members.every((m) => m.name !== undefined && ts.isComputedPropertyName(m.name));
}

function memberLine(m: ts.TypeElement, sf: ts.SourceFile): string | undefined {
  if (!ts.isPropertySignature(m) || !m.type || m.name === undefined) return undefined;
  const d = docOf(m);
  const sig = `${m.name.getText(sf)}${m.questionToken ? "?" : ""}: ${m.type.getText(sf)}`;
  const text = oneParagraph(d.text);
  return `- \`${sig}\`${text ? ` — ${text}` : ""}${d.defaultValue ? ` Default: ${d.defaultValue}.` : ""}`;
}

let cached: string | undefined;

/** The CadScript v0 reference for system prompts (~3–4k tokens). */
export function cadscriptReference(): string {
  if (cached !== undefined) return cached;
  const sf = ts.createSourceFile("index.d.ts", STD_DTS, ts.ScriptTarget.ES2022, true);
  const out: string[] = ["# CadScript v0 reference", "", "Generated from the `@aicad/std` declarations. This is the complete language: nothing else exists.", "", packageDoc(), ""];
  for (const stmt of sf.statements) {
    const section = sectionOf(stmt);
    if (section) out.push(`## ${section}`, "");
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const d = docOf(stmt);
      const params = stmt.parameters.map((p) => p.getText(sf)).join(", ");
      out.push(`### \`${stmt.name.text}(${params}): ${stmt.type?.getText(sf) ?? "void"}\``);
      if (d.text) out.push(d.text);
      for (const p of d.params) out.push(`- \`${p.name}\`: ${oneParagraph(p.text)}`);
      for (const ex of d.examples) out.push("```ts", ex, "```");
      out.push("");
    } else if (ts.isInterfaceDeclaration(stmt)) {
      if (isBrandOnly(stmt)) continue;
      const d = docOf(stmt);
      const members = stmt.members.map((m) => memberLine(m, sf)).filter((x): x is string => x !== undefined);
      const index = stmt.members.find(ts.isIndexSignatureDeclaration);
      out.push(`### \`${stmt.name.text}\`${index ? ` — \`{ ${index.getText(sf).replace(/^readonly /, "").replace(/;$/, "")} }\`` : ""}`);
      if (d.text) out.push(oneParagraph(d.text));
      out.push(...members, "");
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      const d = docOf(stmt);
      out.push(`- \`type ${stmt.name.text} = ${stmt.type.getText(sf)}\`${d.text ? ` — ${hanging(d.text)}` : ""}`, "");
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text === "kind") continue;
        const d = docOf(stmt);
        out.push(`- \`${decl.name.text}: ${decl.type?.getText(sf) ?? "unknown"}\`${d.text ? ` — ${hanging(d.text)}` : ""}`, "");
      }
    }
  }
  cached = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cached;
}
