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

function headingText(source: string): string {
  return source
    .trim()
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]+/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
