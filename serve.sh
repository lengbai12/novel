#!/usr/bin/env bash
set -euo pipefail
ROOT="$(dirname "$(readlink -f "$0")")"
export LD_LIBRARY_PATH="$ROOT/cudart-llama-b11960-bin-ubuntu-cuda-13.4-x64:$ROOT/llama-b11960${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
MODEL="${MODEL:-$ROOT/Qwen3.5-9B-MTP-Q4_0.gguf}"
CTX="${CTX:-262144}"
KV="${KV:-q4_0}"
# Origins of the static site that calls this server; add the Pages URL when used.
CORS_ORIGINS="${CORS_ORIGINS:-http://127.0.0.1:8080,http://localhost:8080}"
exec "$ROOT/llama-b11960/llama-server" \
  --model "$MODEL" --alias qwen3.5-9b \
  --host 127.0.0.1 --port "${PORT:-8000}" \
  --device CUDA0 --ctx-size "$CTX" --parallel 1 --gpu-layers all --fit off \
  --flash-attn on --cache-type-k "$KV" --cache-type-v "$KV" \
  --batch-size "${BATCH:-2048}" --ubatch-size "${UBATCH:-512}" \
  --threads "${THREADS:-2}" --threads-batch 16 \
  --cache-ram 0 --ctx-checkpoints 0 --no-context-shift --no-cache-idle-slots \
  --jinja --reasoning on --reasoning-format deepseek --reasoning-budget 2048 --chat-template-kwargs '{"enable_thinking":true}' \
  --backend-sampling --spec-type draft-mtp --spec-draft-n-max 1 \
  --temp 0.7 --top-k 20 --top-p 0.8 --min-p 0 --presence-penalty 1.5 \
  --metrics --cors-origins "$CORS_ORIGINS" "$@"
