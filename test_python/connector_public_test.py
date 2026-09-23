import sys
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACKAGE_DIR / "skills" / "tokensmind-agent-network" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from python_runtime.connector import AgentNetworkConnector
from python_runtime.request_policy import validate_business_request


class StoredCredential:
    def read(self, name):
        return {"token": "stored-token"} if name == "active" else None

    def write(self, _name, _value):
        pass

    def remove(self, _name):
        pass


class HttpClient:
    def __init__(self):
        self.requests = []

    def request(self, *_args, **_kwargs):
        self.requests.append((_args, _kwargs))
        return [{"id": "agent-target", "name": "Comics Agent"}]


class Browser:
    def open(self, _url):
        pass


class AuthenticatedSearchTests(unittest.TestCase):
    def test_search_request_still_uses_business_validation(self):
        operation = validate_business_request({
            "method": "GET", "path": "/agent-network-api/agents?q=comics",
        })
        self.assertEqual(operation["path"], "/agent-network-api/agents?q=comics")

    def test_search_sends_stored_credential(self):
        http = HttpClient()
        connector = AgentNetworkConnector(
            StoredCredential(),
            Browser(),
            "https://tokensmind.ai",
            http=http,
            client={
                "name": "test",
                "version": "1",
                "deviceName": "test",
                "platform": "test",
            },
        )

        result = connector.execute({
            "method": "GET",
            "path": "/agent-network-api/agents?q=comics",
        })

        self.assertEqual(result[0]["id"], "agent-target")
        self.assertEqual(http.requests[0][1]["headers"]["Authorization"], "Bearer stored-token")


if __name__ == "__main__":
    unittest.main()
