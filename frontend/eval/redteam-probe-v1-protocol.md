# redteam-probe-v1: what the red team adds after Stage 2

Written and committed before the first paid call of this probe. The code is
`redTeamProbe.js` (with `redTeamProbeCli.js` and `redTeamProbe.test.js`). Every
number and reading comes from that code; the analysis text comes from
OpenRouter models, not from Claude.

## Question

How does the accuracy of the final answer change when the red team is added
after a stored Stage 2, under the rules of the latest a8 protocol (one cap of
32768, stream deadline 4216 s, tail rule, loop guard, pinned hosts) and with
the handling of cut replies and verdicts fixed below?

The primary effect is **Rc − C**: the whole policy of adding the red team (the
extra call, whether its result is admitted, its critique and verdict, and the
change of the council confidence and reasons that follow from it). The probe
does not split the part of the critique from the part of the confidence.

On the 269 scoring questions, Rc − C = (errors of the fresh C that Rc fixes −
right answers of C that Rc breaks) / 269. The stored A8 is not part of it.

## Amendment before the first paid call (2026-11-14)

Added after commit `c6ba1c4` and before any paid call of this probe; no probe
data existed. Reason: published work on LLM critique suggests a one-sided
critic on every question, with a chairman told to follow REFUTED, can break
right answers. The amendment adds policy G, a seventh secondary comparison,
two caveats on the verdict table and a review packet. Nothing else changes:
the conditions, the calls, the primary pair and the reading rules stay as
committed in `c6ba1c4`.

## Why

The red team was measured once, in campaign `main` (free models, 120
questions): A6 (with red team) − A7 (without) = −4.2 pp, 3 wins / 8 losses,
p = 0.227. In that run 13 of 78 red-team replies ended at the cap of 16000 or
32000 tokens, 7 of them had no VERDICT line and the engine defaulted to
CONTESTED, 5 repeated the template `VERDICT: REFUTED | CONTESTED | UPHELD`,
which the engine reads as REFUTED, and 9 calls failed (6 at the 600 s stream
deadline). 4 of the 8 losses of A6 fall on questions whose red-team call hit
the cap. There was no tail rule, no loop guard and no campaign cap. No a8
campaign calls the red team: every A8 chairman prompt says "Red-team review
was unavailable."

## Source

Stored answers of campaign `a8-open-v5e`, test phase, all 271 questions
(council `stepfun/step-5-preview` = B = chairman H, `tencent/hy4-preview`,
`deepseek/deepseek-v4.1-flash-1017`; caps 32768; tail rule 8000 characters;
loop guard; deadline 4216 s; topK 3; self-exclusion on). Stage 1 and Stage 2
are not called again. The pilot phase of v5e (12 dev questions) is the smoke
set.

Before any paid call, `inspect` rebuilds, with exported engine functions only,
the chairman request of every question without a red team and requires it to
equal the stored A8 request byte for byte (gate G0, 271 of 271 test and 12 of
12 pilot questions).

Scoring set: 269 questions. The golds are those of
`gold-corrections-a8-open-v5e.json` (4 corrected, 2 LiveMathBench questions
excluded); 149 new-block and 120 legacy-block questions remain. The excluded
two get no new calls. The stored A8 is re-graded with the same golds as a
reference (253 of 269), not as a ceiling: the control of this probe is the
fresh C.

## Conditions

| Condition | What it is | Calls |
| --- | --- | --- |
| RT | The red team against the Stage 2 leader: the engine's `redTeamReview` prompt and model rule | One per question |
| C | The chairman without a red team: the stored A8 messages, a fresh call | One per question |
| Rc | The chairman with the clean red-team object (primary) | Only when its full request differs from C's |
| Rp | The chairman with the object `redTeamReview` builds (product) | Only when its full request differs from C's and Rc's |

- One RT reply serves both policies; the red team is never asked twice.
- Requests are compared in full (model, messages, host, generation
  parameters). Equal requests share one answer; the report tells ties by
  construction from observed ties.
- The red team sees the same leader text as the chairman: a Stage 1 answer cut
  in its reasoning is forwarded by the tail rule.
- Red-team model by the engine rule: the chairman, or the top-ranked answer of
  another vendor when the leader shares the chairman's vendor.

## Handling of the RT result

Applied to the final state of the RT call after the attempts the protocol
allows (two per call, as in the campaign).

