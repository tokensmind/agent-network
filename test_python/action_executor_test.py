import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).parents[1] / "skills" / "tokensmind-agent-network-runtime" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from agent_network_runtime import ActionExecutor  # noqa: E402
from python_runtime.connector import AgentNetworkConnector  # noqa: E402
from python_runtime.errors import AgentNetworkHttpError  # noqa: E402


class MemoryWorkflow:
    def __init__(self):
        self.value = None

    def read(self):
        return self.value

    def write(self, value):
        self.value = value

    def remove(self):
        existed = self.value is not None
        self.value = None
        return existed


class FakeApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, path, body=None, *, key=None):
        self.calls.append({"method": method, "path": path, "body": body, "key": key})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class AuthorizationStore:
    def __init__(self):
        self.values = {}

    def read(self, name):
        return self.values.get(name)

    def write(self, name, value):
        self.values[name] = value

    def remove(self, name):
        self.values.pop(name, None)


class AuthorizationHttp:
    def __init__(self, store, requests):
        self.store = store
        self.requests = requests

    def request(self, url, method="GET", headers=None, *, body=None):
        self.requests.append({"url": url, "method": method, "headers": headers, "body": body})
        if method == "POST" and url.endswith("/device-authorizations"):
            return {
                "authorizationId": body["authorizationId"],
                "userCode": "ABCD-EFGH",
                "verificationUrl": "https://tokensmind.ai/console/agent-network/authorize/%s" % body["authorizationId"],
                "expiresAt": "2099-01-01T00:00:00Z",
                "intervalSeconds": 1,
            }
        pending = self.store.read("pending")
        if url.endswith("/exchange"):
            return {
                "authorizationId": pending["authorizationId"],
                "status": "exchanged",
                "credential": {"id": "credential-1", "agentId": None, "tokenPrefix": pending["tokenPrefix"]},
            }
        if "/device-authorizations/" in url:
            return {"authorizationId": pending["authorizationId"], "expiresAt": pending["authorization"]["expiresAt"], "status": "approved"}
        return []


class ActionExecutorTest(unittest.TestCase):
    def test_contact_agent_performs_business_loop(self):
        mine = {"id": "agent-me", "name": "My Agent"}
        target = {"id": "agent-target", "name": "Research Agent"}
        requirement = {"id": "requirement-1", "status": "draft"}
        api = FakeApi([
            [mine], [target], requirement,
            {"requirement": {**requirement, "status": "open"}},
            [{"agent": target, "canReceiveNewConversations": True}],
            {"conversation": {"id": "conversation-1"}, "created": True, "message": {"id": 1}},
        ])
        executor = ActionExecutor(api, MemoryWorkflow())
        result = executor.execute({
            "operation": "contact_agent",
            "input": {
                "target": {"name": "Research Agent"},
                "message": "Let us discuss research collaboration.",
                "requirement": {
                    "title": "Research help",
                    "description": "A sufficiently detailed research collaboration request.",
                },
            },
        })
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["data"]["created"])
        self.assertEqual([call["method"] + " " + call["path"] for call in api.calls], [
            "GET /agent-network-api/agents?mine=1",
            "GET /agent-network-api/agents?q=Research%20Agent&limit=20",
            "POST /agent-network-api/requirements",
            "POST /agent-network-api/requirements/requirement-1/publish",
            "GET /agent-network-api/requirements/requirement-1/recommendations",
            "POST /agent-network-api/conversations",
        ])
        self.assertTrue(api.calls[2]["key"].endswith(":requirement:create"))

    def test_missing_input_has_no_side_effect(self):
        api = FakeApi([])
        result = ActionExecutor(api, MemoryWorkflow()).execute({
            "operation": "contact_agent",
            "input": {"target": {"id": "agent-target"}},
        })
        self.assertEqual(result["status"], "input_required")
        self.assertEqual(api.calls, [])

    def test_update_agent_reads_owned_profile_then_updates_it(self):
        current = {"id": "agent-me", "name": "My Agent"}
        updated = {**current, "description": "Finds partners who enjoy anime."}
        api = FakeApi([[current], {"agent": updated}])
        result = ActionExecutor(api, MemoryWorkflow()).execute({
            "operation": "update_agent",
            "input": {"agent": {"description": updated["description"]}},
        })
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["data"]["updated"])
        self.assertEqual(api.calls[1]["method"], "PATCH")
        self.assertEqual(api.calls[1]["path"], "/agent-network-api/agents/agent-me")
        self.assertTrue(api.calls[1]["key"].endswith(":agent:update"))

    def test_unsupported_operation_is_input_required(self):
        result = ActionExecutor(FakeApi([]), MemoryWorkflow()).execute({
            "operation": "raw_request", "input": {},
        })
        self.assertEqual(result["status"], "input_required")

    def test_query_values_and_path_segments_are_encoded(self):
        api = FakeApi([[]])
        result = ActionExecutor(api, MemoryWorkflow()).execute({
            "operation": "search_agents",
            "input": {"query": "a/b? c"},
        })
        self.assertEqual(result["status"], "completed")
        self.assertEqual(api.calls[0]["path"], "/agent-network-api/agents?limit=20&q=a%2Fb%3F%20c")

    def test_unblock_agent_includes_encoded_blocker_id(self):
        api = FakeApi([{}])
        result = ActionExecutor(api, MemoryWorkflow()).execute({
            "operation": "unblock_agent",
            "input": {"blockedAgentId": "agent/blocked", "blockerAgentId": "agent/owner"},
        })
        self.assertEqual(result["status"], "completed")
        self.assertEqual(api.calls[0]["path"], "/agent-network-api/blocks/agent%2Fblocked?blockerAgentId=agent%2Fowner")

    def test_http_failure_preserves_correction_and_retry_after(self):
        error = AgentNetworkHttpError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            response={"correction": {"problem": "rate", "fix": "retry"}},
            headers={"retryAfter": "10"},
        )
        result = ActionExecutor(FakeApi([error]), MemoryWorkflow()).execute({
            "operation": "get_my_agent",
            "input": {},
        })
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["httpStatus"], 429)
        self.assertEqual(result["code"], "RATE_LIMITED")
        self.assertEqual(result["correction"]["fix"], "retry")
        self.assertEqual(result["retryAfter"], "10")

    def test_authorization_opens_browser_polls_and_resumes(self):
        store = AuthorizationStore()
        requests = []
        connector = AgentNetworkConnector(
            store=store,
            browser=type("Browser", (), {"open": lambda self, url: None})(),
            base_url="https://tokensmind.ai",
            http=AuthorizationHttp(store, requests),
            client={"name": "test", "version": "1", "deviceName": "test", "platform": "test"},
        )
        operation = {"method": "GET", "path": "/agent-network-api/agents?mine=1"}
        self.assertEqual(connector.execute(operation), [])
        self.assertEqual(len(requests), 4)

    def test_python_cli_emits_one_structured_result(self):
        script = SCRIPT_DIR / "agent_network_runtime.py"
        with tempfile.TemporaryDirectory() as state_dir:
            environment = os.environ.copy()
            environment["TOKENSMIND_AGENT_NETWORK_STATE_DIR"] = state_dir
            result = subprocess.run(
                [sys.executable, str(script)],
                input=json.dumps({"operation": "unsupported_operation", "input": {}}),
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {
            "status": "input_required",
            "message": "Provide a supported operation and object input.",
            "fields": ["operation", "input"],
        })
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
