# Lock proof

20 concurrent point lookups, plus a transaction holding `AccessShareLock`
for 6000 ms. Same `ALTER TABLE … TYPE` on both sides.

| Path | ALTER outcome | p50 | p99 | max |
|---|---|---:|---:|---:|
| Naive (no lock_timeout) | queued 5646 ms | 2.348 ms | 6.35 ms | 5643.902 ms |
| Guarded (`lock_timeout=500ms`) | acquired after retry · 6 attempt(s) | 2.869 ms | 7.032 ms | 504.648 ms |

Naive (cliff while the ALTER is queued):
`▁▁▁▁▁▁▁▁▁▁█▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁`

Guarded (readers keep moving):
`▁▁▁▁▁▁▁▇▇▇█▁▁▁▇▁▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁`

p99 stays low because most of the 16 s window is uncontended. The number
that matches the thesis is **max**: naive readers sat behind the queued
`ALTER` for 5.6 s; guarded readers never waited longer than the 500 ms
`lock_timeout` (and the DDL retried until the reader released).

Postgres grants locks FIFO. An unguarded `ALTER TABLE` waiting behind one
reader blocks every SELECT that arrives after it. `SET LOCAL lock_timeout`
makes the DDL fail instead of taking the application down.

On the 20 M-row / 4 GB table the same physics were measured before product
code existed: naive `SELECT` blocked 3,098 ms then timed out; guarded
`ALTER` aborted in 605 ms. `node infra/proof.mjs` reproduces that on
demand without rewriting `main.txns`.
