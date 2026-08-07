"""Hermes owner and raw-message intent gate for Oracle execution tools.

This is a routing guard, not a signer.  Local Operator policy remains the
final authority for every signature and broadcast.
"""

from __future__ import annotations

import json
import os
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

_MAX_SESSIONS = 256
_TURNS: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()

_PROTECTED = {
    "oracle_watch_create": "alert_only",
    "oracle_control_arm": "execute",
    "oracle_control_confirm": "execute",
    "oracle_action_cancel": "cancel",
    "oracle_action_list": "owner_read",
    "oracle_action_status": "owner_read",
    "oracle_operator_sign": "sign",
    "oracle_operator_send": "send",
    "oracle_operator_execute": "send",
    "exec_arm": "execute",
    "exec_disarm": "cancel",
    "evm_sign": "sign",
    "evm_send": "send",
    "bitcoin_sign": "sign",
    "bitcoin_send": "send",
    "bitcoin_inscribe_sign_commit": "sign",
    "bitcoin_inscribe_sign_reveal": "sign",
    "bitcoin_satflow_broadcast_purchase": "send",
    "solana_sign": "sign",
    "solana_send": "send",
    "evm_cow_order_sign": "sign",
    "evm_cow_order_submit": "send",
    "evm_cow_order_cancel_sign": "sign",
    "evm_cow_order_cancel_submit": "send",
    # The address book is durable state a later send can be routed against, so
    # writes are owner-only. Reads stay open to the owner's own sessions.
    "address_book_remember": "owner_write",
    "address_book_forget": "owner_write",
    "address_book_list": "owner_read",
    "address_book_lookup": "owner_read",
}

_EXEC_NAMESPACE_MARKERS = ("mad_exec_", "oracle_exec_", "oracle_control_")
_EXEC_OWNER_READ_OPERATIONS = {
    "bitcoin_decode",
    "bitcoin_exec_status",
    "bitcoin_inscribe_prepare",
    "bitcoin_inscribe_status",
    "bitcoin_prepare",
    "bitcoin_runes_prepare_transfer",
    "bitcoin_satflow_prepare_list",
    "bitcoin_satflow_prepare_purchase",
    "evm_chains",
    "evm_cow_order_cancel_prepare",
    "evm_cow_order_prepare",
    "evm_cow_order_status",
    "evm_cow_order_verify",
    "evm_erc20_allowance",
    "evm_erc20_revoke_prepare",
    "evm_gmx_order_prepare",
    "evm_gmx_order_verify",
    "evm_morpho_vault_prepare",
    "evm_prepare",
    "evm_protocol_prepare",
    "evm_protocol_quote",
    "evm_quote",
    "evm_simulate",
    "evm_status",
    "evm_verify_tx",
    "solana_decode",
    "solana_exec_status",
}

_LEADING_INTENT = re.compile(
    r"^\s*(watch|ping|arm\s+confirm|arm|cancel|disarm|sign|send|execute)(?=$|[\s:,.!?;\-])",
    re.IGNORECASE,
)


def _config_path() -> Path:
    override = os.environ.get("ORACLE_CONFIG_DIR")
    root = Path(override).expanduser() if override else Path.home() / ".config" / "oracle"
    return root / "owner.json"


def _read_config() -> Optional[Dict[str, Any]]:
    path = _config_path()
    try:
        if path.stat().st_mode & 0o077:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _strings(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value.strip()} if value.strip() else set()
    if isinstance(value, (list, tuple, set)):
        return {str(item).strip() for item in value if str(item).strip()}
    return set()


def _owner_ids(config: Dict[str, Any], platform: str) -> set[str]:
    """Accept the public flat form plus convenient per-platform mappings."""
    result = set()
    canonical = config.get("owner")
    if isinstance(canonical, str) and ":" in canonical:
        owner_platform, owner_id = canonical.split(":", 1)
        if owner_platform.strip().lower() == platform and owner_id.strip():
            result.add(owner_id.strip())
    for key in ("owner_ids", "ownerIds", "owners"):
        value = config.get(key)
        if isinstance(value, dict):
            result |= _strings(value.get(platform))
            result |= _strings(value.get("*"))
        else:
            result |= _strings(value)
    platforms = config.get("platforms")
    if isinstance(platforms, dict):
        entry = platforms.get(platform)
        if isinstance(entry, dict):
            result |= _strings(entry.get("owner_ids"))
            result |= _strings(entry.get("owners"))
        else:
            result |= _strings(entry)
    return result


def _local_cli_allowed(config: Dict[str, Any]) -> bool:
    value = config.get("local_cli", config.get("localCli", config.get("allow_local_cli", False)))
    if isinstance(value, dict):
        value = value.get("allow", value.get("owner", value.get("enabled", False)))
    return value is True or (isinstance(value, str) and value.lower() in {"allow", "owner", "enabled", "true"})


