# Finish probe v4: finishing cut answers on new questions

Written and committed before the first test POST of `a8-open-v7`, so before any answer to a v7 test question exists. The commit that holds this file also holds the code (`finishProbeV4.js` and the files in its `V4_FILES`). Everything in [finish-probe-protocol.md](finish-probe-protocol.md) stands unless this file changes it.

**Source moved from a8-open-v6 to a8-open-v7 (2026-11-11, before any POST of v4).** This protocol was first committed for `a8-open-v6` (commit `7eebfa3`). That test was stopped before any question finished: the pinned StepFun host refused StepFun for capacity. `a8-open-v7` asks the same 46 questions with StepFun on another host (see [a8-open-v7-protocol.md](a8-open-v7-protocol.md)). Only the source changes; every rule below is as first committed. v4 had sent nothing and had no manifest.

## Why v4

finish-probe v1 to v3 ran on the 115 cut inputs of `a8-open-v5e`, which had all been read; the series is closed with a summary in the README. v4 asks the question of v1 once more, on questions nobody has read: the 46 ArXivMath test questions of `a8-open-v7`. Its answer is a confirming measurement, not a diagnostic.

## Source

The finished test of `a8-open-v7`, read only, primary questions only. A gold correction file `gold-corrections-a8-open-v7.json` is applied when it exists (its hash goes to the manifest); a question it excludes is not expected. The run refuses to start until every expected primary question is complete.

- **Inputs:** every Stage 1 answer of the council and every sample of B that `cutReasoning` marks as cut (at the cap or the loop guard, with no visible answer). The shared first answer of B is finished once.
- **Syntheses:** every cut synthesis of A8 and S8, condition F, shown only.

## What stays

The prompts (`FINISH_INSTRUCTION`, `CONTROL_INSTRUCTION`), temperature and `top_p` of the route, the lowest reasoning effort the route lists, `evalAnnotations`, the pinned route of the source with `require_parameters` and no fallback, the accepted-answer rule and its strict parser, the stream deadline of 900 s, `retryLimit` 1, one generation per cell, at most three capacity refusals per cell, no repeat of a POST without an outcome, the cell states and the bounds of v3, the policies (fill primary, all shown only), and the rule that only a win over the fallback counts.

## What changes

1. **Conditions F and C only.** T is not run. No labels: no criterion needs them.
2. **One cap of 2048 on every route.** v3 showed that 8192 did not change acceptance of StepFun on the cells it measured; v4 does not repeat that choice.
3. **No early stop.** Every cell is sent, inputs first (F and C of one text next to each other, in the hash order of seed `finish-probe-v4-order`), then the syntheses. Batches of at most six.
4. **Routes.** The council of the source; B and H are in it. Before the first POST of a launch the endpoint list is read: a route whose pinned endpoint is not listed, or lacks `max_tokens`, `temperature`, `top_p`, or `reasoning`, or cannot hold the largest F prompt plus the cap, or costs more than the pinned price, is not asked in that launch, and its cells stay unconfirmed.
5. **Acceptance is shown, not a threshold.** v1 to v3 showed that acceptance depends on whether the text holds an answer, so criterion 1 is dropped. The share of accepted F and C by route is shown.
6. **Criteria and decision** below.

## Criteria

All on the cut inputs, with the v3 bounds: a criterion passes when it holds with every unconfirmed cell set against it, fails when it does not hold even with every unconfirmed cell set in its favour, and is otherwise not evaluable. Counts are integers and the means over questions are exact fractions.

| Criterion | Holds when |
| --- | --- |
| K4, the saved text helps | criterion 4 of v1: `115 × (K_F − K_C) ≥ 10 × N`, and the mean over questions of F − C at least 2/23. Low bound: an unconfirmed F wrong, an unconfirmed C right. |
| KP, accepted answers are right | among the accepted F answers at least half are right, by count and by the mean over questions of the share right among the accepted. Low bound: every unconfirmed F accepted and wrong; high bound: accepted and right. No accepted answer does not pass. |
| KW, use for the arms | fill gives at least one win over the fallback in B8, P8, or the vote of five. A win counts only where the arm reads no unconfirmed cell. Fails when there is no win and nothing is undetermined. |

A8 − S8 under each policy is shown only: N = 46 cannot separate them.

## Decision

The first failing criterion in the order K4, KP, KW decides. With none failing, a criterion that is not evaluable leaves the result incomplete.

| Observation | Conclusion |
| --- | --- |
| No cut input | nothing to finish |
| K4 fails | the saved text is not shown to help on new questions |
| K4 holds, KP fails | the accepted answers are right less than half the time |
| K4 and KP hold, KW fails | fill gives the arms no win over the fallback on this block |
| Measurements are missing | the result is incomplete; the missing ones are listed |
| All three hold | confirmed on new questions for the arms with a win |

No outcome changes campaign code by itself.

## Money and failures

Limits: **$15 and 900 POSTs**, in one budget journal of v4 (`.runs/finish-probe-v4/budget.jsonl`). Each POST holds its worst case, the prompt counted at one token per character, until its cost is known; a POST without a cost stays held. The key is audited at the start and end of each launch. `inspect` gives the worst case from the payloads before any POST. What does not fit stays unconfirmed and is read with the bounds. The analysis calls have their own journal and limits ($0.50, 8 POSTs).

## Freeze

The first live launch writes `manifest.json` before its first POST: the hashes of the v4 files, the commit, and of the source (test journal, selection, campaign, gold file, the digest of the cut texts, the digest of the cell order). It refuses to start if any v4 file is not committed, and every later launch and the report refuse if any of these changed.

## Text

The README block is generated by the report code and holds numbers and verdicts only. The "Анализ" section is written by `openai/gpt-6.1-sol` from the report and this protocol and checked by `google/gemini-4-argon`; it is placed only when the check finds no problem. No Anthropic model labels, grades, or analyses a result.

## Known before these rules

- The results of finish-probe v1 to v3 and their summary.
- The dev, smoke, and pilot answers of `a8-open-v6` and `a8-open-v7`: the 4 ArXivMath dev questions and the ArXivMath smoke question are not test questions.
- The stopped test of `a8-open-v6` left a partial journal on the 46 test questions (28 StepFun calls, Stage 1 of DeepSeek and GLM). No question finished; no session read the text of those answers or graded them. v4 does not read that journal.
- While writing the code, a dry report of v4 was built on the primary questions of `a8-open-v5e` with the v1 and v2 journals, to check the code. Those numbers come from texts already read and are not a result of v4.

## Limits

- One generation per cell; N is set by how many answers the test cuts, which is not known in advance.
- StepFun and GLM list no reasoning effort below `low`, so their finishing calls reason before answering and may reach the 2048 cap.
- The rule uses an extra answer only where there is otherwise none; judges and syntheses saw what they saw in the test. v4 says nothing about a pipeline that would pass finished answers to the judges.
- The ArXivMath golds were not checked independently before the test.
