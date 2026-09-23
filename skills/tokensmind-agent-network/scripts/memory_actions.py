import math
from urllib.parse import quote, urlencode

from action_support import ActionState
from action_validation import require_text, text

MEMORY_KINDS = frozenset(("agent_experience", "matching_preference"))
MEMORY_POLARITIES = frozenset(("negative", "positive"))
MEMORY_SCOPES = frozenset(("contextual", "global"))
# platform_event is written by the service alone and is rejected from this client.
MEMORY_SOURCES = frozenset(("model_inferred", "user_explicit"))
MEMORY_STATUSES = frozenset(("active", "deleted", "pending_review", "rejected"))
MAX_INFERRED_CONFIDENCE = 0.6
DEFAULT_LIST_LIMIT = 20
MAX_LIST_LIMIT = 100


def _choice(data, field, allowed):
    value = text(data.get(field)).lower()
    if value not in allowed:
        raise ActionState("input_required", "%s has an unsupported value." % field, fields=[field])
    return value


def _confidence(value, source_type):
    if value in (None, ""):
        return MAX_INFERRED_CONFIDENCE if source_type == "model_inferred" else 1
    try:
        confidence = float(value)
    except (TypeError, ValueError) as error:
        raise ActionState("input_required", "confidence must be a number.", fields=["confidence"]) from error
    invalid = not math.isfinite(confidence) or confidence <= 0 or confidence > 1
    inferred_high = source_type == "model_inferred" and confidence > MAX_INFERRED_CONFIDENCE
    if invalid or inferred_high:
        raise ActionState(
            "input_required",
            "confidence must be above 0 and no more than 0.6 for inferred memory.",
            fields=["confidence"],
        )
    return confidence


def _owned_agent(api):
    agents = api.request("GET", "/agent-network-api/agents?mine=1")
    if len(agents) > 1:
        raise ActionState("failed", "The account has more than one Agent profile.", code="AGENT_ACCOUNT_INVARIANT", retryable=False)
    if not agents:
        raise ActionState("failed", "Create the account Agent profile first.", code="AGENT_PROFILE_REQUIRED", retryable=False)
    return agents[0]


def _agent_path(agent_id, suffix):
    return "/agent-network-api/agents/%s/%s" % (quote(str(agent_id), safe=""), suffix)


def _optional_text(data, field):
    return text(data.get(field)) or None


def _memory_body(data):
    source_type = _choice(data, "sourceType", MEMORY_SOURCES)
    scope = _choice(data, "scope", MEMORY_SCOPES) if data.get("scope") else "contextual"
    context_text = "" if scope == "global" else require_text(data.get("contextText"), "contextText")
    return {
        "clientMemoryId": require_text(data.get("clientMemoryId"), "clientMemoryId"),
        "confidence": _confidence(data.get("confidence"), source_type),
        "contextText": context_text,
        "conversationId": _optional_text(data, "conversationId"),
        "expiresAt": _optional_text(data, "expiresAt"),
        "kind": _choice(data, "kind", MEMORY_KINDS),
        "polarity": _choice(data, "polarity", MEMORY_POLARITIES),
        "requirementId": _optional_text(data, "requirementId"),
        "scope": scope,
        "sourceType": source_type,
        "statement": require_text(data.get("statement"), "statement"),
        "targetAgentId": _optional_text(data, "targetAgentId"),
    }


def _integer(value, field, minimum, maximum=None):
    if isinstance(value, bool):
        raise ActionState("input_required", "%s must be an integer." % field, fields=[field])
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ActionState("input_required", "%s must be an integer." % field, fields=[field]) from error
    if not number.is_integer() or number < minimum or (maximum is not None and number > maximum):
        raise ActionState("input_required", "%s must be an integer in range." % field, fields=[field])
    return int(number)


def _list_query(data):
    limit = _integer(data.get("limit", DEFAULT_LIST_LIMIT), "limit", 1, MAX_LIST_LIMIT)
    params = {"limit": limit}
    if data.get("offset") is not None:
        params["offset"] = _integer(data.get("offset"), "offset", 0)
    if data.get("status"):
        params["status"] = _choice(data, "status", MEMORY_STATUSES)
    return urlencode(params)


def get_memory_settings(api, _data, _key):
    agent = _owned_agent(api)
    return api.request("GET", _agent_path(agent["id"], "memory-settings"))


def propose_memory(api, data, key):
    body = _memory_body(data)
    agent = _owned_agent(api)
    settings_path = _agent_path(agent["id"], "memory-settings")
    settings = api.request("GET", settings_path)
    if settings.get("collectionEnabled") is not True:
        raise ActionState("failed", "Memory collection is disabled for this Agent.", code="MEMORY_COLLECTION_DISABLED", retryable=False)
    return api.request(
        "POST", _agent_path(agent["id"], "memories"), body,
        key=key + ":memory:propose",
    )


def list_memories(api, data, _key):
    query = _list_query(data)
    agent = _owned_agent(api)
    path = _agent_path(agent["id"], "memories") + "?" + query
    return api.request("GET", path)


def delete_memory(api, data, key):
    memory_id = require_text(data.get("memoryId"), "memoryId")
    agent = _owned_agent(api)
    path = _agent_path(agent["id"], "memories") + "/" + quote(memory_id, safe="")
    return api.request("DELETE", path, key=key + ":memory:delete")
