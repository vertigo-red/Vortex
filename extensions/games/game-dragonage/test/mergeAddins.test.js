const assert = require("node:assert/strict");
const test = require("node:test");

const { mergeAddInItems } = require("../src/mergeAddins");

test("merges a DAZIP manifest into an empty AddIns.xml parse result", () => {
  const item = { $: { UID: "no_helmet_hack", Name: "No Helmet Hack" } };
  const addins = { AddInsList: "" };
  const manifest = { Manifest: { AddInsList: [{ AddInItem: [item] }] } };

  const result = mergeAddInItems(addins, manifest);

  assert.deepEqual(result.AddInsList.AddInItem, [item]);
});

test("preserves existing addins before appending manifest entries", () => {
  const existing = { $: { UID: "existing" } };
  const added = { $: { UID: "added" } };
  const addins = { AddInsList: { AddInItem: [existing] } };
  const manifest = { Manifest: { AddInsList: [{ AddInItem: [added] }] } };

  const result = mergeAddInItems(addins, manifest);

  assert.deepEqual(result.AddInsList.AddInItem, [existing, added]);
});

test("rejects XML whose root is not AddInsList", () => {
  assert.equal(mergeAddInItems({ SomethingElse: {} }, {}), undefined);
});
