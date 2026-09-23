from urllib.parse import quote

from action_support import ActionState


def text(value):
    return value.strip() if isinstance(value, str) else ""


def require_text(value, field, message="Missing required action input."):
    result = text(value)
    if not result:
        raise ActionState("input_required", message, fields=[field])
    return result


def limit(value):
    if value in (None, ""):
        return 20
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise ActionState(
            "input_required",
            "limit must be an integer from 1 to 100.",
            fields=["limit"],
        ) from error
    if result < 1 or result > 100:
        raise ActionState(
            "input_required",
            "limit must be an integer from 1 to 100.",
            fields=["limit"],
        )
    return result


def url_value(value):
    return quote(str(value), safe="")
