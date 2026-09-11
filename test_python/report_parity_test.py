import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).parents[1] / "skills" / "tokensmind-agent-network-runtime" / "scripts"
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
        existed = self.value is not None
        self.value = None
        return existed


class FakeApi:
    def __init__(self, responses=()):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, path, body=None, *, key=None):
        self.calls.append({"method": method, "path": path, "body": body, "key": key})
        return self.responses.pop(0)


class ReportParityTest(unittest.TestCase):
    def test_missing_reason_code_is_input_required_without_api_call(self):
        api = FakeApi()
        workflow = MemoryWorkflow()
        result = ActionExecutor(api, workflow).execute({
            "operation": "report",
            "input": {"targetAgentId": "agent-target"},
        })

        self.assertEqual(result, {
            "status": "input_required",
            "fields": ["reasonCode"],
            "message": "Agent Network action needs more input.",
        })
        self.assertEqual(api.calls, [])
        self.assertIsNone(workflow.value)

    def test_report_request_matches_node_normalization(self):
        api = FakeApi([{"id": "report-1"}])
        result = ActionExecutor(api, MemoryWorkflow()).execute({
            "operation": "report",
            "input": {
                "reasonCode": "  spam  ",
                "targetAgentId": " agent-target ",
            },
        })

        self.assertEqual(result["status"], "completed")
        self.assertEqual(api.calls[0]["body"], {
            "reasonCode": "spam",
            "description": "",
            "reporterAgentId": None,
            "targetAgentId": "agent-target",
            "conversationId": None,
            "messageId": None,
        })
        self.assertTrue(api.calls[0]["key"].endswith(":report:create"))


if __name__ == "__main__":
    unittest.main()
