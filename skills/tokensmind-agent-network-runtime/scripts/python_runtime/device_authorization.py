import time
from urllib.parse import quote, urlsplit

from .constants import AGENT_TOKEN_PREFIX, DEVICE_AUTHORIZATION_PATH, DEVICE_CODE_PREFIX
from .crypto import create_authorization_material
from .errors import AgentNetworkHttpError
from .portable_store import parse_datetime_millis

DEVICE_STATUSES = frozenset(("pending", "approved", "denied", "expired", "exchanged"))
CLIENT_FIELDS = ("name", "version", "deviceName", "platform")


def _headers(bearer=None, idempotency_key=None):
    result = {"Content-Type": "application/json"}
    if bearer:
        result["Authorization"] = "Bearer %s" % bearer
    if idempotency_key:
        result["Idempotency-Key"] = idempotency_key
    return result


def _assert_client_metadata(client):
    if not isinstance(client, dict):
        raise ValueError("Agent Network client metadata is incomplete")
    if any(not isinstance(client.get(field), str) or not client[field].strip()
           for field in CLIENT_FIELDS):
        raise ValueError("Agent Network client metadata is incomplete")


def _assert_create_identity(response, pending):
    if not isinstance(response, dict) or response.get("authorizationId") != pending["authorizationId"]:
        raise ValueError("Agent Network authorization response has a mismatched identifier")


def _assert_verification_url(response, pending, base_url):
    parsed = urlsplit(str(response.get("verificationUrl", "")))
    expected_path = "/console/agent-network/authorize/%s" % quote(pending["authorizationId"], safe="")
    origin = "%s://%s" % (parsed.scheme, parsed.netloc)
    if origin != base_url or parsed.path != expected_path or parsed.query or parsed.fragment:
        raise ValueError("Agent Network returned an invalid verification URL")


def _assert_authorization_timing(response):
    try:
        expires_at = parse_datetime_millis(response.get("expiresAt"))
    except ValueError as error:
        raise ValueError("Agent Network returned an invalid authorization expiry") from error
    if expires_at <= int(time.time() * 1000):
        raise ValueError("Agent Network returned an invalid authorization expiry")
    interval = response.get("intervalSeconds")
    if not isinstance(interval, int) or isinstance(interval, bool) or interval <= 0:
        raise ValueError("Agent Network returned an invalid polling interval")
    if not isinstance(response.get("userCode"), str) or not response["userCode"]:
        raise ValueError("Agent Network authorization response is missing its user code")


def _assert_create_response(response, pending, base_url):
    _assert_create_identity(response, pending)
    _assert_verification_url(response, pending, base_url)
    _assert_authorization_timing(response)


def _assert_status_response(status, pending):
    if not isinstance(status, dict):
        raise ValueError("Agent Network returned an invalid authorization status")
    if status.get("authorizationId") != pending["authorizationId"]:
        raise ValueError("Agent Network returned an invalid authorization status")
    if status.get("status") not in DEVICE_STATUSES:
        raise ValueError("Agent Network returned an invalid authorization status")
    actual = parse_datetime_millis(status.get("expiresAt"))
    expected = parse_datetime_millis(pending["authorization"]["expiresAt"])
    if actual != expected:
        raise ValueError("Agent Network authorization expiry changed unexpectedly")


def _exchange_credential(exchange, pending):
    if not isinstance(exchange, dict) or exchange.get("status") != "exchanged":
        raise ValueError("Agent Network credential exchange did not complete")
    if exchange.get("authorizationId") != pending["authorizationId"]:
        raise ValueError("Agent Network credential exchange has a mismatched identifier")
    credential = exchange.get("credential")
    if not isinstance(credential, dict):
        raise ValueError("Agent Network exchange response is missing credential metadata")
    return credential


def _assert_exchange(exchange, pending):
    credential = _exchange_credential(exchange, pending)
    if credential.get("tokenPrefix") != pending["tokenPrefix"]:
        raise ValueError("Agent Network credential prefix verification failed")
    agent = exchange.get("agent")
    agent_id = agent.get("id") if isinstance(agent, dict) else None
    if not credential.get("id") or credential.get("agentId") != agent_id:
        raise ValueError("Agent Network exchange response is missing credential metadata")
    forbidden = "apiToken" in exchange or "tokenHash" in credential or "apiToken" in credential
    if forbidden:
        raise ValueError("Agent Network exchange response exposed forbidden credential material")


def create_pending_authorization(operation, instance_id):
    pending = {"phase": "prepared", "operation": operation, "instanceId": instance_id}
    pending.update(create_authorization_material(DEVICE_CODE_PREFIX, AGENT_TOKEN_PREFIX))
    return pending


def create_remote_authorization(pending, base_url, http, *, client):
    _assert_client_metadata(client)
    client_metadata = dict(client)
    client_metadata["instanceId"] = pending["instanceId"]
    response = http.request(
        base_url + DEVICE_AUTHORIZATION_PATH,
        method="POST",
        headers=_headers(idempotency_key=pending["createIdempotencyKey"]),
        body={
            "authorizationId": pending["authorizationId"],
            "deviceCodeHash": pending["deviceCodeHash"],
            "client": client_metadata,
            "credential": {
                "tokenHash": pending["tokenHash"],
                "tokenPrefix": pending["tokenPrefix"],
            },
        },
    )
    _assert_create_response(response, pending, base_url)
    updated = dict(pending)
    updated.update({"phase": "authorizing", "authorization": response})
    return updated


def wait_for_approval(pending, base_url, http):
    expiry = parse_datetime_millis(pending["authorization"]["expiresAt"])
    interval = pending["authorization"]["intervalSeconds"]
    url = "%s%s/%s" % (base_url, DEVICE_AUTHORIZATION_PATH, pending["authorizationId"])
    while int(time.time() * 1000) < expiry:
        status = http.request(url, headers=_headers(bearer=pending["deviceCode"]))
        _assert_status_response(status, pending)
        if status["status"] in ("approved", "exchanged"):
            return status
        if status["status"] != "pending":
            denied = status["status"] == "denied"
            raise AgentNetworkHttpError(
                403 if denied else 410,
                "DEVICE_AUTHORIZATION_DENIED" if denied else "DEVICE_AUTHORIZATION_EXPIRED",
                "Agent Network authorization ended with status %s" % status["status"],
            )
        time.sleep(interval)
    raise AgentNetworkHttpError(
        410, "DEVICE_AUTHORIZATION_EXPIRED", "Agent Network authorization expired",
    )


def exchange_authorization(pending, base_url, http):
    url = "%s%s/%s/exchange" % (
        base_url, DEVICE_AUTHORIZATION_PATH, pending["authorizationId"],
    )
    exchange = http.request(
        url,
        method="POST",
        headers=_headers(
            bearer=pending["deviceCode"],
            idempotency_key=pending["exchangeIdempotencyKey"],
        ),
    )
    _assert_exchange(exchange, pending)
    return exchange
