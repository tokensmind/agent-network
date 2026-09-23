import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).parents[1] / "skills" / "tokensmind-agent-network" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from agent_network_runtime import ActionExecutor  # noqa: E402


class MemoryWorkflow:
    def __init__(self):
        self.value = None

    def read(self):
        return self.value

    def write(self, value):
        self.value = value

    def remove(self):
        self.value = None
        return True


class FakeApi:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, path, body=None, *, key=None):
        self.calls.append({"method": method, "path": path, "body": body, "key": key})
        return self.responses.pop(0)


def explicit_memory():
    return {
        "agentId": "untrusted-agent",
        "clientMemoryId": "memory-client-1",
        "confidence": 1,
        "contextText": "Frontend implementation tasks",
        "kind": "matching_preference",
        "polarity": "positive",
        "scope": "contextual",
        "sourceType": "user_explicit",
        "statement": "Prefer Agents that deliver working code quickly.",
    }


class MemoryActionsTest(unittest.TestCase):
    OWNED_AGENT = {"id": "owned/agent", "name": "Memory Agent"}

    def execute(self, responses, operation, data):
        api = FakeApi(responses)
        result = ActionExecutor(api, MemoryWorkflow()).execute({"operation": operation, "input": data})
        return api, result

    def test_get_settings_uses_owned_agent(self):
        api, result = self.execute(
            [[self.OWNED_AGENT], {"collectionEnabled": True, "matchingEnabled": True}],
            "get_memory_settings", {"agentId": "untrusted-agent"},
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(api.calls[1]["path"], "/agent-network-api/agents/owned%2Fagent/memory-settings")

    def test_propose_memory_has_node_parity(self):
        api, result = self.execute(
            [[self.OWNED_AGENT], {"collectionEnabled": True}, {"id": "memory-1"}],
            "propose_memory", explicit_memory(),
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(api.calls[2]["path"], "/agent-network-api/agents/owned%2Fagent/memories")
        self.assertTrue(api.calls[2]["key"].endswith(":memory:propose"))
        self.assertNotIn("agentId", api.calls[2]["body"])

    def test_disabled_collection_stops_before_write(self):
        api, result = self.execute(
            [[self.OWNED_AGENT], {"collectionEnabled": False}],
            "propose_memory", explicit_memory(),
        )
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["code"], "MEMORY_COLLECTION_DISABLED")
        self.assertEqual(len(api.calls), 2)

    def test_inferred_confidence_is_validated_before_requests(self):
        data = {**explicit_memory(), "sourceType": "model_inferred", "confidence": 0.9}
        api, result = self.execute([], "propose_memory", data)
        self.assertEqual(result["status"], "input_required")
        self.assertEqual(result["fields"], ["confidence"])
        self.assertEqual(api.calls, [])

    def test_list_memories_encodes_filters(self):
        api, result = self.execute(
            [[self.OWNED_AGENT], {"items": [], "total": 0}],
            "list_memories", {"limit": 25, "offset": 5, "status": "pending_review"},
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(
            api.calls[1]["path"],
            "/agent-network-api/agents/owned%2Fagent/memories?limit=25&offset=5&status=pending_review",
        )

    def test_delete_memory_uses_owned_agent_and_stable_key(self):
        api, result = self.execute(
            [[self.OWNED_AGENT], {"deleted": True}],
            "delete_memory", {"agentId": "untrusted-agent", "memoryId": "memory/id"},
        )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(api.calls[1]["path"], "/agent-network-api/agents/owned%2Fagent/memories/memory%2Fid")
        self.assertTrue(api.calls[1]["key"].endswith(":memory:delete"))


if __name__ == "__main__":
    unittest.main()
