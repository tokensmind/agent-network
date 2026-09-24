#!/usr/bin/env python3
import json
import os
import socket
import sys

from action_executor import ActionExecutor as BaseActionExecutor, validate_request
from action_support import ActionApi, ActionState, LazyStore, ReportingBrowser, WorkflowStore
from action_validation import require_text as _need
from action_validation import text as _text
from action_validation import url_value as _url_value
from governance_actions import appeal as _appeal
from governance_actions import block_agent as _block_agent
from governance_actions import report as _report
from governance_actions import unblock_agent as _unblock_agent
from memory_actions import delete_memory as _delete_memory
from memory_actions import get_memory_settings as _get_memory_settings
from memory_actions import list_memories as _list_memories
from memory_actions import propose_memory as _propose_memory
from python_runtime.browser import BrowserOpener
from python_runtime.connector import AgentNetworkConnector
from python_runtime.constants import DEFAULT_BASE_URL
from python_runtime.credential_store import create_credential_store
from python_runtime.http_client import HttpClient
from python_runtime.request_policy import normalize_base_url

OPERATIONS = frozenset((
    "abandon_action", "search_agents", "get_my_agent", "ensure_agent", "update_agent",
    "contact_agent", "list_inbox",
    "get_conversation", "reply", "mark_read", "withdraw_message", "block_agent",
    "unblock_agent", "report", "appeal",
    "get_memory_settings", "propose_memory", "list_memories", "delete_memory",
))


def _tags(value):
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ActionState("input_required", "agent.tags must be an array of strings.", fields=["agent.tags"])
    return value


def _target(api, data):
    target = data.get("target") or {}
    target_id = _text(target.get("id"))
    if target_id:
        return {"id": target_id, "name": _text(target.get("name"))}
    name = _need(target.get("name"), "target.name")
    agents = api.request("GET", "/agent-network-api/agents?q=%s" % _url_value(name))
    exact = [agent for agent in agents if _text(agent.get("name")).lower() == name.lower()]
    candidates = exact or agents
    if not candidates:
        raise ActionState("failed", "No Agent matched the requested name.", code="TARGET_AGENT_NOT_FOUND", retryable=False)
    if len(candidates) != 1:
        raise ActionState("selection_required", "Choose the Agent to contact.", candidates=candidates)
    return candidates[0]


def _agent(api, data, key):
    agents = api.request("GET", "/agent-network-api/agents?mine=1")
    if len(agents) > 1:
        raise ActionState("failed", "The account has more than one Agent profile.", code="AGENT_ACCOUNT_INVARIANT", retryable=False)
    if agents:
        return {"agent": agents[0], "created": False}
    profile = data.get("agent") or data.get("profile") or {}
    name = _need(profile.get("name"), "agent.name")
    description = _need(profile.get("description"), "agent.description")
    body = {"name": name, "description": description, "tags": _tags(profile.get("tags"))}
    result = api.request("POST", "/agent-network-api/agents", body, key=key + ":agent:create")
    if not result.get("agent"):
        raise ActionState("failed", "Agent creation returned no Agent.", code="AGENT_CREATE_PROTOCOL_ERROR", retryable=False)
    return {"agent": result["agent"], "created": True}


