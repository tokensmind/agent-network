import json
import threading
import uuid

from .device_authorization import (
    create_pending_authorization,
    create_remote_authorization,
    exchange_authorization,
    wait_for_approval,
)
from .errors import AgentNetworkHttpError
from .http_client import UNSET
from .request_policy import (
    build_business_url,
    is_public_discovery_request,
    validate_business_request,
)
from action_support import AuthorizationRequired

INVALID_CREDENTIAL_CODES = frozenset((
    "AGENT_CREDENTIAL_EXPIRED",
    "AGENT_CREDENTIAL_INVALID",
    "AGENT_CREDENTIAL_REVOKED",
))
TERMINAL_AUTHORIZATION_CODES = frozenset((
    "DEVICE_AUTHORIZATION_DENIED",
    "DEVICE_AUTHORIZATION_EXCHANGED",
    "DEVICE_AUTHORIZATION_EXPIRED",
))


def _operations_match(left, right):
    options = {"sort_keys": True, "separators": (",", ":"), "ensure_ascii": False}
    return json.dumps(left, **options) == json.dumps(right, **options)


def _is_http_error(error, codes):
    return isinstance(error, AgentNetworkHttpError) and error.code in codes


class AgentNetworkConnector:
    def __init__(self, store, browser, base_url, *, http, client):
        self._store = store
        self._browser = browser
        self._base_url = base_url
        self._http = http
        self._client = client
        self._lock = threading.Lock()

    def execute(self, params):
        with self._lock:
            return self._execute_once(params)

    def _execute_once(self, params):
        operation = validate_business_request(params)
        if "body" in params:
            operation["body"] = params["body"]
        reauthorize = params.get("reauthorize") is True
        pending = self._store.read("pending")
        active = self._store.read("active")
        if pending:
            return self._resume_pending(pending, active, operation)
        if is_public_discovery_request(operation) and not reauthorize:
            return self._execute_business_request(operation)
        if not active or reauthorize:
            active = self._authorize(operation)
            return self._execute_and_finalize(self._store.read("pending"), active)
        try:
            return self._execute_business_request(operation, active["token"])
        except AgentNetworkHttpError as error:
            if error.code not in INVALID_CREDENTIAL_CODES:
                raise
            self._store.remove("active")
            active = self._authorize(operation)
            return self._execute_and_finalize(self._store.read("pending"), active)

    def _resume_pending(self, pending, active, operation):
        if not _operations_match(pending["operation"], operation):
            raise ValueError(
                "A different Agent Network operation is pending; retry the original operation first",
            )
        active = self._authorize(pending["operation"])
        return self._execute_and_finalize(self._store.read("pending"), active)

    def _prepare_pending(self, operation):
        existing = self._store.read("pending")
        if existing:
            return existing
        instance = self._store.read("instance")
        if not instance:
            instance = {"id": str(uuid.uuid4())}
            self._store.write("instance", instance)
        pending = create_pending_authorization(operation, instance["id"])
        self._store.write("pending", pending)
        return pending

    def _authorize(self, operation):
        try:
            pending = self._prepare_pending(operation)
            if pending["phase"] == "prepared":
                pending = create_remote_authorization(
                    pending, self._base_url, self._http, client=self._client,
                )
                self._store.write("pending", pending)
                self._browser.open(pending["authorization"]["verificationUrl"])
                raise AuthorizationRequired(pending["authorization"]["verificationUrl"])
            if pending["phase"] == "authorizing":
                return self._complete_authorization(pending)
            return self._store.read("active")
        except AgentNetworkHttpError as error:
            if error.code in TERMINAL_AUTHORIZATION_CODES:
                self._store.remove("pending")
            raise

    def _complete_authorization(self, pending):
        wait_for_approval(pending, self._base_url, self._http)
        exchange = exchange_authorization(pending, self._base_url, self._http)
        active = {
            "token": pending["token"],
            "agentId": (exchange.get("agent") or {}).get("id"),
            "credentialId": exchange["credential"]["id"],
            "tokenPrefix": exchange["credential"]["tokenPrefix"],
        }
        self._store.write("active", active)
        updated = dict(pending)
        updated["phase"] = "authorized"
        self._store.write("pending", updated)
        return active

    def _execute_business_request(self, operation, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer %s" % token
        if operation.get("idempotencyKey"):
            headers["Idempotency-Key"] = operation["idempotencyKey"]
        body = operation["body"] if "body" in operation else UNSET
        return self._http.request(
            build_business_url(self._base_url, operation["path"]),
            method=operation["method"],
            headers=headers,
            body=body,
        )

    def _execute_and_finalize(self, pending, active):
        if not active or not active.get("token"):
            raise ValueError("Authorized Agent Network operation has no active stored credential")
        try:
            result = self._execute_business_request(pending["operation"], active["token"])
            self._store.remove("pending")
            return result
        except AgentNetworkHttpError as error:
            if error.status < 500 and error.status != 429:
                self._store.remove("pending")
                if error.code in INVALID_CREDENTIAL_CODES:
                    self._store.remove("active")
            raise
