# a8-open-v7: the ArXivMath block with StepFun on another host

Written before the first paid call of `a8-open-v7`. Everything in [a8-open-v6-protocol.md](a8-open-v6-protocol.md), its dated corrections included, stands unless this file changes it. The commit that holds this file also holds the code it names.

## Why

The test of `a8-open-v6` was stopped on 2026-11-11 at 03:43 UTC before any of its 46 questions finished: 28 of 368 StepFun calls were done in about five and a half hours. StepFun was B and H, 8 of the 12 calls of each question, and its pinned host `featherless/fp4` refused it for capacity; for the last two hours not one probe call was accepted. The endpoint list then gave `featherless/fp4` status −5, 0% uptime over 30 minutes and 47.5% over a day, and `stepfun/fp8` 100% over both (`.runs/a8-open-v6/stop.json`). The route is part of every request and the routes of v6 are frozen, so the same question needs a new campaign.

## What stays

The method at the same source hash, the bank and the `arxiv` block, `--primary-only`, one cap of 32768 on every stage and the stream deadline of 4216 s, the dev rule that selects B = H and the council, the gate, the golds rule, and the reading rules. finish-probe-v4 reads the test of v7; only its source changes.

## What changes

1. **Host check, then routes.** Before any campaign call, `a8HostCheck.js` sends 12 calls at once to StepFun through `stepfun/fp8` only, with a neutral prompt and `max_tokens` 512. The host is used when at least 10 of 12 come back with a generation and the median speed is at least 10 tokens a second (the deadline needs 7.8). Otherwise StepFun is dropped. The rule was fixed before the calls; the result is in `.runs/a8-routes-v7/hostcheck.json`.
2. **Route snapshot `a8-routes-v7`** from `a8-routes-v6` (hy4 already on `gmicloud/bf16`) by `a8Repin.js` with an explicit cap of 32768:
   - host used: `--model stepfun/step-5-preview --avoid featherless/fp4`, so the repin rule of v6 picks among the other fitting endpoints;
   - host not used: `--drop stepfun/step-5-preview`, four candidates.
   Each candidate must carry the cap (`contextProblems`); the other pinned hosts must be listed.
3. **Caps given explicitly** at preflight (`--stage1-cap`, `--stage2-cap`, `--final-cap` 32768). With StepFun on `stepfun/fp8`, `--caps max` would give 42357 (hy4 on `gmicloud/bf16` binds), so the explicit flags keep the cap of v5e and v6.
4. **No stop at the gate.** The test starts by itself when the gate passes, the detector stopped no stream in smoke or the pilot, and the key and the account each hold at least the stress forecast of the primary set. Otherwise the chain stops for the user.
5. **Pacing of the test** (not part of the method): launches of two passes; the number of questions at once follows what the host accepted (from 4, at most 12); `--model-in-flight` is five per question; after a launch with nothing accepted, one probe question 20 minutes later. A watchdog stops the run at 3300 POSTs or more than 200 in 30 minutes, because the POST cap of the campaign cannot be lifted once reached.

## Known before these rules

- Everything listed in the v6 protocol.
- The dev, smoke, and pilot answers of v6, and its gate.
- The partial test journal of v6 on the same 46 questions. No question finished; no session read the text of those answers or graded them. v7 does not reuse them: replay needs the same routes.

## Limits

- `stepfun/fp8` declares another precision than `featherless/fp4`, the host of v5e and v6.
- Dev runs again on the same 28 questions and may select another roster than v6.
- Without StepFun the system is a different one; on the ArXivMath dev questions DeepSeek and GLM each read an answer on 1 of 4.
- The host check measures short calls; whether streams of twenty minutes hold on the new host is seen only in the campaign.
