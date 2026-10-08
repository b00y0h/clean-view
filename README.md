# Clean View

A Claude Code mod that makes Claude Code calm and friendly for people who aren't technical.

While Claude works, the tool calls, file changes and command output are hidden. One simple checklist sits above the prompt instead, so you can always see the plan, what's happening now and how far along it is.

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

The header also tells you when Claude **needs you** (for example, to approve a step), when it's **stuck**, when you **stopped** it, and when it's **all done**.

## Install

Type this at the Claude Code prompt in a terminal:

```
/plugin install clean-view --marketplace b00y0h/clean-view
```

Answer `y` to add the marketplace, then press Enter to install it for your user. Clean View starts on right away.

## Turn it on and off

- Click the **Clean View** button above the prompt, or
- type `/simple on`, `/simple off`, or just `/simple` to flip it.

Your choice is remembered after a restart. When it's off, everything Claude Code normally shows comes back.

## How it works

- Claude lays out the steps of every job first, in plain English, and reports progress as it goes.
- Step names never contain file names, paths, commands or code.
- Permission prompts and questions switch the header to **Needs you**.
- Errors become one plain sentence, such as "Claude's servers are busy, try again in a minute".
- Each new job gets a short name from Claude Haiku. That's one tiny model call per request, and it counts toward your usage.

## Develop

```
claude plugin validate .
claude plugin test .
```
