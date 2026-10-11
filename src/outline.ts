export interface OutlineItem {
  id: string;
  level: number;
  text: string;
  line: number;
  children: OutlineItem[];
}

interface FlatHeading {
  level: number;
  text: string;
  line: number;
}

/**
 * Extracts Markdown headings without treating fenced code as document
 * structure. Both ATX (`## Title`) and Setext headings are supported, and
 * skipped levels remain children of the nearest preceding shallower heading.
 */
export function parseMarkdownOutline(markdown: string): OutlineItem[] {
  const lines = markdown.split(/\r?\n/);
  const headings: FlatHeading[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      const run = fenced[1]!;
      const marker = run[0] as "`" | "~";
      if (!fence) fence = { marker, length: run.length };
      else if (
        fence.marker === marker
        && run.length >= fence.length
        && /^[ \t]*$/.test(line.slice(fenced[0].length))
      ) fence = null;
      continue;
    }
    if (fence) continue;

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (atx) {
      const text = headingText((atx[2] ?? "").replace(/[ \t]+#+[ \t]*$/, ""));
      if (text) headings.push({ level: atx[1]!.length, text, line: index + 1 });
      continue;
    }

    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    const previousLine = lines[index - 1] ?? "";
    const previous = previousLine.trim();
    const paragraphCandidate = previous
      && !/^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]|\d+[.)][ \t]|`{3,}|~{3,})/.test(previousLine)
      && !/^ {4}/.test(previousLine);
    if (setext && paragraphCandidate) {
      const text = headingText(previous);
      if (text) headings.push({ level: setext[1]![0] === "=" ? 1 : 2, text, line: index });
    }
  }

  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];
  for (const heading of headings) {
    const item: OutlineItem = {
      id: `${heading.line}:${heading.level}:${heading.text}`,
      ...heading,
      children: [],
    };
    while (stack.length && stack.at(-1)!.level >= item.level) stack.pop();
    const parent = stack.at(-1);
    (parent ? parent.children : roots).push(item);
    stack.push(item);
  }
  return roots;
}

/** A code span (kept verbatim) or a backslash escape (its character), as CommonMark reads them. */
const CODE_OR_ESCAPE = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)|\\([!-/:-@[-`{-~])/g;
/** Stands for the code span or escape with the number between the marks while the rest is stripped. */
const PROTECTED = /\uE000(\d+)\uE001/g;

/**
 * The label of a heading's source, close to the text the preview renders
 * (main.ts derives heading ids from it, as preview.rs does from the
 * rendered text): code spans and escaped characters verbatim; links and
 * images give their text; tags and emphasis delimiters go. A `_` inside a
 * word is no delimiter (CommonMark), so `parse_config` keeps it.
 */
export function headingText(source: string): string {
  const kept: string[] = [];
  const protect = (text: string): string => `\uE000${kept.push(text) - 1}\uE001`;
  return source
    .trim()
    .replace(/[\uE000\uE001]/g, "")
    .replace(CODE_OR_ESCAPE, (_match, _run, code: string | undefined, escaped: string | undefined) =>
      protect(escaped ?? codeSpanText(code ?? "")))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*~]+/g, "")
    .replace(/(?<![\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}_])/gu, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(PROTECTED, (_match, index: string) => kept[Number(index)] ?? "");
}

/** A code span's text: one space trimmed from each end when both have one (CommonMark). */
function codeSpanText(code: string): string {
  const text = code.replace(/\r?\n/g, " ");
  return /^ [\s\S]* $/.test(text) && /[^ ]/.test(text) ? text.slice(1, -1) : text;
}
