#!/usr/bin/env python3
import importlib
import importlib.abc
import importlib.machinery
import json
import os
import shutil
import subprocess
import sys


WORDMARK = (
    "    ██████  ████████   ██████    ██████  ░███   ██████    ",
    "   ███░░███░░███░░███ ░░░░░███  ███░░███ ░███  ███░░███   ",
    "   ░███ ░███ ░███ ░░░   ███████ ░███ ░░░  ░███ ░███████   ",
    "   ░███ ░███ ░███      ███░░███ ░███  ███ ░███ ░███░░░    ",
    "   ░░██████  █████    ░░████████░░██████  █████░░██████   ",
    "    ░░░░░░  ░░░░░      ░░░░░░░░  ░░░░░░  ░░░░░  ░░░░░░    ",
)

SILENT_OUTPUT = {
    "[anthropic_billing_bypass] Bypass installed",
    "[anthropic_billing_bypass] Transport unwrap hook installed",
}


def _oracle_chain(command):
    node = os.environ.get("ORACLE_NODE_BIN")
    entry = os.environ.get("ORACLE_CLI_ENTRY")
    if not node or not entry:
        return False, "oracle chain is unavailable in this session"

    parts = command.strip().split()[1:]
    args = parts or ["list"]
    try:
        result = subprocess.run(
            [node, entry, "chain", *args],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"oracle chain failed: {exc}"

    output = "\n".join(
        part.strip() for part in (result.stdout, result.stderr) if part.strip()
    )
    if result.returncode != 0:
        return False, output or "oracle chain failed"

    state = subprocess.run(
        [node, entry, "chain", "show", "--json"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if state.returncode in (0, 1):
        try:
            active = json.loads(state.stdout).get("active") or {}
            if active:
                os.environ["ORACLE_ACTIVE_CHAIN"] = str(active.get("key", ""))
                os.environ["ORACLE_ACTIVE_CHAIN_ID"] = str(active.get("chainId", ""))
                os.environ["ORACLE_ACTIVE_AGENT"] = str(active.get("agent", ""))
            else:
                os.environ.pop("ORACLE_ACTIVE_CHAIN", None)
                os.environ.pop("ORACLE_ACTIVE_CHAIN_ID", None)
                os.environ.pop("ORACLE_ACTIVE_AGENT", None)
        except (TypeError, ValueError):
            pass
    return True, output


class OracleOutput:
    def __init__(self, wrapped):
        self.wrapped = wrapped

    def write(self, data):
        kept = "".join(
            line
            for line in data.splitlines(keepends=True)
            if line.rstrip("\r\n") not in SILENT_OUTPUT
        )
        kept = kept.replace("hermes model", "oracle model")
        kept = kept.replace("hermes --resume", "oracle --resume")
        kept = kept.replace("hermes -c", "oracle -c")
        kept = kept.replace(" in ~/.hermes/.env", " through oracle model")
        if kept:
            self.wrapped.write(kept)
        return len(data)

    def flush(self):
        return self.wrapped.flush()

    def __getattr__(self, name):
        return getattr(self.wrapped, name)


def patch_cli(module):
    cls = getattr(module, "HermesCLI", None)
    if cls is None or getattr(cls, "_oracle_patched", False):
        return

    original_style = getattr(cls, "_build_tui_style_dict", None)
    original_process_command = cls.process_command

    def show_banner(self):
        from rich.align import Align
        from rich.console import Group
        from rich.panel import Panel
        from rich.text import Text
        from rich import box

        self.console.clear()
        width = shutil.get_terminal_size((100, 28)).columns

        panel_width = max(36, min(width - 4, 76))
        panel_left = (width - panel_width) // 2
        content_left = panel_left + 3
        inner = panel_width - 6

        def pad_for(ink_width, ink_offset=0):
            target = int(round((width - ink_width) / 2.0))
            pad = target - ink_offset - content_left
            return max(0, min(max(0, inner - ink_width - ink_offset), pad))

        content = []
        tagline = "THE FUTURE IS AGENTIC  /  by DEMI"

        if width >= 72:
            colors = (
                "#B8F0FF",
                "#B8F0FF",
                "#ACDEEF",
                "#A5D9EB",
                "#9FCBDD",
                "#B8F0FF",
            )
            span = max(len(row) for row in WORDMARK)
            ink_cols = [
                index
                for index in range(span)
                if any(index < len(row) and row[index] != " " for row in WORDMARK)
            ]
            ink_offset = ink_cols[0]
            ink_width = ink_cols[-1] - ink_cols[0] + 1
            pad = " " * pad_for(ink_width, ink_offset)
            for index, line in enumerate(WORDMARK):
                content.append(
                    Text(pad + line.rstrip(), style=f"bold {colors[index]}", no_wrap=True)
                )
        else:
            content.append(Text(" " * pad_for(6) + "oracle", style="bold #B8F0FF"))

        content.append(Text(""))
        content.append(
            Text(" " * pad_for(len(tagline)) + tagline, style="bold #EAF2F8", no_wrap=True)
        )

        panel = Panel(
            Group(*content),
            width=panel_width,
            padding=(1, 2),
            border_style="#3B4A56",
            box=box.ROUNDED,
        )
        self.console.print(Align.center(panel))
        self.console.print()

    def prompt_fragments(self):
        if getattr(self, "_voice_recording", False):
            return [("class:voice-recording", "recording ")]
        if getattr(self, "_voice_processing", False):
            return [("class:voice-processing", "transcribing ")]
        if getattr(self, "_sudo_state", None) or getattr(self, "_secret_state", None):
            return [("class:sudo-prompt", "secure › ")]
        if getattr(self, "_approval_state", None) or getattr(self, "_slash_confirm_state", None):
            return [("class:prompt-working", "confirm › ")]
        if getattr(self, "_clarify_freetext", False):
            return [("class:clarify-selected", "answer › ")]
        if getattr(self, "_clarify_state", None):
            return [("class:prompt-working", "choose › ")]
        if getattr(self, "_command_running", False):
            return [("class:prompt-working", "working ")]
        if getattr(self, "_agent_running", False):
            return [("class:prompt-working", "thinking ")]
        return [("class:prompt", "  oracle  › ")]

    def status_fragments(self):
        if not getattr(self, "_status_bar_visible", True) or getattr(self, "_model_picker_state", None):
            return []
        try:
            snapshot = self._get_status_bar_snapshot()
            width = self._get_tui_terminal_width()
            model = snapshot.get("model_short") or "model"
            percent = snapshot.get("context_percent") or 0
            context_tokens = snapshot.get("context_tokens") or 0
            context_length = snapshot.get("context_length") or 0
            context_bar = self._build_context_bar(percent, width=8)

            def compact_tokens(value):
                if value >= 1_000_000:
                    return f"{value / 1_000_000:.1f}M"
                if value >= 1_000:
                    return f"{value / 1_000:.0f}K"
                return str(value)

            usage = f"{compact_tokens(context_tokens)}/{compact_tokens(context_length)} " if context_length else ""
            reasoning_config = getattr(self, "reasoning_config", None) or {}
            if reasoning_config.get("enabled") is False:
                effort = "none"
            else:
                effort = reasoning_config.get("effort") or "default"
            thinking = snapshot.get("prompt_elapsed") or "0s"
            thinking = thinking.replace("⏱ ", "").replace("⏲ ", "")
            chain = os.environ.get("ORACLE_ACTIVE_CHAIN", "").strip()

            def status_tail():
                fragments = [
                    ("class:status-bar-dim", " / "),
                    ("class:status-bar-effort", effort),
                    ("class:status-bar-dim", " / "),
                    ("class:status-bar-time", thinking),
                ]
                if chain:
                    fragments.extend(
                        [
                            ("class:status-bar-dim", " / "),
                            ("class:status-bar-chain", chain),
                        ]
                    )
                fragments.append(("class:status-bar", "  "))
                return fragments

            if width < 48:
                short_bar = self._build_context_bar(percent, width=4)
                return [
                    ("class:status-bar", "  "),
                    ("class:status-bar-context", f"ctx {short_bar} {percent}%"),
                ] + status_tail()
            if width < 70:
                short_bar = self._build_context_bar(percent, width=4)
                return [
                    ("class:status-bar", "  "),
                    ("class:status-bar-context", f"ctx {short_bar} {percent}%"),
                ] + status_tail()
            if width < 92:
                return [
                    ("class:status-bar", "  "),
                    ("class:status-bar-strong", model),
                    ("class:status-bar-dim", " / "),
                    ("class:status-bar-context", f"ctx {context_bar} {usage}{percent}%"),
                ] + status_tail()
            return [
                ("class:status-bar", "  "),
                ("class:status-bar-brand", "oracle"),
                ("class:status-bar-dim", " / "),
                ("class:status-bar-strong", model),
                ("class:status-bar-dim", " / "),
                ("class:status-bar-context", f"ctx {context_bar} {usage}{percent}%"),
            ] + status_tail()
        except Exception:
            return [("class:status-bar-brand", "  oracle  ")]

    def layout_children(
        self,
        *,
        sudo_widget,
        secret_widget,
        approval_widget,
        slash_confirm_widget=None,
        clarify_widget,
        model_picker_widget=None,
        spinner_widget=None,
        spacer,
        status_bar,
        input_rule_top,
        image_bar,
        input_area,
        input_rule_bot,
        voice_status_bar,
        completions_menu,
    ):
        from prompt_toolkit.layout.containers import HSplit, VSplit, Window
        from prompt_toolkit.widgets import Frame
        from prompt_toolkit.widgets.base import Border

        Border.TOP_LEFT = "╭"
        Border.TOP_RIGHT = "╮"
        Border.BOTTOM_LEFT = "╰"
        Border.BOTTOM_RIGHT = "╯"

        composer = VSplit(
            [
                Window(width=1),
                Frame(
                    HSplit([item for item in (image_bar, input_area) if item is not None]),
                    style="class:oracle-composer",
                ),
                Window(width=1),
            ]
        )
        return [
            item
            for item in (
                Window(height=0),
                sudo_widget,
                secret_widget,
                approval_widget,
                slash_confirm_widget,
                clarify_widget,
                model_picker_widget,
                spinner_widget,
                spacer,
                composer,
                completions_menu,
                voice_status_bar,
                status_bar,
            )
            if item is not None
        ]

    def build_style(self):
        style = original_style(self) if original_style else {}
        style.update(
            {
                "frame": "bg:#0B0E11 #EAF2F8",
                "frame.border": "#455867",
                "frame.label": "bold #B8F0FF",
                "oracle-composer": "bg:#0B0E11 #EAF2F8",
                "input-area": "bg:#0B0E11 #EAF2F8",
                "prompt": "bold #B8F0FF",
                "prompt-working": "bold #91C2D7",
                "status-bar": "bg:#11161B #91A2B1",
                "status-bar-brand": "bg:#11161B bold #B8F0FF",
                "status-bar-strong": "bg:#11161B #EAF2F8",
                "status-bar-context": "bg:#11161B #A5D9EB",
                "status-bar-effort": "bg:#11161B #C5B8FF",
                "status-bar-time": "bg:#11161B #91A2B1",
                "status-bar-chain": "bg:#11161B #B8F0FF",
                "status-bar-dim": "bg:#11161B #60717F",
            }
        )
        return style

    def process_command(self, command):
        parts = command.strip().lower().split(maxsplit=1)
        if parts and parts[0] == "/chain":
            ok, output = _oracle_chain(command)
            prefix = "" if ok else "error: "
            lines = output.splitlines() or [""]
            for index, line in enumerate(lines):
                module._cprint(f"{prefix if index == 0 else ''}{line}")
            return True
        return original_process_command(self, command)

    setattr(cls, "show_banner", show_banner)
    setattr(cls, "_get_tui_prompt_fragments", prompt_fragments)
    setattr(cls, "_get_status_bar_fragments", status_fragments)
    setattr(cls, "_build_tui_layout_children", layout_children)
    setattr(cls, "_build_tui_style_dict", build_style)
    setattr(cls, "process_command", process_command)
    setattr(cls, "_oracle_patched", True)

    try:
        tips = importlib.import_module("hermes_cli.tips")

        def no_tip():
            raise LookupError("oracle quiet startup")

        setattr(tips, "get_random_tip", no_tip)
    except Exception:
        pass


class OracleLoader(importlib.abc.Loader):
    def __init__(self, wrapped):
        self.wrapped = wrapped

    def create_module(self, spec):
        if hasattr(self.wrapped, "create_module"):
            return self.wrapped.create_module(spec)
        return None

    def exec_module(self, module):
        self.wrapped.exec_module(module)
        patch_cli(module)


class OracleFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        if fullname != "cli":
            return None
        try:
            sys.meta_path.remove(self)
        except ValueError:
            pass
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and spec.loader:
            spec.loader = OracleLoader(spec.loader)
        return spec


def main():
    sys.stdout = OracleOutput(sys.stdout)
    sys.stderr = OracleOutput(sys.stderr)
    sys.meta_path.insert(0, OracleFinder())
    from hermes_cli.main import main as hermes_main

    return hermes_main()


if __name__ == "__main__":
    raise SystemExit(main())
