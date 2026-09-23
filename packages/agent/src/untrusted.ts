/**
 * Keeping data and instructions apart in prompts (audit M18). Text from the user's file — code,
 * comments, doc text, names, curve ids — and anything derived from it (engine messages, tool
 * results, the spec writer's output) is data. A crafted file must not be able to:
 *
 * - close the fence or tag it is shown in: data blocks are tagged with a per-run nonce on both the
 *   opening and the closing tag, and code fences are longer than any backtick run inside them;
 * - pass itself off as the orchestrator: orchestrator notes start with `[orchestrator <nonce>]`.
 *
 * The nonce is derived from the run's inputs (so a run is reproducible, byte for byte) with a hash
 * the file's author cannot solve for: the file would have to contain the hash of itself.
 */
import { createHash } from "node:crypto";

/** 16 hex characters identifying one run, derived from everything the run starts from. */
export function runNonce(parts: readonly (string | undefined)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["aicad-agent-run/1", ...parts.map((p) => p ?? null)]))
    .digest("hex")
    .slice(0, 16);
}

/** The prefix of every orchestrator note in a run. */
export function orchestratorTag(nonce: string): string {
  return `[orchestrator ${nonce}]`;
}

/**
 * `<tag nonce="…">` … `</tag nonce="…">`: a block that only its own closing tag can end. Whatever
 * the body is, it cannot contain that closing tag or this run's orchestrator tag: both are escaped
 * (they can only be there if the text's author learned the nonce, e.g. a model that was shown it).
 */
export function dataBlock(tag: string, nonce: string, body: string): string {
  const close = `</${tag} nonce="${nonce}">`;
  const safe = body.split(close).join(`<\\/${tag} nonce="${nonce}">`).split(orchestratorTag(nonce)).join(`(quoted: orchestrator ${nonce})`);
  return `<${tag} nonce="${nonce}">\n${safe}\n${close}`;
}

/** A Markdown code fence that no backtick run in `text` can close (CommonMark: a longer fence). */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}
