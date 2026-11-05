// The test notebook of `npm run dev:web`: an in-memory S3 bucket served by
// the dev server (./test-s3.ts) and filled with the sample notes below,
// encrypted with the real codec. The connect form is pre-filled with these
// values in dev builds only (web/src/app.ts); none of it is in `npm run
// build:web`. Edits live in the dev server's memory until it restarts.

export const TEST_NOTEBOOK = {
  /** Where the dev server answers S3 requests, on its own origin. */
  path: "/__test-s3",
  bucket: "test-notebook",
  region: "us-east-1",
  accessKeyId: "TESTKEY",
  secretAccessKey: "test-secret",
  phrase: "test",
} as const;

const journal = Array.from({ length: 24 }, (_, index) => {
  const day = String(index + 1).padStart(2, "0");
  return `## 2026-10-${day}\n\nA long note to try scrolling and typing with the keyboard open. Entry ${index + 1}: wrote a little, read a little, went for a walk.\n`;
}).join("\n");

/** Logical paths and texts; folders are created on the way. */
export const SAMPLE_NOTES: readonly (readonly [string, string])[] = [
  ["Welcome.md", `# Test notebook

This notebook exists only while \`npm run dev:web\` runs. Edits are kept in the dev server's memory and are gone when it restarts.

## Things to try

- [x] Open the last note after a reload
- [ ] Edit on a phone-sized window, then wait a moment: it saves by itself
- [ ] Switch to **Preview** and back

## Links

- [The roadmap](Project%20Pipeline/Roadmap.md)
- [[games]] as a wikilink
- [A heading on this page](#links)
- [An external link](https://example.com) asks first

## Formatting

Some *italic*, **bold** and \`code\`.

> A quote.

| Column | Value |
| --- | --- |
| One | 1 |
| Two | 2 |

\`\`\`js
console.log("hello");
\`\`\`
`],
  ["Project Pipeline/games.md", `# Games pipeline

A focused list for the current game research.

## Next up

- [x] Define the collection model
- [ ] Add cover images
- [ ] Review the release checklist

Back to [[Welcome]].
`],
  ["Project Pipeline/Roadmap.md", `# Roadmap

## Now

- Mobile editing

## Later

- Images
- Offline edits
`],
  ["Personal/Shopping list.md", `# Shopping list

- [ ] Milk
- [ ] Bread
- [x] Coffee
`],
  ["Personal/Journal.md", `# Journal\n\n${journal}`],
  ["Page.html", `<!doctype html>
<html>
  <head><title>Page</title></head>
  <body style="font-family: system-ui; padding: 1rem">
    <h1>An HTML page</h1>
    <p>HTML notes render in a sandboxed frame, without scripts.</p>
  </body>
</html>
`],
  ["Plain text.txt", "A plain text note.\nNo Markdown here.\n"],
];
