---
name: Terminal practice-session cache
description: Keep completed or abandoned practice sessions out of learner resume UI
---

The learner-scoped in-progress query is a list. When one session becomes completed or abandoned, remove only that session from the cached list before refetching.

**Why:** A learner can have multiple unfinished sessions. Clearing the entire cache hides the other sessions if a background refetch fails; retaining the terminal one can show a session that is no longer resumable.

**How to apply:** In every terminal transition path, including normal completion, timed completion, and abandonment, filter only the finished session ID from the current learner's list.