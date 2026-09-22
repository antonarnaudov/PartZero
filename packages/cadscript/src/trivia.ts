/** Comment/whitespace ("trivia") helpers shared by the compiler and the edit splicer. */
import ts from "typescript";

/**
 * Start offset of the comments *attached* to a statement: the contiguous run of leading comments
 * directly above it with no blank line in between. Returns `stmt.getStart()` when there are none.
 */
export function attachedCommentStart(sf: ts.SourceFile, stmt: ts.Node): number {
  const text = sf.text;
  let cursor = stmt.getStart(sf);
  const ranges = ts.getLeadingCommentRanges(text, stmt.pos) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const c = ranges[i]!;
    const gap = text.slice(c.end, cursor);
    if (/\S/.test(gap) || (gap.match(/\n/g)?.length ?? 0) > 1) break;
    cursor = c.pos;
  }
  return cursor;
}

/** The raw text of the comments attached to `stmt` (see {@link attachedCommentStart}), if any. */
export function attachedComments(sf: ts.SourceFile, stmt: ts.Node): string | undefined {
  const start = attachedCommentStart(sf, stmt);
  const end = stmt.getStart(sf);
  if (start === end) return undefined;
  return sf.text
    .slice(start, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Offset of the start of the line containing `pos`. */
export function lineStart(text: string, pos: number): number {
  const i = text.lastIndexOf("\n", pos - 1);
  return i + 1;
}

/**
 * Offset just past the end of the line on which a statement ends, including a trailing same-line
 * comment and the newline itself. If other code follows on the same line, returns `end` unchanged.
 */
export function endOfStatementLine(text: string, end: number): number {
  let i = end;
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i++;
    if (i >= text.length) return i;
    if (text[i] === "\n") return i + 1;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      return nl === -1 ? text.length : nl + 1;
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return text.length;
      const block = text.slice(i, close + 2);
      if (block.includes("\n")) return end;
      i = close + 2;
      continue;
    }
    return end;
  }
}

/** Is everything between the start of `pos`'s line and `pos` whitespace? */
export function onlyWhitespaceBefore(text: string, pos: number): boolean {
  return !/\S/.test(text.slice(lineStart(text, pos), pos));
}
