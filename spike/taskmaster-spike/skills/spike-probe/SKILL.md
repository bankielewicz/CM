---
name: spike-probe
description: Taskmaster spike test skill. Use ONLY when the user explicitly asks to run the taskmaster spike-probe skill.
taskmaster:
  version: 1
  mode: advisory
  origin: authored
  steps:
    - id: s1
      title: Say the probe phrase
      mandatory: true
---

# Spike probe

This skill exists only to test the taskmaster-spike mod: that a plugin's `skills/` folder loads, which loop a skill is attributed to, and that a `taskmaster:` frontmatter block reaches the mod intact.

1. Reply with the phrase SPIKE-SKILL-OK.
2. Stop. Do nothing else.
