---
name: setup
description: "Use when the user types /setup or wants to connect telegram, discord, slack, or another messaging platform to oracle."
version: 1.0.0
disable-model-invocation: true
---

# /setup

Configure messaging for the oracle profile. Secrets stay local.

```bash
# menu + status (never prints tokens)
oracle setup status

# open full hermes wizard
oracle setup messaging

# platform shortcuts
oracle setup telegram
oracle setup discord
oracle setup slack
oracle setup whatsapp

# gateway control
oracle setup gateway status
oracle setup gateway restart
```

If the user passed args after `/setup`, forward them:

```bash
oracle setup {{arg1}} {{arg2}} {{arg3}}
```

If no args, show `oracle setup status`.
Never echo bot tokens, app tokens, or passwords back into chat.
