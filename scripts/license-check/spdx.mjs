// A small SPDX license-expression evaluator: is an expression usable under the policy?
//
//   expr := and ("OR" and)* ;  and := with ("AND" with)* ;  with := atom ("WITH" id)? ;
//   atom := "(" expr ")" | id
//
// Also accepts the legacy "A/B" form (npm, crates.io) as "A OR B" and a trailing "+"
// ("or later"). Identifiers compare case-insensitively.
import { ALLOWED_LICENSES, ALLOWED_WITH } from "./policy.mjs";

const lower = (s) => s.toLowerCase();

export class SpdxError extends Error {}

function tokenize(text) {
  const out = [];
  for (const t of text.replace(/[()]/g, " $& ").split(/\s+/).filter(Boolean)) {
    if (t.includes("/")) {
      // legacy "Apache-2.0/MIT"
      t.split("/").forEach((part, i) => {
        if (i > 0) out.push("OR");
        if (part) out.push(part);
      });
    } else out.push(t);
  }
  return out;
}

export function parse(text) {
  if (typeof text !== "string" || !text.trim()) throw new SpdxError("empty license expression");
  const toks = tokenize(text.trim());
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;
  function atom() {
    const t = toks[i++];
    if (t === undefined) throw new SpdxError(`unexpected end of ${JSON.stringify(text)}`);
    if (t === "(") {
      const e = expr();
      if (toks[i++] !== ")") throw new SpdxError(`missing ")" in ${JSON.stringify(text)}`);
      return e;
    }
    if (t === ")" || ["AND", "OR", "WITH"].includes(t.toUpperCase())) {
      throw new SpdxError(`unexpected ${JSON.stringify(t)} in ${JSON.stringify(text)}`);
    }
    return { id: t };
  }
  function withExpr() {
    const a = atom();
    if (isOp(peek(), "WITH")) {
      i++;
      const exc = toks[i++];
      if (!exc || !a.id) throw new SpdxError(`bad WITH in ${JSON.stringify(text)}`);
      return { id: a.id, exception: exc };
    }
    return a;
  }
  function andExpr() {
    const parts = [withExpr()];
    while (isOp(peek(), "AND")) {
      i++;
      parts.push(withExpr());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  function expr() {
    const parts = [andExpr()];
    while (isOp(peek(), "OR")) {
      i++;
      parts.push(andExpr());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  }
  const e = expr();
  if (i !== toks.length) throw new SpdxError(`trailing ${JSON.stringify(toks.slice(i).join(" "))} in ${JSON.stringify(text)}`);
  return e;
}

const allowedIds = new Set([...ALLOWED_LICENSES].map(lower));
const allowedWith = new Set([...ALLOWED_WITH].map(lower));

function ok(node) {
  if (node.or) return node.or.some(ok);
  if (node.and) return node.and.every(ok);
  const id = node.id.replace(/\+$/, "");
  if (node.exception) return allowedWith.has(lower(`${id} WITH ${node.exception}`));
  return allowedIds.has(lower(id));
}

/** `{ ok, reason }` for an SPDX expression under the policy. */
export function evaluate(text) {
  try {
    return ok(parse(text)) ? { ok: true } : { ok: false, reason: `license ${JSON.stringify(text)} is not allowed` };
  } catch (e) {
    if (e instanceof SpdxError) return { ok: false, reason: `unparsable license ${JSON.stringify(text)}: ${e.message}` };
    throw e;
  }
}

/** The license expression declared by a package.json, or undefined. */
export function manifestLicense(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === "object" && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    const ids = pkg.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    if (ids.length) return ids.length === 1 ? ids[0] : `(${ids.join(" OR ")})`;
  }
  return undefined;
}
