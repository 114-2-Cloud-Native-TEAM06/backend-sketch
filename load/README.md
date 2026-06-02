# WebSocket k6 Load Tests

The main load-test guide has been merged into the root `README.md`.

Start from:

```txt
../README.md
```

Useful scripts in this directory:

- `ws-chat-load.js`: 1,000 users x 1 msg/sec evaluation benchmark and smaller smoke runs.
- `ws-online-load.js`: concurrent online / long WebSocket connection stability test.
- `evaluation-criteria-benchmark.sh`: staged summary report for the evaluation criteria.
- `find-throughput-ceiling.sh`: throughput ceiling helper.
- `find-online-ceiling.sh`: concurrent online ceiling helper.
- `count-k6-messages.sh`: DB persistence validation for a `RUN_ID`.