def _contact(api, data, key):
    message = _need(data.get("message"), "message")
    requirement_input = data.get("requirement") or {}
    if not _text(requirement_input.get("id")):
        _need(requirement_input.get("title"), "requirement.title")
        _need(requirement_input.get("description"), "requirement.description")
    current = _agent(api, data, key)
    target = _target(api, data)
    requirement_id = _text(requirement_input.get("id"))
    if requirement_id:
        requirement = api.request("GET", "/agent-network-api/requirements/%s" % _url_value(requirement_id))
    else:
        requirement = api.request("POST", "/agent-network-api/requirements", {
            "publisherAgentId": current["agent"]["id"],
            "title": _text(requirement_input.get("title")),
            "description": _text(requirement_input.get("description")),
            "requiredCapabilities": requirement_input.get("requiredCapabilities", []),
            "optionalCapabilities": requirement_input.get("optionalCapabilities", []),
            "industries": requirement_input.get("industries", []),
            "languages": requirement_input.get("languages", []),
            "budgetMin": requirement_input.get("budgetMin"),
            "budgetMax": requirement_input.get("budgetMax"),
            "currency": requirement_input.get("currency", "USD"),
            "deadline": requirement_input.get("deadline"),
            "visibility": requirement_input.get("visibility", "public"),
        }, key=key + ":requirement:create")
    if requirement.get("status") == "draft":
        published = api.request("POST", "/agent-network-api/requirements/%s/publish" % _url_value(requirement["id"]), key=key + ":requirement:publish")
        requirement = published.get("requirement")
    if requirement.get("status") != "open":
        raise ActionState("failed", "Requirement cannot be used for contact.", code="REQUIREMENT_NOT_OPENABLE", requirement=requirement, retryable=False)
    recommendations = api.request("GET", "/agent-network-api/requirements/%s/recommendations" % _url_value(requirement["id"]))
    eligible = next((item for item in recommendations if item.get("agent", {}).get("id") == target.get("id") and item.get("canReceiveNewConversations") is True), None)
    if not eligible:
        raise ActionState("failed", "The requested Agent is not an eligible recommendation.", code="TARGET_NOT_ELIGIBLE", requirement=requirement, target=target, retryable=False)
    conversation = api.request("POST", "/agent-network-api/conversations", {
        "requesterAgentId": current["agent"]["id"],
        "requirementId": requirement["id"],
        "targetAgentId": target["id"],
        "initialMessage": {"clientMessageId": key + ":conversation:create:message", "content": message},
    }, key=key + ":conversation:create")
    return {"agent": current["agent"], "target": target, "requirement": requirement, "conversation": conversation.get("conversation"), "message": conversation.get("message"), "created": conversation.get("created") is True, "messageSent": conversation.get("created") is True}


def _search_agents(api, data, _key):
    query = _need(data.get("query"), "query")
    agent = _get_my_agent(api, data, _key)
    if not agent:
        raise ActionState(
            "failed",
            "Sign-in succeeded, but this account has no Agent profile. Ask the user for an Agent name and description, then run ensure_agent before searching.",
            code="AGENT_PROFILE_REQUIRED",
            nextOperation="ensure_agent",
            requiredFields=["agent.name", "agent.description"],
            retryable=False,
        )
    return api.request("GET", "/agent-network-api/agents?q=" + _url_value(query))


def _get_my_agent(api, _data, _key):
    agents = api.request("GET", "/agent-network-api/agents?mine=1")
    if len(agents) > 1:
        raise ActionState("failed", "The account has more than one Agent profile.", code="AGENT_ACCOUNT_INVARIANT", retryable=False)
    return agents[0] if agents else None


def _update_agent(api, data, key):
    agent = _get_my_agent(api, data, key)
    if not agent:
        raise ActionState("failed", "Create the account Agent profile before updating it.", code="AGENT_PROFILE_REQUIRED", retryable=False)
    profile = data.get("agent") or data.get("profile") or {}
    if not any(field in profile for field in ("name", "description", "tags")):
        fields = ["agent.name", "agent.description", "agent.tags"]
        raise ActionState("input_required", "Missing required action input.", fields=fields)
    body = {
        "name": _need(profile.get("name", agent.get("name")), "agent.name"),
        "description": _need(profile.get("description", agent.get("description")), "agent.description"),
        "tags": _tags(profile.get("tags", agent.get("tags"))),
    }
    path = "/agent-network-api/agents/%s" % _url_value(agent["id"])
    result = api.request("PATCH", path, body, key=key + ":agent:update")
    if not result.get("agent"):
        raise ActionState("failed", "Agent update returned no Agent.", code="AGENT_UPDATE_PROTOCOL_ERROR", retryable=False)
    return {"agent": result["agent"], "updated": True}


def _list_inbox(api, data, _key):
    query = "?limit=%s" % _limit(data.get("limit"))
    if _text(data.get("cursor")):
        query += "&cursor=" + _url_value(data["cursor"])
    return api.request("GET", "/agent-network-api/inbox" + query)


def _get_conversation(api, data, _key):
    conversation_id = _need(data.get("conversationId"), "conversationId")
    query = "?limit=%s" % _limit(data.get("limit"))
    for field in ("cursor", "before", "direction"):
        if _text(data.get(field)):
            query += "&%s=%s" % (field, _url_value(data[field]))
    path = "/agent-network-api/conversations/%s/messages%s" % (_url_value(conversation_id), query)
    return api.request("GET", path)


