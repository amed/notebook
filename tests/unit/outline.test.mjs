// Node 22.18+ strips the TypeScript types from the imported source file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownOutline } from "../../src/outline.ts";

function shape(markdown) {
  const simplify = (items) => items.map((item) => ({
    level: item.level,
    text: item.text,
    line: item.line,
    children: simplify(item.children),
  }));
  return simplify(parseMarkdownOutline(markdown));
}

test("builds nested heading levels and keeps skipped levels under their nearest parent", () => {
  assert.deepEqual(shape("# One\n## Two\n#### Four\n## Next\n# Last"), [
    {
      level: 1, text: "One", line: 1, children: [
        { level: 2, text: "Two", line: 2, children: [
          { level: 4, text: "Four", line: 3, children: [] },
        ] },
        { level: 2, text: "Next", line: 4, children: [] },
      ],
    },
    { level: 1, text: "Last", line: 5, children: [] },
  ]);
});

test("supports Setext headings and strips common inline Markdown from labels", () => {
  assert.deepEqual(shape("A **bold** [title](https://example.test)\n===\n\nChild `code`\n---"), [
    {
      level: 1,
      text: "A bold title",
      line: 1,
      children: [{ level: 2, text: "Child code", line: 4, children: [] }],
    },
  ]);
});

test("ignores headings and fence-like text inside fenced code blocks", () => {
  assert.deepEqual(shape("# Visible\n```md\n## Hidden\n```still code\n### Hidden too\n```\n## Visible child"), [
    {
      level: 1,
      text: "Visible",
      line: 1,
      children: [{ level: 2, text: "Visible child", line: 7, children: [] }],
    },
  ]);
});

test("does not mistake a horizontal rule after an ATX heading for Setext", () => {
  assert.deepEqual(shape("# Heading\n---\n\nParagraph"), [
    { level: 1, text: "Heading", line: 1, children: [] },
  ]);
});
