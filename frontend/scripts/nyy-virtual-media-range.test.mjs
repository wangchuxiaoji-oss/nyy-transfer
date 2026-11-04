import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/nyy-virtual-media-sw.js", import.meta.url), "utf8");
const context = {
  self: { addEventListener() {} },
  Response,
  Headers,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  console,
};
vm.runInNewContext(`${source}\nglobalThis.__responseMatchesRange = responseMatchesRange;`, context);
const responseMatchesRange = context.__responseMatchesRange;

test("接受不带 Range 的普通成功响应", () => {
  assert.equal(responseMatchesRange(new Response(null, { status: 200 }), {}), true);
});

test("拒绝忽略 Range 的 200 响应", () => {
  assert.equal(responseMatchesRange(new Response(null, { status: 200 }), { headers: { Range: "bytes=10-19" } }), false);
});

test("只接受 Content-Range 和请求区间完全匹配的 206", () => {
  const response = new Response(null, {
    status: 206,
    headers: { "Content-Range": "bytes 10-19/100", "Content-Length": "10" },
  });
  assert.equal(responseMatchesRange(response, { headers: { Range: "bytes=10-19" } }), true);
  assert.equal(responseMatchesRange(response, { headers: { Range: "bytes=11-19" } }), false);
});

test("拒绝缺失或不匹配的区间及长度", () => {
  const range = { headers: { Range: "bytes=10-19" } };
  assert.equal(responseMatchesRange(new Response(null, { status: 206 }), range), false);
  assert.equal(responseMatchesRange(new Response(null, {
    status: 206,
    headers: { "Content-Range": "bytes 10-19/*" },
  }), range), false);
  assert.equal(responseMatchesRange(new Response(null, {
    status: 206,
    headers: { "Content-Range": "bytes 10-19/100", "Content-Length": "9" },
  }), range), false);
});

test("拒绝非 206 的 ranged response，包括 416", () => {
  const range = { headers: { Range: "bytes=10-19" } };
  assert.equal(responseMatchesRange(new Response(null, { status: 416 }), range), false);
});