| RT ended | Rc | Primary pair |
| --- | --- | --- |
| `stop` with visible text | Clean critique and verdict | Own chairman call when the request changed |
| At the cap (`length`) or at the loop guard (`loop`) | Red team unavailable | Rc takes C's answer |
| Content from reasoning only; any other finish reason | Red team unavailable | Rc takes C's answer |
| No text left after the service lines are removed | Red team unavailable | Rc takes C's answer |
| Failed after the allowed attempts | Red team unavailable | Rc takes C's answer; the question stays in the denominator |
| Waiting (cooldown, capacity refusal, budget pause, a retry still allowed, not sent) | — | Not measured yet |
| The pinned host is not listed; 404 before generation | — | Not measured |

A chairman call that failed for good counts as a wrong answer (v5 rule). A
call that has not ended is not a wrong answer.

## Clean verdict and critique

The RT reply is stored as it came. Rc gets only this deterministic handling of
service lines; no argument is rewritten.

- VERDICT: the last line that holds `VERDICT:` and exactly one of REFUTED,
  CONTESTED, UPHELD, allowing spaces, case, and `*` or `_` marks.
- The template with three words joined by `|` is not a verdict.
- CONFIDENCE: the last such line with a number from 0 to 10, `/10` allowed. A
  number outside 0..10 counts as missing; it is not clamped.
- No valid line: the value is empty. A missing verdict does not become
  CONTESTED.
- Removed from the critique: template lines (`VERDICT: REFUTED | CONTESTED |
  UPHELD`, `CONFIDENCE: <0-10>`) and valid VERDICT or CONFIDENCE lines before
  the last one. The chosen lines stay byte for byte.
- A critique left without a verdict goes to the chairman with an empty
  verdict. Nothing left: the red team counts as unavailable.

Product (Rp): the object exactly as `redTeamReview` builds it from the same
stored reply: the first match, CONTESTED by default, the whole text. After a
failed RT the product shows the chairman "verdict n/a" and an empty critique,
not "unavailable", so such an Rp may need its own call.

Rp − Rc is the difference of the two policies as a whole (verdict reading,
cut replies, failures), not of one regular expression.

## Conditional red team, policy G (amendment)

The rule `g` reads only the stored Stage 1, before any red team:

- `g = 0` (the red team is skipped) when all three expected Stage 1 answers
  exist, `gradeResponse` reads a canonical final answer in each, and the three
  are equal.
- `g = 1` (the red team is called) otherwise. A missing, cut or unread answer
  is not agreement.
- The answer of G is Rc where `g = 1` and C where `g = 0`. G makes no call of
  its own.

It reads the raw Stage 1 texts with the same extraction as the stored
`diagnostics.councilAnswers`; `inspect` requires the two to be equal on every
test and pilot question. From those stored answers, before this amendment:
`g = 0` on 233 and `g = 1` on 36 of the 269 scoring questions (12 with
different answers, 24 with an unread answer); 234 and 37 of all 271.

Limits:

1. The rule uses only what is known before the red team. The verdict is not
   part of it.
2. The rule and the list of `g` per question are fixed now; the digest of the
   list is in the manifest. No threshold is tuned on wins or losses.
3. The effect is counted on the whole set: G − C on the 269 questions. Where
   `g = 0`, G equals C. A gain inside the selected group is not shown alone.
4. The cost of G is an estimate: C where `g = 0`, RT plus the chairman where
   `g = 1`, from calls that were all made. Its latency is not measured.

The rule misses every question where the council agreed on a wrong answer.

In the report: Rc − C = (G − C) + (Rc − G). G − C is the Rc − C of the
questions with `g = 1`; Rc − G is the Rc − C of the questions with `g = 0`.

## Routes and calls

- Hosts: the snapshot `a8-routes-v7` (`stepfun/fp8`, `gmicloud/bf16` for hy4,
  `ionstream` for DeepSeek), no fallbacks. The v5e hosts of StepFun
  (`featherless/fp4`) and hy4 (`cohere`) are recorded as unavailable in the v6
  and v7 protocols. C − stored A8 therefore mixes the host change, the time
  and a second draw.
- Policy: `policyFrom` with the v5e campaign (cap 32768, deadline 4216 s, loop
  guard, context check, annotations), plus a local cap `redteam: 32768`, since
  the a8 profile has no red-team stage. No a8 or engine file changes.
- The endpoint list is read at every launch. A pinned host that is not listed,
  is listed with a negative status, lacks `max_tokens`, `temperature` or
  `top_p`, cannot hold the largest prompt plus the cap, or costs more than the
  pinned price is not asked at that launch; its questions stay not measured.
  A host that disappeared is not replaced inside the probe.
- Order: a seeded shuffle of the 269 scoring questions. Questions are worked in
  that order, in windows; inside a window the RT calls go first, then C and Rc
  of each question together.
- Product: the Rp calls that need their own call go after the primary part,
  on what is left of the budget; their coverage is reported apart.

## Limits

