#!/usr/bin/env python3
"""Check documentation links, anchors, file-name case, whitespace and packaged references."""
from __future__ import annotations

import os
import posixpath
import re
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

import package_release as packages

ROOT = Path(__file__).resolve().parents[1]
EXTERNAL = re.compile(r'^(?:[a-z][a-z0-9+.-]*:|//)', re.IGNORECASE)
FENCE = re.compile(r'^\s*(```|~~~)')
LOCAL_ONLY = {'CLAUDE.md'}  # agent notes that are never published


def documents(root: Path) -> list[Path]:
    root = Path(root)
    found = [*root.glob('*.md'), *root.glob('docs/*.md')]
    return sorted(path for path in found if path.name not in LOCAL_ONLY)


def unfenced(text: str) -> str:
    """The text without fenced code blocks."""
    lines, fenced = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            lines.append(line)
    return '\n'.join(lines)


def prose(text: str) -> str:
    """The text without fenced code blocks or inline code spans."""
    return re.sub(r'`[^`\n]*`', '``', unfenced(text))


def slug(heading: str) -> str:
    """GitHub's heading anchor: lowercase, letters/digits/_/- kept, spaces become hyphens."""
    text = re.sub(r'<[^>]+>', '', heading)
    text = re.sub(r'`([^`]*)`', r'\1', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'[*~]', '', text).strip().lower()
    kept = []
    for char in text:
        if char in ' -':
            kept.append('-')
        elif char == '_' or unicodedata.category(char)[0] in 'LNM':
            kept.append(char)
    return ''.join(kept)


def anchors(text: str) -> set[str]:
    seen: dict[str, int] = {}
    found: set[str] = set()
    body = unfenced(text)  # headings keep their inline code: it is part of the anchor
    headings = [match.group(2) for match in re.finditer(r'^(#{1,6})[ \t]+(.*?)[ \t#]*$', body, re.MULTILINE)]
    headings += re.findall(r'<h[1-6][^>]*>(.*?)</h[1-6]>', body, re.IGNORECASE | re.DOTALL)
    for heading in headings:
        base = slug(heading)
        count = seen.get(base, 0)
        seen[base] = count + 1
        found.add(base if count == 0 else f'{base}-{count}')
    found.update(re.findall(r'<a\s[^>]*?(?:name|id)="([^"]+)"', text))
    return found


def link_targets(text: str) -> list[str]:
    text = prose(text)
    targets = re.findall(r'!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)', text)
    targets += re.findall(r'^\s*\[[^\]]+\]:\s*(\S+)', text, re.MULTILINE)
    targets += [a or b for a, b in re.findall(r'(?:href|src)\s*=\s*(?:"([^"]+)"|\'([^\']+)\')', text)]
    return targets


def exact_case_exists(root: Path, destination: Path) -> bool:
    """True when the path exists with the very same letter case (GitHub is case sensitive)."""
    normalized = Path(os.path.normpath(destination))
    try:
        relative = normalized.relative_to(root)
    except ValueError:
        return False
    current = root
    for part in relative.parts:
        if not current.is_dir() or part not in {child.name for child in current.iterdir()}:
            return False
        current = current / part
    return True


def check_links(root: Path) -> list[str]:
    root = Path(root).resolve()
    problems: list[str] = []
    for document in documents(root):
        name = document.relative_to(root).as_posix()
        for target in link_targets(document.read_text(encoding='utf-8')):
            if EXTERNAL.match(target):
                continue
            path_part, _, fragment = target.partition('#')
            destination = document
            if path_part:
                destination = document.parent / unquote(path_part)
                if not exact_case_exists(root, destination):
                    problems.append(f'{name}: {target} — arquivo inexistente (ou com outra caixa)')
                    continue
            if fragment and destination.is_file() and destination.suffix == '.md':
                if unquote(fragment) not in anchors(destination.read_text(encoding='utf-8')):
                    problems.append(f'{name}: {target} — âncora inexistente')
    return problems


def check_whitespace(root: Path) -> list[str]:
    """What `git diff --check` flags, applied to new (untracked) documents too."""
    problems: list[str] = []
    root = Path(root).resolve()
    for document in documents(root):
        name = document.relative_to(root).as_posix()
        text = document.read_text(encoding='utf-8')
        if not text.endswith('\n') or text.endswith('\n\n'):
            problems.append(f'{name}: precisa terminar com exatamente uma quebra de linha')
        for number, line in enumerate(text.splitlines(), 1):
            if line != line.rstrip():
                problems.append(f'{name}:{number}: espaço em branco no fim da linha')
    return problems


def _link_spans(text: str) -> list[tuple[int, int]]:
    """Spans of markdown links and autolinks. A name inside one is a reference, not a bare mention:
    absolute links point at the repository, and relative ones are validated by their own rule."""
    pattern = r'!?\[[^\]]*\]\([^)]*\)|<https?://[^>\s]+>'
    return [match.span() for match in re.finditer(pattern, text)]


def check_packages(root: Path, extension, host) -> list[str]:
    """Shipped documents may link only inside their package, or to the repository by URL."""
    root = Path(root).resolve()
    repository_docs = {document.relative_to(root).as_posix() for document in documents(root)}
    problems: list[str] = []
    for label, shipped in (('extensão', tuple(extension)), ('host', tuple(host))):
        shipped_set = set(shipped)
        absent = repository_docs - shipped_set
        names = {path for path in absent} | {PurePosixPath(path).name for path in absent}
        mention = None
        if names:
            ordered = sorted(names, key=len, reverse=True)
            mention = re.compile(r'(?<![\w/.-])(?:' + '|'.join(re.escape(item) for item in ordered) + r')(?!\w)')
        for name in sorted(shipped_set):
            path = root / name
            if not name.endswith('.md') or not path.is_file():
                continue
            text = path.read_text(encoding='utf-8')
            for target in link_targets(text):
                if EXTERNAL.match(target):
                    continue
                path_part, _, fragment = target.partition('#')
                if not path_part:
                    if fragment and unquote(fragment) not in anchors(text):
                        problems.append(f'{label}: {name}: {target} — âncora inexistente')
                    continue
                resolved = posixpath.normpath(str(PurePosixPath(name).parent / unquote(path_part)))
                if resolved not in shipped_set:
                    problems.append(f'{label}: {name}: {target} — não está no pacote {label}')
            if mention is None:
                continue
            spans = _link_spans(text)
            for match in mention.finditer(text):
                if not any(start <= match.start() and match.end() <= end for start, end in spans):
                    problems.append(f'{label}: {name}: cita {match.group(0)}, que não está no pacote; '
                                    'use um link absoluto para o repositório')
    return problems


def main(root: Path | None = None) -> int:
    root = ROOT if root is None else Path(root)
    problems = (check_links(root) + check_whitespace(root)
                + check_packages(root, packages.EXTENSION, packages.HOST))
    for problem in problems:
        print(f'documentation: {problem}')
    if problems:
        return 1
    print(f'documentation: OK ({len(documents(root))} documentos)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
