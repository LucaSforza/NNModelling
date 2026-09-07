"""RFC 8785 JSON canonicalization required by the provided generated wheel."""

from __future__ import annotations

import json
import math
from typing import Any


def canonicalize(value: Any) -> bytes:
    """Return canonical UTF-8 JSON bytes."""

    return _encode(value).encode("utf-8")


def _encode(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _number(value)
    if isinstance(value, list):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda item: item[0])
        return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + _encode(item) for key, item in items) + "}"
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def _number(value: int | float) -> str:
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite numbers are not valid JCS")
    if value == 0:
        return "0"
    text = repr(value).lower()
    if "e" not in text:
        return text
    mantissa, exponent = text.split("e")
    power = int(exponent)
    digits = mantissa.replace(".", "")
    sign = ""
    if digits.startswith("-"):
        sign, digits = "-", digits[1:]
    unsigned_mantissa = mantissa.lstrip("-")
    decimal_index = (unsigned_mantissa.find(".") if "." in unsigned_mantissa else len(unsigned_mantissa)) + power
    if -6 <= power < 21:
        if decimal_index <= 0:
            return sign + "0." + "0" * (-decimal_index) + digits
        if decimal_index >= len(digits):
            return sign + digits + "0" * (decimal_index - len(digits))
        return sign + digits[:decimal_index] + "." + digits[decimal_index:]
    normalized = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
    return f"{sign}{normalized}e{'+' if power >= 0 else ''}{power}"
