#!/bin/sh
set -eu

for executable in /app/main/nnmodelling /app/main/NNModelling; do
  if [ -x "$executable" ]; then
    exec zypak-wrapper.sh "$executable" "$@"
  fi
done

echo "NNModelling executable was not found in /app/main" >&2
exit 1
