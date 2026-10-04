---
routineKey: weekly-skill-curation
title: Curate the company skill library
description: Weekly pass that learns new skills from completed work, keeps curated skills accurate, and flags stale or unused skills for the board. Never deletes a skill.
assigneeRef:
  resourceKind: agent
  resourceKey: skill-curator
status: paused
priority: low
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
variables:
  - name: lookbackDays
    label: Completed work to review (days)
    type: number
    defaultValue: 7
    required: false
    options: []
  - name: usageWindowDays
    label: Usage report window (days)
    type: number
    defaultValue: 30
    required: false
    options: []
  - name: maxNewSkills
    label: Max new skills per run
    type: number
    defaultValue: 3
    required: false
    options: []
triggers:
  - kind: schedule
    label: Weekly skill curation
    enabled: false
    cronExpression: "0 6 * * 0"
    timezone: UTC
    signingMode: none
    replayWindowSec: 0
issueTemplate:
  surfaceVisibility: normal
---

# Weekly skill curation

This routine is **paused by default** and spends no tokens until an operator enables its schedule or runs it by hand. Use the `skill-curator` skill as the operating procedure.

## What this run must do

1. Read `GET /api/companies/{companyId}/skills/usage?days={{usageWindowDays}}` and note `trackingStartedAt`.
2. Review issues completed in the last `{{lookbackDays}}` days, including descriptions, final comments and board feedback.
3. Create at most `{{maxNewSkills}}` new skills, each with the `curated` category and its source tasks. Update curated skills where the evidence shows they are wrong or incomplete.
4. Post one report comment in the skill's six sections, then set this issue to `done`.

## Hard limits for this routine

- Never delete a skill; archiving is proposed only.
- Edit only skills in the `curated` category; propose changes to every other skill.
- Never write secrets or personal data into a skill.
- Keep every read and write company-scoped.