def _intent(raw_message: Any) -> str:
    if not isinstance(raw_message, str):
        return "none"
    match = _LEADING_INTENT.match(raw_message)
    if not match:
        return "none"
    command = " ".join(match.group(1).lower().split())
    if command in {"watch", "ping"}:
        return "alert_only"
    if command in {"arm", "arm confirm"}:
        return "execute"
    if command in {"cancel", "disarm"}:
        return "cancel"
    if command == "sign":
        return "sign"
    return "send"


def _tool_class(tool_name: Any) -> Optional[str]:
    # MCP adapters use several separators.  Collapsing all non-alphanumerics
    # lets us compare the authoritative suffix without trusting the prefix.
    normalized = re.sub(r"[^a-z0-9]+", "_", str(tool_name or "").lower()).strip("_")
    for suffix, tool_class in _PROTECTED.items():
        if normalized == suffix or normalized.endswith("_" + suffix):
            return tool_class
    # Tool catalogs grow faster than this plugin's explicit list. Once a tool
    # is in a signer/executor namespace, an unknown operation must not become
    # guest-accessible merely because its name is new. Only exact, reviewed
    # read/quote/simulate/prepare operation names get frictionless OWNER access;
    # every unknown operation requires owner send/execute intent and still
    # faces the signer-owned final policy.
    for marker in _EXEC_NAMESPACE_MARKERS:
        marker_at = normalized.find(marker)
        if marker_at < 0:
            continue
        operation = normalized[marker_at + len(marker):]
        words = set(operation.split("_"))
        if "sign" in words:
            return "sign"
        if words & {"send", "submit", "broadcast", "execute"}:
            return "send"
        if operation in _EXEC_OWNER_READ_OPERATIONS:
            return "owner_read"
        return "send"
    return None


def _identity(config: Optional[Dict[str, Any]], platform: str, sender_id: str) -> Tuple[bool, str]:
    if config is None:
        return False, "owner configuration is unavailable"
    platform = platform.strip().lower()
    sender_id = sender_id.strip()
    if platform in {"cli", "local", "terminal"}:
        if _local_cli_allowed(config):
            return True, ""
        return False, "local CLI is not authorized by owner policy"
    if not sender_id:
        return False, "gateway sender identity is missing"
    if sender_id not in _owner_ids(config, platform):
        return False, "sender is not an owner"
    return True, ""


def _block(reason: str) -> Dict[str, str]:
    return {"action": "block", "message": "Oracle owner gate: " + reason + "."}


def _on_pre_llm_call(
    session_id: str = "",
    sender_id: str = "",
    platform: str = "",
    user_message: Any = "",
    parent_session_id: str = "",
    **_: Any,
) -> None:
    """Snapshot only Hermes-trusted turn metadata and the original user input."""
    session_id = str(session_id or "").strip()
    if not session_id:
        return None
    _TURNS[session_id] = {
        "session_id": session_id,
        "parent_session_id": str(parent_session_id or "").strip(),
        "sender_id": str(sender_id or "").strip(),
        "platform": str(platform or "").strip().lower(),
        "raw_message": user_message if isinstance(user_message, str) else "",
        "intent": _intent(user_message),
    }
    _TURNS.move_to_end(session_id)
    while len(_TURNS) > _MAX_SESSIONS:
        _TURNS.popitem(last=False)
    return None


def _on_pre_tool_call(tool_name: str = "", session_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    required = _tool_class(tool_name)
    if required is None:
        return None
    session_id = str(session_id or "").strip()
    turn = _TURNS.get(session_id)
    if turn is None:
        return _block("no trusted current-turn owner message exists for this session")
    if turn["parent_session_id"]:
        return _block("delegated and background sessions cannot execute or sign")
    allowed, reason = _identity(_read_config(), turn["platform"], turn["sender_id"])
    if not allowed:
        return _block(reason)
    if required == "owner_read":
        return None
    if required == "owner_write":
        # Owner-authenticated bookkeeping. It records a label; it does not move
        # value and does not need a leading execution verb like `arm`.
        return None
    intent = turn["intent"]
    if intent != required:
        labels = {
            "alert_only": "watch or ping",
            "execute": "arm",
            "cancel": "cancel or disarm",
            "sign": "sign",
            "send": "send or execute",
        }
        return _block(f"raw owner intent does not authorize {required}; start the message with {labels[required]}")
    return None


def _on_session_end(session_id: str = "", **_: Any) -> None:
    _TURNS.pop(str(session_id or "").strip(), None)


def _on_session_reset(session_id: str = "", **_: Any) -> None:
    session_id = str(session_id or "").strip()
    if session_id:
        _TURNS.pop(session_id, None)
    else:
        _TURNS.clear()


def register(ctx: Any) -> None:
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("on_session_reset", _on_session_reset)
