"""Extract the text layer of a PDF page by page, for manual review."""

import sys

from pypdf import PdfReader


def main():
    reader = PdfReader(sys.argv[1])
    with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as handle:
        for number, page in enumerate(reader.pages, start=1):
            handle.write(f'===== page {number} =====\n')
            handle.write((page.extract_text() or '') + '\n')
    print(f'{len(reader.pages)} pages')
    return 0


if __name__ == '__main__':
    sys.exit(main())
