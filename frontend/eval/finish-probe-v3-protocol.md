# Finish probe v3: finishing cut answers after fixing the design

Written before the first paid call of `finish-probe-v3`. The commit that holds this file also holds the code (`finishProbeV3.js` and the files in its `V3_FILES`). Everything in [finish-probe-protocol.md](finish-probe-protocol.md) stands unless this file changes it. The v2 protocol and addendum describe v2 only.

## Why v3

The question is the one of v1: can an extra call of the same model recover a useful answer that was lost to a cut, and is it worth testing the method in the A8 against S8 comparison? v2 is closed, with the decision "no change" under both readings of its 404 cells. Its report describes faults of the design without fixing them: the cap of 2048 decides criterion 1 for StepFun, whose reasoning is mandatory; the StepFun control C is cut at that cap almost every time; the pinned hy4 route (Cohere) is gone; the pilot of four texts per route was too small to show either.

v3 is a new exploratory round on the same 115 cut inputs and 18 cut syntheses of `a8-open-v5e`, read only. It answers three questions in order:

| Check | What it establishes |
| --- | --- |
| F gives an accepted answer | the finishing mode works technically |
| F gives correct answers and beats C | the saved text helps under these settings |
| The finished answers change the recount of the arms | there is use for the votes and for A8 against S8 |

The best outcome is "a confirming measurement on new questions is recommended". Campaign code does not change.

## What stays

The prompts (`FINISH_INSTRUCTION`, `CONTROL_INSTRUCTION`), temperature 0.7 and `top_p` 1, the reasoning efforts of the v1 pilot (StepFun `low`, hy4 `none`, DeepSeek `none`), the accepted-answer rule and its strict parser, the stream deadline of 900 s, `retryLimit` 1, `require_parameters`, the thresholds of criteria 1 to 4, the 51 frozen labels of v2 (`finish-probe-v2-labels.json`), the policies, and the sensitivity set (107 inputs without HMMT 17 and q752d).

## What changes

1. **New cells.** 230 cells, 115 inputs times F and C, and F on the 18 syntheses, in one slot journal (`.runs/finish-probe-v3/main/events.jsonl`). No answer of v1 or v2 is carried over. T is not repeated. A cell gets at most one generation.
2. **Caps.** StepFun 8192, a quarter of its campaign cap 32768: one value, no ladder. hy4 and DeepSeek keep 2048. `inspect` and the tests check that the payloads carry 8192 and 2048, and the route phase checks that each endpoint allows that output.

   | Route | Inputs | Cap of F and C | Accepted F needed |
   | --- | --- | --- | --- |
   | StepFun | 80 | 8192 | 72 of 80 |
   | hy4 | 21 | 2048 | 19 of 21 |
   | DeepSeek | 14 | 2048 | 13 of 14 |

3. **hy4 goes through a substitute host** when Cohere is not listed (below).
4. **An incomplete set is read with bounds** (below), so a failure of the method is told apart from a missing measurement.
5. **The recommendation also needs a win in the recount of the arms.**

## Cell states

- **accepted**: a generation came back and the rule accepts it.
- **rejected** (confirmed, not accepted): a generation came back and is not accepted: cut at the cap or the loop guard, answer only inside the reasoning, not read by the strict parser, a call that failed after generating, or a stream stopped by the 900 s deadline.
- **not measured**: refused before any generation and not asked again: a 404 "No endpoints found", another HTTP error with no generation, or three capacity refusals used up.
- **outcome unknown**: a POST without a recorded outcome (the runner stopped mid-stream, the connection dropped, no first response). It is never sent again and is not counted as a failure.
- **not sent**: no POST yet, or refused for capacity and waiting for its cooldown.

A capacity refusal before generation is asked again after its cooldown, up to three POSTs per cell. The count is read from the slot journal, so it survives a restart. After a generation there are no repeats.

## Stages

