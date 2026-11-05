// Fills the dev server's test bucket (./test-s3.ts) with the sample notes,
// through the real Vault and codec. Loaded with Vite's module loader on the
// first request, not by the config: the app modules it needs import
// without file extensions, which Vite's config loader warns about.

import { NotebookV1Codec } from "../src/codec.ts";
import { type RemoteStore, Vault } from "../src/vault.ts";
import { SAMPLE_NOTES, TEST_NOTEBOOK } from "./test-notebook.ts";

export async function seed(bucket: RemoteStore): Promise<void> {
  const codec = await NotebookV1Codec.create(TEST_NOTEBOOK.phrase);
  try {
    const vault = new Vault({ bucket: TEST_NOTEBOOK.bucket, region: TEST_NOTEBOOK.region, prefix: "", endpoint: null }, codec, bucket);
    await vault.load();
    for (const [path, text] of SAMPLE_NOTES) await vault.createDocument(path, text);
  } finally {
    codec.wipe();
  }
}
