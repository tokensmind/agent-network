import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).parents[1] / "skills" / "tokensmind-agent-network-runtime" / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from agent_network_runtime import ActionExecutor, create_executor  # noqa: E402
from python_runtime.errors import AgentNetworkHttpError  # noqa: E402


class MemoryWorkflow:
    def __init__(self):
        self.value = None

    def read(self):
        return self.value

    def write(self, value):
        if self.value is None:
            self.value = value

    def remove(self):
        existed = self.value is not None
        self.value = None
        return existed


class WorkflowRecoveryTest(unittest.TestCase):
    def test_pending_action_requires_explicit_abandon(self):
        workflow = MemoryWorkflow()

        class Api:
            def request(self, *_args, **_kwargs):
                raise AgentNetworkHttpError(503, "TEMPORARY", "temporary")

        executor = ActionExecutor(Api(), workflow)
        failed = executor.execute({"operation": "get_my_agent", "input": {}})
        self.assertTrue(failed["retryable"])

        pending = executor.execute({"operation": "search_agents", "input": {}})
        self.assertEqual(pending["code"], "AGENT_NETWORK_ACTION_PENDING")
        self.assertEqual(workflow.value["operation"], "get_my_agent")

        abandoned = executor.execute({"operation": "abandon_action", "input": {}})
        self.assertEqual(abandoned["data"], {"abandoned": True})
        self.assertIsNone(workflow.value)

    def test_abandon_does_not_initialize_credentials(self):
        with tempfile.TemporaryDirectory() as state_dir:
            with patch(
                "agent_network_runtime.create_credential_store",
                side_effect=AssertionError("credentials should stay lazy"),
            ):
                executor = create_executor(state_dir=state_dir)
                result = executor.execute({"operation": "abandon_action", "input": {}})
        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["data"]["abandoned"])

    def test_abandon_does_not_parse_corrupt_workflow(self):
        class CorruptWorkflow:
            def read(self):
                raise ValueError("invalid JSON")

            def remove(self):
                return True

        executor = ActionExecutor(object(), CorruptWorkflow())
        result = executor.execute({"operation": "abandon_action", "input": {}})
        self.assertEqual(result["data"], {"abandoned": True})


if __name__ == "__main__":
    unittest.main()
