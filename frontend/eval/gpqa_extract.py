'''Extract GPQA Diamond from the official password-protected zip.

Question text is written only to the jsonl path. Stdout gets filenames and counts.
'''

import csv
import io
import json
import sys
import zipfile
from pathlib import Path


def main():
    zip_path, out_path, password = sys.argv[1:]
    with zipfile.ZipFile(zip_path) as archive:
        archive.setpassword(password.encode('utf-8'))
        names = archive.namelist()
        diamond = [
            name for name in names
            if 'diamond' in name.lower() and name.lower().endswith('.csv')
        ]
        if len(diamond) != 1:
            print('csv files: ' + ', '.join(name for name in names if name.lower().endswith('.csv')))
            raise SystemExit('Expected exactly one GPQA Diamond csv')
        with archive.open(diamond[0]) as handle:
            text = handle.read().decode('utf-8-sig')
    rows = list(csv.DictReader(io.StringIO(text)))
    if len(rows) < 60:
        raise SystemExit(f'Diamond csv has {len(rows)} rows')
    destination = Path(out_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('w', encoding='utf-8', newline='\n') as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + '\n')
    columns = ', '.join(rows[0].keys()) if rows else ''
    print(f'{diamond[0]}: {len(rows)} rows; columns: {columns}')


if __name__ == '__main__':
    main()
