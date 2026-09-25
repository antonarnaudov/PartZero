/**
 * The compact CadScript references in the designer's cached prompt prefix, generated from the
 * `@aicad/std` declarations: v0 (`packages/cadscript/std/index.d.ts`, `STD_DTS`) and v1
 * (`packages/cadscript/std/v1/index.d.ts`, `v1.STD_DTS`, {@link cadscriptReferenceV1}). It is the
 * same documentation editors show, restructured for a model: the package rules verbatim, then
 * every builtin with its signature, parameter docs and examples, and every option type with its
 * members. Deterministic: the same declarations give the same bytes (cache-stable).
 */
import ts from "typescript";
import { STD_DTS, v1 as cs } from "@aicad/cadscript";

interface Doc {
  text: string;
  params: { name: string; text: string }[];
  examples: string[];
  defaultValue?: string;
  deprecated?: string;
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
      else if (name === "deprecated") doc.deprecated = body;
    }
  }
  return doc;
}

function oneParagraph(text: string): string {
  return text.replace(/\n(?!\s*[-*]|\s*\n)/g, " ").replace(/[ \t]+/g, " ").trim();
}

/**
 * v1 prose for the prompt: citations of the SPEC and ADRs dropped (the designer has neither; they
 * only cost tokens), `(SPEC-v1 §6.5)`, `; SPEC-v1 §6.5` and `(ADR 0013 decision 5)` alike.
 */
function uncited(text: string): string {
  return text
    .replace(/\s*\((?:see )?(?:SPEC-v1 §[\d.]+|ADR \d+[^)]*)\)/g, "")
    .replace(/;\s*SPEC-v1 §[\d.]+(?=\))/g, "")
    .replace(/ {2,}/g, " ");
}

/**
 * A chaining query method whose doc only restates its name ("Planar faces only.", "The longest
 * edges."): listed by signature with the others (the reviewer's "drop per-method prose where it
 * adds nothing"). Docs with code, numbers, emphasis, a qualification (comma, parentheses, colon)
 * or more than six words stay.
 */
