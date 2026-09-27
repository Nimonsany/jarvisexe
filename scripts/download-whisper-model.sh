#!/bin/sh
# Downloads the whisper.cpp ggml-small model (Nepali/English support, ~466MB).
# Local-first: the model stays in ~/.jarvis/models and is never uploaded.
set -e
mkdir -p "$HOME/.jarvis/models"
FILE="$HOME/.jarvis/models/ggml-small.bin"
if [ -f "$FILE" ] && [ "$(stat -f%z "$FILE")" -ge 465000000 ]; then
  echo "model already present: $FILE"
  exit 0
fi
echo "downloading whisper ggml-small (~466MB)…"
curl -L -C - -o "$FILE" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
echo "done: $FILE"
