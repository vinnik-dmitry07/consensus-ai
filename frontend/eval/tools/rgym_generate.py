"""Generate the reasoning-gym block of the A8 v5 bank.

The families, their settings, the seeds and the split sizes are fixed here
before any model sees a question. Every answer is a single integer and is
checked with the library's own scorer. Output is UTF-8 JSONL with LF endings.
"""

import argparse
import datetime
import importlib.metadata
import json
import re
import sys

import reasoning_gym

# Settings are fixed before the first model call and are not tuned on model
# accuracy. Grid simulations and plain arithmetic drills are left out.
FAMILIES = [
    ('self_reference', {'difficulty': 10}),
    ('aiw', {'max_entities': 10}),
    ('binary_alternation', {'min_n': 30, 'max_n': 60}),
    # Six or more terms: with four, several rules fit and the answer is not unique.
    ('number_sequence', {'min_terms': 6, 'max_terms': 8, 'max_complexity': 3}),
    # simple_geometry is left out: it builds convex polygons whose missing
    # angle exceeds 180 degrees, so the premise contradicts the answer.
    ('lcm', {'min_numbers': 3, 'max_numbers': 4, 'min_value': 10, 'max_value': 999}),
    ('gsm_symbolic', {}),
]
TEST_PER_FAMILY = 10
DEV_FAMILIES = ['self_reference', 'aiw', 'number_sequence', 'gsm_symbolic']
TEST_SEED = 20261106
# The library seeds item i with seed + i, so the two seeds stay far apart.
DEV_SEED = 70261107
POOL_FACTOR = 3
INTEGER = re.compile(r'^-?\d+$')


def draw(family, config, seed, count):
    """Return up to `count` distinct integer-answer items in library order."""
    data = reasoning_gym.create_dataset(family, seed=seed, size=count * POOL_FACTOR, **config)
    items = []
    seen = set()
    for index in range(len(data)):
        entry = data[index]
        answer = str(entry.get('answer', '')).strip()
        question = str(entry.get('question', '')).strip()
        if not INTEGER.match(answer) or not question or question in seen:
            continue
        if data.score_answer(answer=answer, entry=entry) != 1.0:
            raise SystemExit(f'{family}: the library scorer rejects its own gold at index {index}')
        seen.add(question)
        items.append({'index': index, 'question': question, 'answer': answer})
        if len(items) == count:
            break
    if len(items) < count:
        raise SystemExit(f'{family}: only {len(items)} usable items for {count}')
    return items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    args = parser.parse_args()
    version = importlib.metadata.version('reasoning-gym')
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    rows = []
    for family, config in FAMILIES:
        plan = [('test', TEST_SEED, TEST_PER_FAMILY)]
        if family in DEV_FAMILIES:
            plan.append(('dev', DEV_SEED, 1))
        for split, seed, count in plan:
            for item in draw(family, config, seed, count):
                rows.append({
                    'dataset': f'rgym-{family}',
                    'sourceId': f'{split}-{seed}-{item["index"]}',
                    'family': family,
                    'split': split,
                    'question': item['question'],
                    'answer': item['answer'],
                    'config': config,
                    'seed': seed,
                    'library': f'reasoning-gym=={version}',
                    'generatedAt': stamp,
                })
    questions = [row['question'] for row in rows]
    if len(set(questions)) != len(questions):
        raise SystemExit('Duplicate question text across families or splits')
    with open(args.output, 'w', encoding='utf-8', newline='\n') as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    counts = {}
    for row in rows:
        key = f'{row["split"]}:{row["family"]}'
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({'library': version, 'rows': len(rows), 'counts': counts}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
