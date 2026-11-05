// web/src/sigv4.ts against AWS's published SigV4 signing test suite
// (fixtures/sigv4-test-suite.json, from awslabs/aws-c-auth) and the S3
// examples of AWS's "Signature Calculations for the Authorization Header"
// documentation (example credentials only).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalQuery, sha256Hex, sign } from "../../web/src/sigv4.ts";

const suite = JSON.parse(readFileSync(new URL("./fixtures/sigv4-test-suite.json", import.meta.url), "utf8"));

function parseRequest(text) {
  const [head, ...rest] = text.split("\n\n");
  const lines = head.split("\n");
  const first = lines.shift();
  const method = first.slice(0, first.indexOf(" "));
  const target = first.slice(method.length + 1, first.lastIndexOf(" HTTP/"));
  const headers = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^\s/.test(line)) return null; // multi-line value: not expressible in fetch
    const colon = line.indexOf(":");
    headers.push([line.slice(0, colon), line.slice(colon + 1)]);
  }
  return { method, target, headers, body: rest.join("\n\n") };
}

/** Cases outside what S3 requests can be: path normalization, repeated or folded headers, unsigned tokens. */
function skipReason(item, request) {
  if (!request) return "multi-line header";
  if (item.context.omit_session_token) return "unsigned session token";
  const names = request.headers.map(([name]) => name.toLowerCase());
  if (new Set(names).size !== names.length) return "repeated header";
  const path = request.target.split("?")[0];
  if (/(^|\/)\.\.?(\/|$)/.test(path)) return "dot segments";
  if (item.context.normalize && path.includes("//")) return "path normalization";
  return null;
}

test("AWS SigV4 test suite: canonical request, string to sign and signature", async () => {
  let checked = 0;
  const skipped = [];
  for (const item of suite.cases) {
    const request = parseRequest(item.request);
    const reason = skipReason(item, request);
    if (reason) {
      skipped.push(`${item.name} (${reason})`);
      continue;
    }
    const host = request.headers.find(([name]) => name.toLowerCase() === "host")[1].trim();
    const headers = Object.fromEntries(request.headers.filter(([name]) => name.toLowerCase() !== "host"));
    const body = new TextEncoder().encode(request.body);
    const signed = await sign({
      method: request.method,
      url: new URL(`https://${host}${request.target}`),
      headers,
      payloadHash: await sha256Hex(body),
      region: item.context.region,
      service: item.context.service,
      credentials: {
        accessKeyId: item.context.credentials.access_key_id,
        secretAccessKey: item.context.credentials.secret_access_key,
        sessionToken: item.context.credentials.token ?? null,
      },
      now: new Date(item.context.timestamp),
      contentSha256Header: Boolean(item.context.sign_body),
    });
    assert.equal(signed.canonicalRequest, item.canonical_request, `${item.name}: canonical request`);
    assert.equal(signed.stringToSign, item.string_to_sign, `${item.name}: string to sign`);
    assert.equal(signed.signature, item.signature, `${item.name}: signature`);
    checked++;
  }
  assert.ok(checked >= 24, `checked ${checked}, skipped ${skipped.join(", ")}`);
});

const S3_EXAMPLE = {
  region: "us-east-1",
  service: "s3",
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  now: new Date("2013-05-24T00:00:00Z"),
  contentSha256Header: true,
};

test("S3 documentation example: GET Object with Range", async () => {
  const signed = await sign({
    ...S3_EXAMPLE,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { range: "bytes=0-9" },
    payloadHash: await sha256Hex(new Uint8Array()),
  });
  assert.equal(signed.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(
    signed.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(signed.headers["x-amz-date"], "20130524T000000Z");
  assert.ok(!("host" in signed.headers), "the browser sets Host itself");
});

test("S3 documentation example: PUT Object with a $ in the key", async () => {
  const body = new TextEncoder().encode("Welcome to Amazon S3.");
  const signed = await sign({
    ...S3_EXAMPLE,
    method: "PUT",
    url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
    headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    payloadHash: await sha256Hex(body),
  });
  assert.equal(signed.headers["x-amz-content-sha256"], "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  assert.equal(signed.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("S3 documentation example: GET Bucket (list objects) with a query", async () => {
  const signed = await sign({
    ...S3_EXAMPLE,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
    payloadHash: await sha256Hex(new Uint8Array()),
  });
  assert.equal(signed.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("query values are re-encoded once, empty values kept, pairs sorted", () => {
  assert.equal(canonicalQuery(new URL("https://h/?prefix=a%2Fb%20c&list-type=2&x")), "list-type=2&prefix=a%2Fb%20c&x=");
  assert.equal(canonicalQuery(new URL("https://h/?continuation-token=1%2B2%3D")), "continuation-token=1%2B2%3D");
});

test("a session token is signed and sent", async () => {
  const signed = await sign({
    ...S3_EXAMPLE,
    credentials: { ...S3_EXAMPLE.credentials, sessionToken: "token/with+chars=" },
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/a"),
    payloadHash: await sha256Hex(new Uint8Array()),
  });
  assert.equal(signed.headers["x-amz-security-token"], "token/with+chars=");
  assert.match(signed.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});
