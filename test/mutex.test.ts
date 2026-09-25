// SPDX-FileCopyrightText: 2026 William Andrew Cruz
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { DeadlockTimeoutError, ReentrantAsyncMutex } from "../src/index.js";

test("mutex timeout removes the waiter and lets later work proceed", async () => {
  const mutex = new ReentrantAsyncMutex("timeout-test", 15);
  const releaseHolder = await mutex.acquire();
  const waiting = mutex.acquire();

  assert.equal(mutex.getQueueLength(), 1);
  await assert.rejects(waiting, DeadlockTimeoutError);
  assert.equal(mutex.getQueueLength(), 0);

  releaseHolder();
  const releaseNext = await mutex.acquire();
  releaseNext();
  assert.equal(mutex.isLocked(), false);
});
