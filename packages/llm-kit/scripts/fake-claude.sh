#!/usr/bin/env bash
# Test fake of `claude -p --output-format=stream-json --allowedTools= --max-turns=1`.
# Reads prompt from stdin (ignored), emits stream-json frames, exits.
# Behavior is controlled by env vars so tests can drive the shape:
#   FAKE_CLAUDE_REPLY="hello\nworld"   content to stream as tokens
#   FAKE_CLAUDE_ERROR=auth             emit auth-error stderr and exit 1
#   FAKE_CLAUDE_VERSION=1.2.3-test     printed by --version
#   FAKE_CLAUDE_THINKING=1|"text"      leading thinking block (open/close only, or with deltas)
#   FAKE_CLAUDE_WEB=1                  emit web_search_tool_result + WebFetch citations
#   FAKE_CLAUDE_TOOLGAP=N              N tool_use frames ~0.15s apart before any text
#   FAKE_CLAUDE_PREAMBLE="I'll read…"  chatter streamed before the tools, absent from `result`
#   FAKE_CLAUDE_HANG=1                 close stdout then sleep forever (timeout/abort paths)
set -u

for arg in "$@"; do
  case "$arg" in
    --version|-v)
      echo "${FAKE_CLAUDE_VERSION:-1.0.0-fake}"
      exit 0
      ;;
  esac
done

cat > /dev/null

if [[ "${FAKE_CLAUDE_ERROR:-}" == "auth" ]]; then
  echo "Please run \`claude login\`" >&2
  exit 1
fi

reply="${FAKE_CLAUDE_REPLY:-hi there}"
i=0
len=${#reply}
# Mirror real Claude CLI 2.x stream-json output (with --include-partial-messages):
# message_start → content_block_start → N×content_block_delta → content_block_stop
# → message_stop → result. The parser only consumes content_block_delta + result;
# the other frames are emitted for fidelity (and to exercise discard paths).
printf '{"type":"stream_event","event":{"type":"message_start","message":{"id":"fake","type":"message","role":"assistant","content":[]}}}\n'

# Optional thinking block (extended thinking models). When
# FAKE_CLAUDE_THINKING is set, emit a leading thinking block at
# index 0 — empty value → only the open/close pair (signature-only
# case, matches what current Claude CLI emits today); non-empty
# value → also stream thinking_delta chunks carrying the text.
# The answer text block shifts to index 1 in either case so the
# parser must use index-keyed block-type tracking, not "first one wins".
text_index=0
think_block=0
if [[ -n "${FAKE_CLAUDE_THINKING:-}" ]]; then
  think_block=1
  text_index=1
  printf '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}}\n'
  if [[ "${FAKE_CLAUDE_THINKING}" != "1" ]]; then
    think="${FAKE_CLAUDE_THINKING}"
    tjson=$(printf '%s' "$think" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
    printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":%s}}}\n' "$tjson"
  fi
  printf '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}\n'
fi

# Optional pre-tool preamble (llm-kit addition). When FAKE_CLAUDE_PREAMBLE is set,
# emit it as a text block BEFORE the tool round-trips — mirroring the real CLI's
# "I'll read all 21 pages first." chatter. Critically it is NOT part of the
# `result` frame, so token-stream concat sees「过场白 + 答案」while final sees
# only the answer. That divergence is exactly what structured parsing must survive.
if [[ -n "${FAKE_CLAUDE_PREAMBLE:-}" ]]; then
  pjson=$(printf '%s' "${FAKE_CLAUDE_PREAMBLE}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
  printf '{"type":"stream_event","event":{"type":"content_block_start","index":90,"content_block":{"type":"text","text":""}}}\n'
  printf '{"type":"stream_event","event":{"type":"content_block_delta","index":90,"delta":{"type":"text_delta","text":%s}}}\n' "$pjson"
  printf '{"type":"stream_event","event":{"type":"content_block_stop","index":90}}\n'
fi

# Optional tool-use gap (llm-kit addition). When FAKE_CLAUDE_TOOLGAP=N, emit N
# tool_use blocks spaced ~0.15s apart BEFORE any answer text — mirroring what a
# real read-the-images turn looks like: several minutes of Read round-trips that
# produce zero text_delta. Guards「修正 2」: the idle timer must count these
# frames as liveness, otherwise a healthy multi-page read gets SIGKILL'd.
if [[ -n "${FAKE_CLAUDE_TOOLGAP:-}" ]]; then
  n="${FAKE_CLAUDE_TOOLGAP}"
  g=0
  while (( g < n )); do
    sleep 0.15
    idx=$((text_index + g + 1))
    printf '{"type":"stream_event","event":{"type":"content_block_start","index":%d,"content_block":{"type":"tool_use","id":"tu_%d","name":"Read","input":{}}}}\n' "$idx" "$g"
    printf '{"type":"stream_event","event":{"type":"content_block_delta","index":%d,"delta":{"type":"input_json_delta","partial_json":"{\\"file\\":\\"p%d.png\\"}"}}}\n' "$idx" "$g"
    printf '{"type":"stream_event","event":{"type":"content_block_stop","index":%d}}\n' "$idx"
    g=$((g + 1))
  done
fi

printf '{"type":"stream_event","event":{"type":"content_block_start","index":%d,"content_block":{"type":"text","text":""}}}\n' "$text_index"
while (( i < len )); do
  chunk="${reply:$i:4}"
  json=$(printf '%s' "$chunk" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
  printf '{"type":"stream_event","event":{"type":"content_block_delta","index":%d,"delta":{"type":"text_delta","text":%s}}}\n' "$text_index" "$json"
  i=$((i + 4))
done
printf '{"type":"stream_event","event":{"type":"content_block_stop","index":%d}}\n' "$text_index"
printf '{"type":"stream_event","event":{"type":"message_stop"}}\n'

# Optional web-search/fetch citations. When FAKE_CLAUDE_WEB is set, emit an
# `assistant` message event carrying a web_search_tool_result block (two hits,
# one duplicated to exercise dedup) plus a WebFetch tool_use — mirrors how the
# real CLI surfaces联网命中的网页 URL. The parser extracts citation chunks from these.
if [[ -n "${FAKE_CLAUDE_WEB:-}" ]]; then
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example/1","title":"页面一"},{"type":"web_search_result","url":"https://a.example/2","title":"页面二"},{"type":"web_search_result","url":"https://a.example/1","title":"页面一(重复)"}]},{"type":"server_tool_use","name":"WebFetch","input":{"url":"https://b.example/doc"}}]}}'
fi
full_json=$(printf '%s' "$reply" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')
printf '{"type":"result","subtype":"success","is_error":false,"result":%s}\n' "$full_json"

# If HANG=1, close stdout (so Node's reader sees EOF) and then sleep
# forever — used to exercise the wall-clock timeout and abort paths.
# Closing fd 1 first is critical: otherwise the `sleep` child inherits
# the open pipe and the Node-side stdout never sees EOF, hanging the
# for-await loop even after we SIGKILL the parent bash.
if [[ "${FAKE_CLAUDE_HANG:-}" == "1" ]]; then
  exec 1>&-
  sleep 999
fi
