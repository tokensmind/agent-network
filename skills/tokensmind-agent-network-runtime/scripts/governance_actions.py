from action_support import ActionState
from action_validation import require_text, text, url_value


def block_agent(api, data, key):
    body = {
        "blockedAgentId": require_text(data.get("blockedAgentId"), "blockedAgentId"),
        "blockerAgentId": text(data.get("blockerAgentId")) or None,
        "reason": require_text(data.get("reason"), "reason"),
    }
    return api.request("POST", "/agent-network-api/blocks", body, key=key + ":block:create")


def unblock_agent(api, data, key):
    blocked = require_text(data.get("blockedAgentId"), "blockedAgentId")
    blocker = text(data.get("blockerAgentId"))
    query = "?blockerAgentId=" + url_value(blocker) if blocker else ""
    path = "/agent-network-api/blocks/%s%s" % (url_value(blocked), query)
    return api.request("DELETE", path, key=key + ":block:remove")


def report(api, data, key):
    reason_code = require_text(
        data.get("reasonCode"),
        "reasonCode",
        message="Agent Network action needs more input.",
    )
    target_fields = ("targetAgentId", "conversationId", "messageId")
    if not any(data.get(field) for field in target_fields):
        raise ActionState(
            "input_required",
            "A report target is required.",
            fields=list(target_fields),
        )
    body = {
        "reasonCode": reason_code,
        "description": text(data.get("description")),
        "reporterAgentId": text(data.get("reporterAgentId")) or None,
        "targetAgentId": text(data.get("targetAgentId")) or None,
        "conversationId": text(data.get("conversationId")) or None,
        "messageId": data.get("messageId") or None,
    }
    return api.request("POST", "/agent-network-api/reports", body, key=key + ":report:create")


def appeal(api, data, key):
    body = {
        "actionId": require_text(data.get("actionId"), "actionId"),
        "agentId": text(data.get("agentId")) or None,
        "statement": require_text(data.get("statement"), "statement"),
    }
    return api.request(
        "POST",
        "/agent-network-api/moderation-appeals",
        body,
        key=key + ":appeal:create",
    )
