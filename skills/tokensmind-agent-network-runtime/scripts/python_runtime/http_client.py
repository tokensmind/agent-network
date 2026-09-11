import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .errors import AgentNetworkHttpError

UNSET = object()


def _parse_response(source, status):
    if not source:
        return None
    try:
        return json.loads(source.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Agent Network returned non-JSON HTTP %s" % status) from error


def _unwrap_response(payload, status, successful, *, headers=None):
    if successful and isinstance(payload, dict):
        if payload.get("success") is True and "data" in payload:
            return payload["data"]
        raise ValueError("Agent Network returned an invalid success response envelope")
    if successful:
        raise ValueError("Agent Network returned an invalid success response envelope")
    code = payload.get("code") if isinstance(payload, dict) else None
    message = payload.get("message") if isinstance(payload, dict) else None
    raise AgentNetworkHttpError(status, code, message, response=payload, headers=headers)


class HttpClient:
    def __init__(self, opener=urlopen):
        self._opener = opener

    def request(self, url, method="GET", headers=None, *, body=UNSET):
        data = None
        if body is not UNSET:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = Request(url, data=data, headers=headers or {}, method=method)
        try:
            response = self._opener(request)
            with response:
                status = response.getcode()
                headers = {"retryAfter": response.headers.get("Retry-After")}
                payload = _parse_response(response.read(), status)
            return _unwrap_response(payload, status, 200 <= status < 300, headers=headers)
        except HTTPError as error:
            headers = {"retryAfter": error.headers.get("Retry-After")}
            payload = _parse_response(error.read(), error.code)
            return _unwrap_response(payload, error.code, False, headers=headers)
