# Finish probe v2: addendum after an audit

Written while the v2 main pass was running (71 of 251 cells), after an audit of the plan, the v1 and v2 protocols, and the code. At that point the form of the v2 calls had been read (accepted, cut at the cap, failed), and no v2 correctness number. v1's interim numbers on 112 cells had been seen earlier. [finish-probe-v2-protocol.md](finish-probe-v2-protocol.md) stands unless this file changes it. No request, route, cap, label, criterion, or threshold changes. The code for sections A and B is committed after the main pass ends, because the runner refuses to relaunch once its files change; this file is committed first.

## A. The hy4 route is gone

From the first v2 launch (2026-11-09 22:42 UTC) every call to `tencent/hy4-preview` returns 404, "No endpoints found". The campaign pinned this model to the provider Cohere (`provider.order: ["cohere"]`, no fallbacks), and Cohere served every hy4 call of v5e and of v1. OpenRouter no longer lists a Cohere endpoint for the model. The six endpoints it lists belong to other providers, so the pin removes them all. Nothing is generated, and the key audits will show whether anything is billed.

1. **Such a cell was not measured.** A 404 "No endpoints found" before any generation is a refusal before generation, which the plan repeats and does not count as an outcome. Point 6 of v2 ("a call that ended in an error is no answer") applies only to calls that reached a model. In the report these cells are incomplete, with the reason "route unavailable", and the criteria they touch are undetermined. The report also gives the reading of point 6 as first written, where they count as no answer.
2. **One repeat, through the same route only.** When the main pass ends, the endpoint list is read once. If a Cohere endpoint is listed again, each such cell is asked once more, with the unchanged request, in a journal of its own and within the same limits. If not, the cells stay not measured. No other provider is substituted and no parameter is dropped: another host or quantization is not the pinned route, and a second deviation chosen after seeing the run would add a free choice the plan does not allow.
3. An earlier uncommitted draft (`finish-probe-v2-r2.md`) proposed resending these cells without `top_p`. It read the 404 as the pinned endpoint losing `top_p`. The pinned endpoint is Cohere's, which is absent; the endpoint that lacks `top_p` is Tencent's own, which the pin excludes either way. The draft is dropped.
4. The reserves of the 404 calls stay held in the ledger, as the rules require for a call without a cost. The report shows them apart from the money held for calls that may have run.

## B. Corrections to the report

1. **Thresholds are compared in whole texts.** Criterion 4 compared two floating-point shares with 10/115. At a difference of exactly 10 texts that test fails for 29 of the 106 possible pairs of counts. The report compares `F correct - C correct >= 10/115 x N` with a tolerance of 1e-9, and the question means use the same tolerance. Away from the exact threshold nothing changes.
2. **The form of every call is shown by route and condition:** accepted, cut at the cap, answer only inside the reasoning, not read by the strict parser, call failed, not measured, not finished. The v1 pilot had four texts per route and no StepFun F call was cut, so the cap stayed 2048. In the main run StepFun F calls are cut at the cap far more often than the pilot's 20% rule allows (14 of the first 39). The plan raises a cap only in the pilot, so the cap stays; the table lets a reader see how much of criterion 1 is the cap.
3. **The control is described as it is.** StepFun must reason, and its C calls end at the cap (4 of 4 in the pilot, 36 of the first 37 in the main run). For StepFun, criterion 4 therefore compares F with a call that cannot answer in 2048 tokens, not with the model's own knowledge. The report gives criterion 4 by route as well. This is shown only; the criterion and its verdict are computed as frozen.

## C. What was checked and holds

- The v2 requests equal the v1 requests: 12 cells present in both main journals and 6 cells of the v1 pilot have the same request hash.
- No v2 cell was already finished in v1.
- Every policy, given no extra answers, reproduces the stored arms on all 269 questions.
- `ceil(0.8 x N)` is exact for every N up to 140.
- All 96 label values are read by `canonAnswer`. No label call was cut or repeated for a bad reply; 6 of 102 asked for the full text.
- The run started from commit `c571c4d`, which is the freeze.

## D. Limits to state with the result

- The 51 labelled texts come from 11 questions, and the firm ones from 9. Criteria 2 and 3 rest on that many independent units.
- Criterion 1 for StepFun is decided by the cap of 2048 with mandatory reasoning. A failure there says the short call as configured often ends before its answer. It does not say what a larger cap would give; that would be a new experiment.
- Labelling used the paid key ($1.63), outside the $10 of the experiment. The plan had labelling without the paid key.
- The plan repeats a refusal before generation once. The runner asks again after each capacity cooldown, up to 40 launches, and never repeats a 404.
- `finish-probe-v2-protocol.md` says v1's code is not changed. `finishProbe.js` gained six `export` keywords for v2, and nothing else.
