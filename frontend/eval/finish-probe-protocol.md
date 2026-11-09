# Finish probe: protocol

Fixed before the first paid call of `finish-probe-v1`. The commit that holds this file also holds the code, the labels, and the list of labelled texts.

## Question

When a saved answer was cut at the token cap or by the loop guard and has no visible answer, can a short extra call recover a final answer? The source is the finished campaign `a8-open-v5e`, read only. This is a diagnostic: the test set had been read, the golds and the grader changed after the run, and the rule was written after reading these texts.

## Rule

An extra answer is used only where there is otherwise no answer. Judges and syntheses see what they saw in v5e, so this version of the rule needs no new run of the pipeline.

- **Trigger:** `cutReasoning(result)`, with `finishReason` taken from the slot when the result lacks it. The gold plays no part.
- **Sources:** 115 cut inputs and 18 cut syntheses on the 269 kept questions. The shared first answer of B is finished once per condition. A slot is found by the text the question used.
- **Call:** same model and pinned route, same temperature and `top_p`, `evalAnnotations`, the lowest reasoning effort the route lists, output cap 2048, `require_parameters`.
- **Accepted answer:** the call succeeded, it did not end at the cap or the loop guard, the content did not fall back to reasoning, and the strict parser read the last line. Anything else is no answer. A cut extra call is not finished again.
- **Repeats:** a capacity refusal before generation stays pending and is asked again after its cooldown, by a later launch of the runner. A POST with no recorded outcome is never sent again automatically and its reserve is not released on assumption. `retryLimit` is 1.

| Condition | Text | Sources |
| --- | --- | --- |
| F, primary | all of `result.content` | 115 + 18 syntheses |
| T | `slice(-8000)` | 115 |
| C, control | none | 115 |

The prompts are `FINISH_INSTRUCTION` and `CONTROL_INSTRUCTION` in `finishProbe.js`, after `answerPrompt(task)`.

## Policies

Computed without network, ties by `PLURALITY_SEED`.

| Policy | B8 | P8, vote of five | Cut chairman, A8 | Cut synthesis, S8 |
| --- | --- | --- | --- | --- |
| original | as stored | as stored | no answer | no answer |
| fallback | as stored | as stored | finished leader | vote of finished samples |
| **fill (primary)** | extra answer | extra votes only with no real vote | finished leader, else the leader's extra answer | vote of finished samples, else vote of extra answers |
| all (shown only) | extra answer | every extra answer votes | as in fill | vote of all, extra answers included |

The leader of a cut A8 is found through Candidate #1 in the stored chairman request. Fill, all, and the chain are computed for F, T, and C. For the 18 syntheses: fallback against the finished synthesis, and the chain accepted, then finished synthesis, then fallback, then nothing. Those are shown only.

## Labels

Two independent passes over the 51 texts in `finish-probe-subset.json`, without golds or arms. Excerpts are chosen without the gold: the last 8000 characters and 30 fragments evenly spaced over all matches of `answer` and `final`. A pass may open the full text. A pass records current values, a status (accepted, leading, none), and earlier values. Groups come from comparing those with the corrected gold through `canonAnswer`.

| Group | Definition |
| --- | --- |
| firm | the accepted value equals the gold |
| candidate | the gold is among the leading values |
| switched | the gold is among the earlier values and is not current |
| none | the gold was not treated as an answer |

If the two passes give different groups, the final group is candidate. The other 64 inputs stay unlabelled.

Each pass was split into three batches of 17 texts, one agent per batch. A safety filter refused two batch runs (batch 3 of pass A, batch 1 of pass B). Each was repeated once, with the same request and model, and then completed. The passes disagree on the group of 2 of the 51 texts. Final groups: firm 25, candidate 6, none 20.

## Pilot

Four texts per route: all 7 eligible texts from dev, then 5 from test by a fixed hash, without regard to groups. Three conditions, 36 calls. Correctness is not computed and these answers do not enter the main run. If more than 20% of a route's F calls end at the cap, that route's cap is raised once to 4096 and its pilot is repeated. The prompt is not changed. If a route accepts no F call, the experiment stops.

## Main run

363 calls. Groups of F, T, C per source in a fixed hash order, originals before syntheses, concurrency 3. It does not stop on interim correctness. One process, and no other spending on the key during the run. Limits: $10 and 500 POSTs across pilot and main.

## Criteria (F, settings after the pilot)

1. Each route: at least 90% of F calls on inputs give an accepted answer.
2. Firm: correct at least `ceil(0.8 x N)`, and the mean over questions at least 0.8.
3. Firm and candidate: correct at least `ceil(0.5 x N)`, and the mean over questions at least 0.5.
4. On all inputs the share correct under F exceeds C by at least 10/115, on texts and on the mean over questions.

An empty group does not pass. An incomplete set leaves the affected criteria undetermined.

- 1, 2, or 3 fails: the result is recorded and campaign code does not change.
- Only 4 fails: the contribution of the reasoning is not shown; plain re-asking would be a separate decision.
- 1 to 4 pass: a confirming measurement with the fill policy is recommended.
- A good T does not become primary afterwards.

Sensitivity: without HMMT 17 and q752d, whose reading is disputed. Leave-one-question-out and agreement with the accepted value are shown. These thresholds screen; they do not prove. The 51 texts were picked for a detectable gold, so the estimate on all 115 is required.