def _reply(api, data, key):
    conversation_id = _need(data.get("conversationId"), "conversationId")
    body = {"clientMessageId": key + ":message:reply", "content": _need(data.get("content"), "content")}
    return api.request("POST", "/agent-network-api/conversations/%s/messages" % _url_value(conversation_id), body, key=key + ":message:reply")


def _mark_read(api, data, key):
    conversation_id = _need(data.get("conversationId"), "conversationId")
    message_id = data.get("lastReadMessageId")
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id <= 0:
        raise ActionState("input_required", "lastReadMessageId must be a positive integer.", fields=["lastReadMessageId"])
    path = "/agent-network-api/conversations/%s/read" % _url_value(conversation_id)
    return api.request("POST", path, {"lastReadMessageId": message_id}, key=key + ":conversation:read")


def _withdraw_message(api, data, key):
    message_id = _need(data.get("messageId"), "messageId")
    return api.request("POST", "/agent-network-api/messages/%s/withdraw" % _url_value(message_id), key=key + ":message:withdraw")


ACTION_HANDLERS = {
    "search_agents": _search_agents,
    "get_my_agent": _get_my_agent,
    "ensure_agent": _agent,
    "update_agent": _update_agent,
    "contact_agent": _contact,
    "list_inbox": _list_inbox,
    "get_conversation": _get_conversation,
    "reply": _reply,
    "mark_read": _mark_read,
    "withdraw_message": _withdraw_message,
    "block_agent": _block_agent,
    "unblock_agent": _unblock_agent,
    "report": _report,
    "appeal": _appeal,
    "get_memory_settings": _get_memory_settings,
    "propose_memory": _propose_memory,
    "list_memories": _list_memories,
    "delete_memory": _delete_memory,
}


class ActionExecutor(BaseActionExecutor):
    def __init__(self, api, workflow):
        super().__init__(api, workflow, handlers=ACTION_HANDLERS, operations=OPERATIONS)


def _runtime_platform():
    if sys.platform.startswith("linux"):
        return "linux"
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform in ("win32", "cygwin"):
        return "win32"
    return sys.platform


def create_executor(base_url=DEFAULT_BASE_URL, *, state_dir=None, write_event=None, browser=None, http=None, store=None):
    origin = normalize_base_url(base_url)
    platform = _runtime_platform()
    writer = write_event or (lambda event: _write_json(sys.stderr, event))
    credential_store = store or LazyStore(lambda: create_credential_store(
        origin=origin,
        platform=platform,
        state_dir=state_dir,
        env=os.environ,
        on_fallback=lambda fallback: writer({
            "event": "credential_store_fallback",
            **fallback,
        }),
    ))
    connector = AgentNetworkConnector(
        store=credential_store,
        browser=ReportingBrowser(browser or BrowserOpener(), writer),
        base_url=origin,
        http=http or HttpClient(),
        client={"name": "TokensMind Agent Network Runtime", "version": "0.1.0", "deviceName": socket.gethostname(), "platform": platform},
    )
    return ActionExecutor(ActionApi(connector), WorkflowStore(origin, platform, state_dir=state_dir))


def _write_json(stream, value):
    stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    stream.flush()


def run_cli(stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr):
    try:
        request = json.loads(stdin.read())
        try:
            validate_request(request, OPERATIONS)
        except ActionState as error:
            result = {"status": error.status, **error.data}
        else:
            result = create_executor(
                base_url=os.environ.get("TOKENSMIND_AGENT_NETWORK_BASE_URL", DEFAULT_BASE_URL),
                state_dir=os.environ.get("TOKENSMIND_AGENT_NETWORK_STATE_DIR") or None,
                write_event=lambda event: _write_json(stderr, event),
            ).execute(request)
        _write_json(stdout, result)
        return 1 if result.get("status") == "failed" else 0
    except Exception as error:
        _write_json(stdout, {"status": "failed", "code": "AGENT_NETWORK_ACTION_ERROR", "message": str(error), "retryable": False})
        return 1


if __name__ == "__main__":
    raise SystemExit(run_cli())
