# a8-open-v6: the postponed ArXivMath block

Written before the first paid call of `a8-open-v6`. The commit that holds this file also holds the code it names. Everything in the `a8-open-v5` section of [README.md](README.md) stands unless this file changes it.

## Why

`a8-open-v5c` postponed the ArXivMath block (MathArena ArXivMath 08 and 09.2026, numeric subset): at a cap of $100 it alone would have cost about $37 and kept the pilot gate from passing. Its 46 test questions and 4 dev questions have never been sent to an arm. v6 runs it as the only primary block.

The question is the one of v5: how the accuracy of the frozen pipelines A8 and S8 differs on these questions under the given caps, routes, retry rules, and parsing. With N = 46 a direction is shown only for a large difference. v6 is not pooled with v5e as a test.

## What stays

The method of v5 at the source hash recorded in `campaign.json`: the arms (A8, S8, P8, B8), the profile, `--caps max` (one cap of 32768 on every stage), the stream deadline, the loop guard, the tail rule, attempts and capacity refusals, the strict parser, the Holm family, and the reading rules (McNemar direction, the 95% interval for a gain above 5 pp, the 90% interval for equivalence within ±5 pp). Dev selects B = H and the council of three by the stored rule.

## What changes

1. **Routes.** `--routes-from a8-routes-v6`: the route snapshot of `a8-open-v4` with one route replaced. The pinned Cohere host of `tencent/hy4-preview` is no longer listed. `a8Repin.js` replaces it by the rule of finish-probe-v3: an endpoint of the same model that takes `max_tokens`, `temperature`, `top_p`, and `reasoning`; holds 5 × cap + 8000 prompt tokens plus the cap; allows the cap as output; and costs no more than the pinned route. Among those, the larger declared precision first, then the tag, unknown precision last. The rule reads only the endpoint list. The choice, the list, and the reasons are in `.runs/a8-routes-v6/repin.json`. The other four candidates keep their pinned hosts; the repin stops if one of them is not listed.
2. **Blocks.** `--blocks arxiv`. The code always adds the legacy blocks (AIME, GPQA, MMLU) to dev, smoke, and the pilot. The test runs with `--primary-only`, so it sends only the 46 ArXivMath questions; the 120 legacy questions are not sent.
3. **No replay.** `--from` needs the same blocks, so nothing of v5 is reused. Dev, smoke, and the pilot are paid again, and dev selects the council anew on 28 questions (24 legacy, 4 ArXivMath).
4. **Caps of the campaign.** $90 and 4000 POSTs, fixed at preflight. The pilot gate compares the stress forecast of the primary set, `max(1.5 × mean, dearest pilot question) × 46`, with what is left. The key limit, not this cap, bounds the actual spend.

## Gate before the test

After the pilot, `a8Gate.js` writes `gate.json`. The test starts only when all three hold:

- **money:** the pilot gate of the campaign passed;
- **measurable:** at least 2 of the 12 Stage 1 answers of the selected council on the 4 ArXivMath dev questions are read as an answer, or A8 or S8 reads an answer on at least one ArXivMath pilot question;
- **key:** the key's remaining limit is at least the base forecast of the primary set (mean × 46). If the key runs out mid-test, the campaign pauses and resumes once the limit is raised.

Even when all three hold, the work stops here for the user's decision. If the gate does not pass, the test is not run.

## Golds

The ArXivMath golds were not checked independently before v6. A separate check reads only the questions, the golds, and the source papers, never an answer of a model (`tools/arxiv_gold_checks/`). A correction file `gold-corrections-a8-open-v6.json` committed before the first test POST is recorded by hash in `gate.json` and applied by `report --gold-overrides`. A correction found after the first test POST is shown as a sensitivity row only.

## Finishing cut answers

`finish-probe-v4` measures finishing on the cut answers of this test. Its protocol and code are written and committed after the gate and before the first test POST, so before any v6 answer exists.

## Known before these rules

- In the `a8-open-v5b` probe, every route reached the 32768 cap on the ArXivMath smoke question without an answer.
- While planning v6, one test question's text (the start of `arxivmath-0826:1`) was printed in a Claude session to check the bank format. No answer of any model to an ArXivMath test or dev question exists.
- The cost per question is extrapolated from that one probe question and the v5e roster; the v6 roster is selected on its own dev.

## Limits

- hy4 on another host and another declared precision is not the route of v5e.
- Dev has 24 legacy questions of 28, so the selection mostly reflects the legacy blocks.
- In seven ArXivMath questions the statement admits +∞; the `number` instruction excludes it.
- The chronology groups depend on the listing dates of the selected models.

## Corrections after the paid preparation (2026-11-10, before any test POST)

Added after probe, dev, smoke, the pilot, and the gate had run. The text above is unchanged and no rule changes; these lines correct statements that a check found wrong or unverified.

- **Key limit mid-test.** "The campaign pauses and resumes once the limit is raised" is not verified. What OpenRouter answers when a key reaches its limit was not observed. The code lifts a pause only for a 403 that names the key limit (`key_budget`) and, by the account balance, for a recognised 402 (`insufficient_funds`); any other 402 becomes `payment_unknown`, which no code path lifts. A resume also needs the phase to be launched again. The test should therefore start only with the key funded for the stress forecast, so that the limit is not reached.
- **Gold check.** The folder `tools/arxiv_gold_checks/` named above was created by another session and no longer exists in the repository; no correction file exists. The rule for corrections stands as written.
- **Finishing.** "Before any v6 answer exists" means before any answer to a v6 test question. Dev and pilot answers to the four ArXivMath dev questions and the smoke question exist.
