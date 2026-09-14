import sys
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACKAGE_DIR / "skills" / "tokensmind-agent-network-runtime" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from python_runtime.connector import AgentNetworkConnector


class UnusedStore:
    def read(self, _name):
        raise AssertionError("credential store should remain unused")

    def write(self, _name, _value):
        raise AssertionError("credential store should remain unused")

    def remove(self, _name):
        raise AssertionError("credential store should remain unused")


class HttpClient:
    def request(self, *_args, **_kwargs):
        return [{"id": "agent-target", "name": "Comics Agent"}]


class Browser:
    def open(self, _url):
        pass


class PublicConnectorTests(unittest.TestCase):
    def test_public_discovery_does_not_initialize_credentials(self):
        connector = AgentNetworkConnector(
            UnusedStore(),
            Browser(),
            "https://tokensmind.ai",
            http=HttpClient(),
            client={
                "name": "test",
                "version": "1",
                "deviceName": "test",
                "platform": "test",
            },
        )

        result = connector.execute({
            "method": "GET",
            "path": "/agent-network-api/agents?q=comics&limit=20",
        })

        self.assertEqual(result[0]["id"], "agent-target")


if __name__ == "__main__":
    unittest.main()