$40 and 1800 POSTs in the probe's own budget journal, for smoke, test, Rp and
retries. The analysis uses its own journal ($0.50, 8 POSTs). Expected about
$14–19; `inspect` puts the worst case at $83.43 (every RT, C and Rc call at the
cap, Rc's prompt grown by a critique at the cap, no Rp, no retries), so the
limit can stop the run early. Accuracy, p values and win counts are never a
reason to stop.

## Reading (code)

Primary pair Rc − C on the 269 scoring questions: accuracy of both, wins,
losses, both kinds of ties, the difference, the number of changed requests,
coverage and the reasons a question is not measured. Written before any data:
on 269 questions a point gain above 5 pp needs at least 14 net wins.

| Check | Rule |
| --- | --- |
| Direction | Exact two-sided McNemar test, p < 0.05, and the sign |
| More than 5 pp | The bound of the 95% interval strictly beyond the threshold |
| Within ±5 pp | The 90% interval strictly inside the bounds |
| Degenerate interval | Says nothing about size or equivalence |
| Fewer than 20 discordant pairs | Intervals marked rough |
| Set not complete | Interim reading only |

Intervals: paired bootstrap within blocks, as in v5. A stopped run counts the
longest fully measured prefix of the seeded order; the rest is diagnostic.

Secondary family, one Holm correction, fixed now:

1. Rp − C.
2. Rp − Rc.
3. C − stored A8 on the same golds.
4. Rc − C on the 149 new-block questions.
5. Rc − C on the 120 legacy-block questions.
6. Rc − C where Rc's request differs from C's.
7. G − C on the 269 questions (amendment).

Rc − G is shown as numbers, without a test.

Diagnostics, no new calls: RT endings by model and the reasons for falling
back to C; replies without a verdict, with the template, with duplicates;
verdict against the leader being right, wrong, and wrong with C right; what
the red team fixed and broke by verdict, against the fresh C; confidence
levels; the 12 questions with a cut leader; blocks, with LiveMathBench apart;
the primary pair under the wider corrections file
`gold-corrections-a8-open-v5e-all.json`; cost and time of RT and chairman
calls; the cost of the policy itself (RT plus one chairman per question) apart
from the cost of the probe.

Two caveats on the verdict table (amendment), printed with it:

- A wrong leader is not a wrong final answer: the chairman without a red team
  can already correct it, so a sound refutation of such a leader need not
  improve the final answer.
- The verdict against the leader being right does not measure whether the
  critique is sound: a right answer can rest on a wrong argument, and a wrong
  answer can get a false refutation.

## Review packet (amendment)

The `report` phase also writes `discordant.md`: every measured question where
C and Rc differ in correctness, in the seeded order. For each: id, block,
gold, `g`, the three Stage 1 answers, the leader and red-team models, how RT
ended, the clean verdict and confidence, C's and Rc's extracted answers; then
the question, the leader text, the stored red-team reply, and C's and Rc's
answers; and empty fields for the decisive argument (right / wrong / unclear)
and a comment. A person fills the fields. No model judges these arguments,
and the code does not either.

## Freeze

Committed before the first paid call. The manifest, written at the first live
phase, holds: the hash of the probe files and this protocol, of
`campaignData.js`, the git head, the current a8 method hash and v5e's recorded
one, the hashes of the v5e test and pilot journals, the bank, selection,
campaign, both corrections files and the route snapshot, the order seed and
order digest, the digest of the list of `g` in that order, the digest of the
G0 messages, and the limits. Live phases refuse when any of them changed.

The probe runs from a separate git worktree at its frozen commit, with the
shared `.runs` and `.cache` folders linked in. Other sessions edit engine
files in the main checkout; the worktree keeps their uncommitted changes out
of the measured code.

## Limits of the probe

- One draw per condition and question, so few discordant pairs are likely and
  "direction not established" is a likely reading.
- Stage 1 and Stage 2 are one stored draw of the v5e council; the reading holds
  for that draw, these models and hosts. ArXivMath is not in v5e.
- All questions were scored in earlier campaigns.
- The hosts of the chairman and of hy4 differ from v5e's.
- Rp runs after the primary part and may meet another load on the host.
- The prefix rule guards against keeping only fast questions, but a stop for
  money can still depend on how hard the questions are.
- The engine's verdict reading is only measured here. Changing `council.js`
  would change the a8 method hash and the product.
- Policy G is computed from calls made for every question, so it measures
  the accuracy of a conditional red team, not its cost or latency in use.
- With C right on most questions, the probe has more room to see harm than
  gain. Other red-team designs (an independent second solution, a chairman
  who checks the argument instead of following the verdict, several yes/no
  verifiers, checks by code) are not part of this probe.
