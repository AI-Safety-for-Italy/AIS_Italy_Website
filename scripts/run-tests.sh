#!/bin/sh
# Run the members-sync tests with whichever Python has PyYAML.
#
# Homebrew and system Pythons are PEP 668 "externally managed" and refuse a
# plain pip install, so the local .venv is preferred when present. CI installs
# the requirements directly and falls through to python3.
set -e
cd "$(dirname "$0")/.."
if [ -x .venv/bin/python ]; then
  PY=.venv/bin/python
else
  PY=python3
fi
exec "$PY" -m unittest discover -s scripts -p 'test_*.py'
