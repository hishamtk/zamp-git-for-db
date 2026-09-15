# Engineering - Project Round

## Overview

This is an open-ended project round. 

You'll be given a problem statement. It's intentionally vague - how you interpret, scope, and build it is the evaluation. We're not looking for the "right" answer. We're looking for how you think, what decisions you make, and whether you can turn ambiguity into something real.

We believe engineers are builders. That means we care about the full picture - your code, your product instincts, your UX choices, your documentation. Not just whether it works, but whether it's *insanely great*.

Treat it like a real work assignment, not an exam.

## What we expect

- A working solution with a URL we can test (deployed). It must be a web application.
- A `decisions.md` in the repo that captures the decisions you made along the way - what you chose, what you rejected, and why (see below)
- Github repository with the code

## What we evaluate

| Criteria | What this means |
| --- | --- |
| **Problem framing** | How did you interpret the problem? Why did you scope it the way you did? What did you deliberately leave out and why? |
| **Product thinking** | Did you think about who this is for and what problem it actually solves? Or did you just write code? |
| **UX decisions** | Does the experience make sense? Is it intuitive? We're not judging visual polish - we're judging whether you thought about the person using this. |
| **Code quality** | Is the code clean, well-organized, and something you'd be comfortable handing to a teammate? |
| **Tests** | Are there meaningful tests? Not token coverage - tests that actually catch real problems. |
| **Documentation** | Could someone set this up and understand your thinking without talking to you? |
| **Setup experience** | How easy is it to get running?  |
| **Velocity** | Given 5 days, how much real progress did you make? |
| **Above and beyond** | Did you surprise us? Not with bells and whistles, but with depth. Did you solve a hard sub-problem that most people would skip? |

## Going above and beyond

This is the criterion that separates a solid submission from one we remember. A working solution that ticks the boxes is the baseline, not the ceiling. We're explicitly asking you to push past "done."

Going above and beyond is **not** about bells and whistles - not extra pages, not a slicker theme, not a longer feature list. It's about **depth**. It means finding the hard part of the problem that most people would quietly skip, and actually solving it.

Here's what that can look like for us:

- **You solved a hard sub-problem others avoid.** The messy edge case, the ambiguous input, the failure mode nobody wants to touch. You went at the thing that was genuinely difficult instead of routing around it.
- **You handled the real world, not the happy path.** Bad data, partial input, malformed documents, rate limits, timeouts, concurrent users. Your solution degrades gracefully instead of falling over.
- **You showed range.** You didn't just write code - you made a real product call, a real UX call, and a real infra call, and each one holds up.
- **You built something you'd actually trust.** Observability, sensible error messages, a setup a stranger can run in one shot, tests that catch the failures you'd actually hit.
- **You went deep on one thing and did it exceptionally well** rather than going shallow on ten things. Depth beats breadth every time here.
- **You thought about the end-to-end user journey and made it delightful.** The first-run experience, the empty state, the moment something goes wrong, the small touches that make someone smile. You imagined the actual person moving through your product from start to finish and removed the friction they'd hit at every step.

You don't need to do all of these. Pick the hard problem inside your problem, own it, and go deeper than expected - and sweat the journey around it so the whole thing feels considered end to end. That's what surprises us - and it's what tells us what you'd be like to build alongside.

## decisions.md (required)

We want a `decisions.md` file at the root of your repo. This is not optional, and it's not a changelog. It's a running log of the real calls you made while building.

For each meaningful decision, capture:

- **The decision** - what you actually chose.
- **The alternatives** - what else you seriously considered.
- **The reasoning** - why you went the way you did, including the tradeoffs you accepted.
- **What you deliberately cut** - and why it was the right thing to leave out for now.

Keep it honest and specific. "Used Postgres because it's good" tells us nothing. "Used Postgres over a vector DB because the query patterns were relational and I didn't want to run two datastores for a 5-day build" tells us how you think. This file is often more revealing than the code itself - it's where we see your judgment under ambiguity and time pressure.

## Tools

Use whatever language, framework, or tools you want. AI tools (Cursor, Copilot, ChatGPT) are fully encouraged - we use them every day.

## Clarifications

If you find yourself wanting to ask "what exactly do you mean by X?" - that's the point. The ambiguity is intentional. Define it yourself, make a call, and move forward. Your interpretation is part of the evaluation.

---

## Problem Statements

Pick one of the three problems below. Choose whichever one you find more interesting.

---

### 1. Turn messy documents into structured, queryable data

Build a system that takes unstructured or semi-structured documents and converts them into clean, structured data that can be searched and queried.

### 2. **Version control for database schemas**

Build branch, diff, and merge for database schemas. A user should be able to branch a schema, evolve it independently — add, drop, rename, and retype columns; change constraints and indexes; create and drop tables — then see exactly what diverged and merge back. 

Two constraints if you were to pick this problem statement 

1. We’re not just looking for SQL statements as output - we expect the product to apply the schema changes on a real database so we can test it end to end 
2. The solution should work smoothly even if the table has ~5GB of data 

### 3. Pick your own problem

Choose your own problem to build. This option exists for people who already have something they find genuinely interesting, and it is held to exactly the same bar as the two prompts above, not an easier one.

A good self-chosen problem has a hard part. Somewhere in it is a sub-problem that is technically or conceptually difficult, where a naive approach breaks and the interesting work is in handling that. If your problem has an obvious happy path and no real tension, pick one of the other two instead. We are not looking for a CRUD app, a wrapper around a single API call, or a rebuild of something with a known reference implementation.

Before you build, write a short brief at the top of your `decisions.md` that answers:

- **The problem** — what you are building and who it is for, in a few sentences.
- **The hard part** — the specific sub-problem that makes this non-trivial, and why a simple approach fails at it.
- **The slice** — the one end-to-end path you will actually ship, and the one failure or edge case you will handle.
- **Why this instead of a fixed prompt** — what this lets you show that the other two would not.

### 4. Submit a side-project you have done in the past

Is there any side-project you’ve done in the past that you’re proud to stand behind? If you’re confident it’s either solving an important problem for a user, or it’s technically challenging - feel free to submit an existing project.