1. **StepFun F on its 80 inputs**, in the hash order of seed `finish-probe-v3-order`, in batches of at most six. After each batch: with nine confirmed failures the stage ends as failed, because 80 − 9 < 72; capacity refusals and unknown POSTs are not among the nine. When accepted plus not sent falls below 72, a pass can no longer be shown and the stage ends as "insufficient measurements". The stage passes when nothing is pending and 72 are accepted. The report gives the actual numbers of the part that was sent.
2. **Only after a pass:** StepFun C on the same 80 inputs, and hy4 and DeepSeek with F and C of one text next to each other. Then criteria 1 to 4 are computed (2 and 3 on the 51 labels). Stage 3 is paid only when all four pass on the three routes.
3. **F on the 18 cut syntheses**; then, if it fits in what is left of the budget, labels for the other 64 inputs by the same two OpenRouter models. Criteria 2 and 3 stay on the 51; on all 115 they are shown only.

The runner moves from one stage to the next by itself under these rules. At the start of each launch it reads the endpoint list of every route; a route whose endpoint is not listed is not asked in that launch, and the stage ends incomplete with that reason. A route that answers 404 "No endpoints found" is not asked again in that launch.

## The hy4 route

Cohere is used when it is listed and fits. Otherwise the choice is mechanical: an endpoint of the same model that supports `max_tokens`, `temperature`, `top_p`, and `reasoning`; whose context holds the largest F payload plus the cap (the payload counted in characters, the budget's own ceiling); whose `max_completion_tokens` allows the cap; and whose price, overrides included, is not above the pinned one. Among those: the larger declared precision first (bf16 and fp16, then fp8, then fp4), then the tag; unknown precision last. At most three probe POSTs, in that order, with the same parameters, the neutral prompt "Reply with one word: ready.", `max_tokens` 16, and `stream` false; any reply with a generation will do, `finish_reason: length` included. The provider object is `{ order: [tag], allow_fallbacks: false, max_price: <pinned>, require_parameters: true }`. The chosen tag is written to `route.json` before the first measured call and does not change. All 21 inputs go through it. The five texts measured through Cohere in v1 are compared descriptively. The criteria are computed on the three routes and, apart, without hy4 (N = 94, a difference of nine texts). If hy4 cannot be measured, the result on three routes is incomplete.

## Criteria

A criterion passes when it holds with every unconfirmed cell set against it, fails when it does not hold even with every unconfirmed cell set in its favour, and is otherwise `not_evaluable`. A confirmed cell is accepted or rejected; every other state is unconfirmed.

1. Each route: bounds `a/N` and `(a + u)/N`, with `a` accepted and `u` unconfirmed; the threshold is 90%, compared as `10a >= 9N`.
2. Firm: at least `ceil(0.8 x N)` correct, and the mean over questions at least 4/5.
3. Firm and candidate: at least `ceil(0.5 x N)` correct, and the mean over questions at least 1/2.
4. All inputs: `115 x (K_F - K_C) >= 10 x N`, and the mean over questions of F − C at least 2/23. The low bound sets an unconfirmed F wrong and an unconfirmed C right; the high bound the other way. N = 115 needs 10 texts, N = 107 needs 10, N = 94 needs 9.

Counts are integers and the means over questions are exact fractions. An empty group does not pass. Shown with them: the sensitivity set, the set without hy4, leaving out one question, the share of accepted C by route (below 90% is flagged: the mechanism of extraction is not established), criterion 4 inside each route, and the agreement of F with the value both labelling passes accepted, on every text that has one. The distribution of completion tokens at 8192 is always shown and is not presented as a result of the 2048 mode.

## Recount of the arms (free, whatever the outcome)

B8, P8, the vote of five, A8, and S8 under the stored rules of canonisation, abstention, and ties. Only cut slots are replaced; the shared first answer of B changes everywhere it is used. Policy fill is primary; "all vote" is shown only. For each arm: wins, losses, unchanged, and undetermined (the arm reads a cell with no confirmed outcome). The A8 − S8 difference on the primary set comes from `comparePair`. Each policy is compared with the stored arms and with the fallback, which uses finished answers only. **Only a win over the fallback counts for the recommendation**, because the fallback already changes A8 and S8 without any extra answer. Under fill a loss is impossible by construction. Price and time of the F calls, failed ones included, are shown apart. `inspect` checks that, with no extra answer, fill equals the fallback and the fallback keeps the stored B8, P8, and vote of five on all 269 questions.

## Labels for the other 64 inputs (shown only)

Stage 3 only. Pass A `openai/gpt-6.1-sol`, pass B `google/gemini-4-argon`, effort `low`, the instruction, excerpts, full-text request, and repeats of v2, without golds or arms. They run only if v2's mean cost per text and pass, times 128, fits in the money left, and 128 POSTs fit too. The groups come from the code of v1 and go to `finish-probe-v3-labels.json`.

## Money and failures

Limits: **$10 and 500 POSTs** for all of v3, in one budget journal for every POST: F, C, syntheses, route probes, labels, and analysis. Each POST holds its worst case until its cost is known; a POST without a cost stays held. A POST without an outcome is not repeated. If a route is not listed, nothing is sent and the stage ends incomplete. The key is audited at the start and end of every live phase; the report compares the key with the journal and does not attribute a difference to cells.

`inspect`, from the actual payloads, the prompt tokens measured for the same messages in v1 and v2, and the campaign prices, gives this worst case with every call at its cap:

| Item | Worst case | POSTs without refusals |
| --- | --- | --- |
| Stage 1, StepFun F | $4.40 | 80 |
| Stage 2, StepFun C, hy4, DeepSeek | $2.86 | 150 |
| Stage 3, syntheses | $0.95 | 18 |
| Labels for 64 texts (v2's mean cost) | $2.05 | 128 and full-text requests |
| Route probes | $0.0003 | up to 3 |
| Total | $10.26 | 379 |

The total is above the limit by $0.26, against the plan's preliminary $8.9: the limit binds, and the labels, the last item, run only when they fit. With the stop rule a failing StepFun costs a part of stage 1.

## Decision

| Observation | Conclusion |
| --- | --- |
| Criterion 1, 2, or 3 fails for good | the mode did not reach the threshold; campaigns do not change |
| Measurements are missing | the result is incomplete; the missing ones are listed |
| 1 to 3 pass, 4 does not | the use of the saved text is not shown |
| 1 to 4 pass, fill gives no win over the fallback | nothing to recommend |
| 1 to 4 pass, there are wins | a confirming measurement on new questions for the arms with a win |

On a failure the report gives the counts by observed category: cap, refusal, format, transport.

## Text

The README block is generated by the report code and holds numbers and verdicts only. The "Анализ" section is written by `openai/gpt-6.1-sol` from the report and this protocol and checked against the report by `google/gemini-4-argon`, as in v2. No Anthropic model labels, extracts, grades, or analyses a result.

## Freeze and disclosure

The first live phase writes `manifest.json` before its first POST: the hashes of the v3 files (code, tests, protocols, the v2 labels, the subset, the golds), the digest of the cut texts, the digest of the cell order, and the hashes of the v1 and v2 journals, settings, and manifests. It is never rewritten, and every later live phase refuses to run if any of these changed. The chosen route (`route.json`), the stops (`stops.jsonl`), and the new labels are written separately.

Known when these rules were chosen: v1's interim correctness on 112 cells; the form and token counts of the v2 calls; the v2 decision. The draft of the plan was recorded before the v2 report (`.runs/finish-probe-v2/v3-plan-draft.json`); it was edited later without reading the v2 correctness numbers. While writing the code, the hy4 endpoint list was read once (2026-11-10 01:48 UTC) to confirm the field names the route rule reads: six endpoints, no Cohere. The rule above was fixed in the plan before that.

## Limits of the reading

All 115 texts had been read, the golds and grader changed after the campaign, and the cap was chosen after the v2 data. hy4 on a substitute host is not the pinned route, and the absence of Cohere is stated for the date of the check. StepFun F and C are measured at different times so that a failing StepFun stops cheaply. Finishing the 18 syntheses is not a repeat of A8 and S8 with new inputs; v3 says nothing about the whole pipeline. The firm texts come from 9 questions.
