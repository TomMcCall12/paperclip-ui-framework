#!/usr/bin/env python3
"""Judge a Paperclip /api/health answer for paperclip-heartbeat.sh (TOM-721).

Used only when jq is not on PATH. Reads the health JSON on stdin and prints
one line: "ok", or "fail<TAB><reason>". Always exits 0 when it could judge
the input; the reason never holds anything but numbers and fixed words.

The rule matches the stall-alarm health contract:
  - status must be "ok";
  - stallSentinel missing: fail (an older build is running);
  - mode "off": pass (it was switched off on purpose);
  - lastSweepAt within max-age seconds and lastSweepOk true: pass;
  - lastSweepAt null and startedAt within max-age seconds: pass (just started);
  - anything else: fail.

Usage: paperclip-heartbeat-check.py <now-epoch-seconds> <max-age-seconds>
Run it with `python3 -I` so nothing in the current directory is imported.
"""
import calendar
import json
import re
import sys
import time


def to_epoch(text):
    # "2026-10-22T09:12:00.000Z" -> seconds; the fraction is dropped.
    text = re.sub(r"\.\d+", "", text)
    return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))


def judge(health, now, max_age):
    if health.get("status") != "ok":
        return "fail\tPaperclip health status is not ok"
    s = health.get("stallSentinel")
    if not isinstance(s, dict):
        return "fail\tno stallSentinel in /api/health (older build?)"
    if s.get("mode") == "off":
        return "ok"
    last = s.get("lastSweepAt")
    if last:
        age = now - to_epoch(last)
        if age > max_age:
            return "fail\tsentinel stale %d min" % (age // 60)
        if s.get("lastSweepOk") is not True:
            return "fail\tlast sentinel sweep failed"
        return "ok"
    started = s.get("startedAt")
    if started and now - to_epoch(started) <= max_age:
        return "ok"
    return "fail\tsentinel has not swept since start"


def main():
    now = int(sys.argv[1])
    max_age = int(sys.argv[2])
    try:
        health = json.load(sys.stdin)
        if not isinstance(health, dict):
            raise ValueError("not an object")
        print(judge(health, now, max_age))
    except Exception:
        print("fail\t/api/health answer could not be read")


main()
