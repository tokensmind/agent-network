import re

DEFAULT_BASE_URL = "https://tokensmind.ai"
DEVICE_AUTHORIZATION_PATH = "/agent-network-api/device-authorizations"
DEVICE_CODE_PREFIX = "tm_device_"
AGENT_TOKEN_PREFIX = "tm_agent_"
SUPPORTED_METHODS = frozenset(("GET", "POST", "PATCH", "DELETE"))
MUTATION_METHODS = frozenset(("POST", "PATCH", "DELETE"))
INTERNAL_PATH_PATTERNS = (
    re.compile(r"^/agent-network-api/device-authorizations(?:/|$)"),
    re.compile(r"^/agent-network-api/agents/[^/]+/credentials(?:/|$)"),
)
