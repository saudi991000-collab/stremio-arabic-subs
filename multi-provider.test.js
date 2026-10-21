import test from "node:test";
import assert from "node:assert/strict";
import { MultiProvider } from "../src/providers/multi.js";

test("merges successful providers and isolates a failed provider", async () => {
  const provider = new MultiProvider([
    { id: "one", async search() { return [{ fileId: 1, fileName: "one.srt" }]; } },
    { id: "broken", async search() { throw new Error("temporary failure"); } },
    { id: "two", async search() { return [{ fileId: 2, fileName: "two.srt" }]; } }
  ]);
  const results = await provider.search({}, 1);
  assert.deepEqual(results.map((item) => item.provider), ["one", "two"]);
});
