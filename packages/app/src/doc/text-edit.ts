/**
 * Source-level edits. A transaction stores the minimal single-range replacement between the
 * before and after text; its inverse is the same range with `removed` and `inserted` swapped.
 */
export interface TextEdit {
  /** UTF-16 offset where the replacement starts. */
  offset: number;
  removed: string;
  inserted: string;
}

/** The minimal single-range edit turning `before` into `after` (common prefix/suffix trimmed). */
export function diffText(before: string, after: string): TextEdit {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // Do not split a surrogate pair.
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
    endB--;
    endA--;
  }
  if (endB < before.length && isLowSurrogate(before.charCodeAt(endB))) {
    endB++;
    endA++;
  }
  return { offset: start, removed: before.slice(start, endB), inserted: after.slice(start, endA) };
}

export function applyEdit(text: string, edit: TextEdit): string {
  const actual = text.slice(edit.offset, edit.offset + edit.removed.length);
  if (actual !== edit.removed) {
    throw new Error(`edit does not apply at offset ${edit.offset}: expected ${JSON.stringify(edit.removed)}, found ${JSON.stringify(actual)}`);
  }
  return text.slice(0, edit.offset) + edit.inserted + text.slice(edit.offset + edit.removed.length);
}

export function invertEdit(edit: TextEdit): TextEdit {
  return { offset: edit.offset, removed: edit.inserted, inserted: edit.removed };
}

export function isNoop(edit: TextEdit): boolean {
  return edit.removed === edit.inserted;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
