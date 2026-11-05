/** Count whitespace-delimited words without allocating one string per word. */
export function countWords(text: string): number {
  let count = 0;
  let inWord = false;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const space = (code >= 9 && code <= 13)
      || code === 32 || code === 160 || code === 5760
      || (code >= 8192 && code <= 8202)
      || code === 8232 || code === 8233 || code === 8239
      || code === 8287 || code === 12288 || code === 65279;
    if (space) {
      inWord = false;
    } else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

/** Unicode code points, so an emoji or another astral character counts once. */
export function countCharacters(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const code = text.charCodeAt(index);
    if (code < 0xd800 || code > 0xdbff) continue;
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) {
      count--;
      index++;
    }
  }
  return count;
}

type TextCounts = { words: number; characters: number };

export function countText(text: string): TextCounts {
  return { words: countWords(text), characters: countCharacters(text) };
}
