#!/bin/bash
# Minimal native messaging host for debugging.
# Reads one message, responds with a fixed JSON, exits.

echo "[$(date)] test host started pid=$$" >> /tmp/native-host-test.log

# Read 4-byte length header
header=$(dd bs=4 count=1 2>/dev/null | xxd -p)
echo "[$(date)] header=$header" >> /tmp/native-host-test.log

# Build response
RESP='{"url":"http://127.0.0.1:41591","token":"test","version":"0.1.0-debug"}'
LEN=${#RESP}

# Write 4-byte little-endian length + JSON body
printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' $((LEN & 0xFF)) $(((LEN >> 8) & 0xFF)) $(((LEN >> 16) & 0xFF)) $(((LEN >> 24) & 0xFF)))${RESP}"

echo "[$(date)] response sent, len=$LEN" >> /tmp/native-host-test.log
