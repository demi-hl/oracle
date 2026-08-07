---
name: chain
description: "Use when the user types /chain or wants to list/select oracle working chains (hyperliquid, base, solana, bitcoin, ...)."
version: 1.0.0
disable-model-invocation: true
---

# /chain

Run the local oracle chain selector. Do not invent chains.

```bash
# list
oracle chain list

# select build surface
oracle chain use {{arg1}}

# show / clear
oracle chain show
oracle chain clear
```

If `{{arg1}}` is empty, run `oracle chain list`.
If `{{arg1}}` is `show`, `status`, `clear`, `list`, or a chain key, pass it through:

```bash
oracle chain {{arg1}} {{arg2}}
```

After selection, confirm active chain key + id + agent in lowercase.
