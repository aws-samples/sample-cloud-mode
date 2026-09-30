// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const test = require("node:test");
const assert = require("node:assert");

test("smoke: string concatenation", () => {
  assert.strictEqual("foo" + "bar", "foobar");
});