function restatesName(text: string): boolean {
  return text.split(/\s+/).length <= 6 && !/[`\d*,():]/.test(text);
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
let cachedV1: string | undefined;

/**
 * Type text for the prompt: the JSDoc comments inside inline object types and `readonly` dropped,
 * whitespace collapsed (the docs are listed separately; `readonly` is typing machinery).
 *
 * Size: the plan (IR-V1-IMPLEMENTATION-PLAN W10) budgets "~6k tokens"; the v1 surface (queries,
 * handles, constraints, holes, blends, patterns, datums) is ~3.5× v0's, and the reference is ~35k
 * characters (~8.5–9k tokens) after dropping what adds nothing (SPEC/ADR citations, docs that
 * restate a method's name, the prose of builtins the compiler rejects). Cutting further would drop
 * semantics a designer needs (what `.parallel` means on faces, which option is required), so the
 * budget is ~9k tokens: the test pins it below 35.5k characters.
 */
function typeText(text: string): string {
  return text
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\breadonly\s+/g, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*\}/g, " }")
    .trim();
}

/** `name(params): type` of a function-like declaration or method signature; the return type is left out when it is `chain` (a fluent method). */
function signature(sf: ts.SourceFile, name: string, n: ts.SignatureDeclarationBase, chain?: string): string {
  const tps = n.typeParameters ? `<${n.typeParameters.map((t) => t.getText(sf)).join(", ")}>` : "";
  const params = n.parameters.map((p) => typeText(p.getText(sf))).join(", ");
  const ret = n.type ? typeText(n.type.getText(sf)) : undefined;
  return `${name}${tps}(${params})${ret !== undefined && ret !== chain ? `: ${ret}` : ""}`;
}

/**
 * One `- \`sig\` — doc` line per member of an interface or object type (properties and methods).
 * Methods of `owner` returning `owner` are written without the return type (the section header
 * says so); undocumented members share one line.
 */
function membersV1(members: ts.NodeArray<ts.TypeElement>, sf: ts.SourceFile, owner?: string): string[] {
  const out: string[] = [];
  const bare: string[] = [];
  const meta: string[] = [];
  for (const m of members) {
    if (m.name !== undefined && ts.isComputedPropertyName(m.name)) continue; // the brand
    const d = docOf(m);
    const text = uncited(oneParagraph(d.text));
    let sig: string | undefined;
    if (ts.isPropertySignature(m) && m.type && m.name) sig = `${m.name.getText(sf)}${m.questionToken ? "?" : ""}: ${typeText(m.type.getText(sf))}`;
    else if (ts.isMethodSignature(m) && m.name) sig = signature(sf, m.name.getText(sf), m, owner);
    if (sig === undefined) continue;
    // Undocumented members share one line; so does metadata the engine ignores ("not semantic").
    if (/\bnot semantic\b/.test(text)) {
      meta.push(`\`${sig}\``);
      continue;
    }
    if ((!text && !d.defaultValue) || (ts.isMethodSignature(m) && !d.defaultValue && restatesName(text))) {
      bare.push(`\`${sig}\``);
      continue;
    }
    out.push(`- \`${sig}\`${text ? ` — ${text}` : ""}${d.defaultValue ? ` Default: ${d.defaultValue}.` : ""}`);
  }
  if (bare.length > 0) out.push(`- ${bare.join(", ")}`);
  if (meta.length > 0) out.push(`- ${meta.join(", ")} — free text, not semantic`);
  return out;
}

/**
 * The CadScript **v1** reference for system prompts, generated from the `@aicad/std` v1
 * declarations (`packages/cadscript/std/v1/index.d.ts`, shipped as `v1.STD_DTS`): the package rules,
 * then per section every builtin (all overloads) with its docs and examples, every query and handle
 * method, and every option type. Deterministic: the same declarations give the same bytes.
 */
export function cadscriptReferenceV1(): string {
  if (cachedV1 !== undefined) return cachedV1;
  const dts = cs.STD_DTS;
  const sf = ts.createSourceFile("index.d.ts", dts, ts.ScriptTarget.ES2022, true);
  const out: string[] = [
    "# CadScript v1 reference",
    "",
    "Generated from the `@aicad/std` v1 declarations. This is the complete language: nothing else exists. Import every builtin you use. A query method listed without a return type returns the same kind of set, so it chains (`slab.faces().planes().max(\"+Z\")`).",
    "",
    packageDocOf(dts),
    "",
  ];
  const stmts = [...sf.statements];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    const section = sectionOfIn(dts, stmt);
    if (section) out.push("", `## ${section}`, "");
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      // Overloads: one heading per signature, the docs of the first.
      const name = stmt.name.text;
      const group = [stmt];
      while (i + 1 < stmts.length && ts.isFunctionDeclaration(stmts[i + 1]!) && (stmts[i + 1] as ts.FunctionDeclaration).name?.text === name) group.push(stmts[++i] as ts.FunctionDeclaration);
      const d = group.map(docOf).find((x) => x.text || x.examples.length > 0) ?? docOf(stmt);
      const simple = signature(sf, name, stmt).replace(/: (Scalar|number)(?=[,)])/g, "").replace(/\): number$/, ")");
      if (d.deprecated) {
        // Rejected by the compiler: its name and why, nothing that invites a use.
        out.push(`- \`${simple}\` — **Not available:** ${uncited(oneParagraph(d.deprecated)).split(/;\s/)[0]!.replace(/\.?$/, ".")}`);
        continue;
      }
      if (group.length === 1 && d.params.length === 0 && d.examples.length === 0 && !d.text.includes("\n\n")) {
        // A simple builtin (math, units): one list line; plain numeric parameter and result types go unsaid.
        out.push(`- \`${simple}\` — ${uncited(oneParagraph(d.text))}`);
        continue;
      }
      out.push("");
      for (const g of group) out.push(`### \`${signature(sf, name, g)}\``);
      if (d.text) out.push(uncited(d.text));
      for (const p of d.params) out.push(`- \`${p.name}\`: ${uncited(oneParagraph(p.text))}`);
      for (const ex of d.examples) out.push("```ts", ex, "```");
      out.push("");
    } else if (ts.isInterfaceDeclaration(stmt)) {
      if (isBrandOnly(stmt)) continue;
      const d = docOf(stmt);
      const heritage = stmt.heritageClauses?.map((h) => h.getText(sf)).join(" ") ?? "";
      out.push("", `### \`${stmt.name.text}\`${heritage ? ` (${heritage})` : ""}`);
      if (d.text) out.push(oneParagraph(d.text));
      out.push(...membersV1(stmt.members, sf, stmt.name.text));
      for (const ex of d.examples) out.push("```ts", ex, "```");
      out.push("");
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      const d = docOf(stmt);
      out.push(`- \`type ${stmt.name.text} = ${typeText(stmt.type.getText(sf)).replace(/^\| /, "")}\`${d.text ? ` — ${uncited(hanging(d.text))}` : ""}`);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        // The brand symbol is typing machinery; its JSDoc is the package doc.
        if (!ts.isIdentifier(decl.name) || decl.name.text === "brand") continue;
        const d = docOf(stmt);
        if (decl.type && ts.isTypeLiteralNode(decl.type)) {
          out.push("", `### \`${decl.name.text}\``);
          if (d.text) out.push(oneParagraph(d.text));
          out.push(...membersV1(decl.type.members, sf));
          for (const ex of d.examples) out.push("```ts", ex, "```");
          out.push("");
        } else {
          out.push(`- \`${decl.name.text}: ${decl.type ? typeText(decl.type.getText(sf)) : "unknown"}\`${d.text ? ` — ${hanging(d.text)}` : ""}`);
        }
      }
    }
  }
  cachedV1 = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cachedV1;
}

function packageDocOf(dts: string): string {
  const m = dts.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return "";
  return cleanLinks(m[1]!)
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .filter((l) => !l.includes("@packageDocumentation"))
    .join("\n")
    .replace(/^# /gm, "## ")
    .trim();
}

function sectionOfIn(dts: string, stmt: ts.Statement): string | undefined {
  for (const r of ts.getLeadingCommentRanges(dts, stmt.pos) ?? []) {
    const m = dts.slice(r.pos, r.end).match(/─── (.+?) ─/);
    if (m) return m[1];
  }
  return undefined;
}

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
