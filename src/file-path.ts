export interface VaultFilePath {
  directories: string[];
  name: string;
  absolute: string;
}

const RESERVED = new Set(["_deleted", "_delete", ".secure-vault-trash", ".secure-vault-dir"]);

/**
 * Parses the path entered by the new-file dialog. Paths are rooted at the
 * vault, missing filename extensions become `.md`, and every path component
 * is validated before any remote folder is created.
 */
export function parseVaultFilePath(input: string): VaultFilePath {
  const source = input.trim();
  if (!source) throw new Error("Enter a file path.");
  if (source.includes("\\") || source.includes("\0")) {
    throw new Error("Use / between folders; backslashes are not valid in vault names.");
  }
  if (source.endsWith("/")) throw new Error("The path must end with a file name.");
  const parts = source.split("/").filter(Boolean).map((part) => part.trim());
  if (!parts.length || parts.some((part) => !part)) throw new Error("Every folder and file needs a name.");
  for (const part of parts) validatePart(part);
  let name = parts.pop()!;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) name += ".md";
  validatePart(name);
  const directories = parts;
  return { directories, name, absolute: `/${[...directories, name].join("/")}` };
}

function validatePart(part: string): void {
  if (part === "." || part === ".." || RESERVED.has(part.toLocaleLowerCase())) {
    throw new Error(`“${part}” is reserved and cannot be used here.`);
  }
  if (new TextEncoder().encode(part).length > 255) {
    throw new Error(`“${part}” is longer than 255 bytes.`);
  }
}
