import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords } from "../../src/word-count.ts";

test("counts words across ASCII and Unicode whitespace", () => {
  for (const text of ["", "   \n", "one", "one two", " one\u00a0two\u3000three ", "a\u2028b\ufeffc"]) {
    const expected = text.trim() ? text.trim().split(/\s+/u).length : 0;
    assert.equal(countWords(text), expected, JSON.stringify(text));
  }
});

test("counts a million words without constructing a million-element array", () => {
  assert.equal(countWords("word ".repeat(1_000_000)), 1_000_000);
});

test("counts characters as Unicode code points", async () => {
  const { countCharacters, countText } = await import("../../src/word-count.ts");
  for (const text of ["", "abc", "a b\n", "é", "😀", "a😀b", "👩‍💻", "\ud83d", "\ude00x", "x\ud83d"]) {
    assert.equal(countCharacters(text), [...text].length, JSON.stringify(text));
  }
  assert.deepEqual(countText("two words 😀"), { words: 3, characters: 11 });
});
