from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit

from .constants import INTERNAL_PATH_PATTERNS, MUTATION_METHODS, SUPPORTED_METHODS

PUBLIC_AGENT_DIRECTORY_PATH = "/agent-network-api/agents"


def normalize_base_url(value):
    parsed = urlsplit(str(value))
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Agent Network baseUrl must use http or https")
    if parsed.username or parsed.password:
        raise ValueError("Agent Network baseUrl must not contain credentials")
    host = parsed.hostname.lower()
    if ":" in host:
        host = "[%s]" % host
    port = parsed.port
    default_port = 80 if parsed.scheme == "http" else 443
    authority = host if port in (None, default_port) else "%s:%s" % (host, port)
    return urlunsplit((parsed.scheme.lower(), authority, "", "", ""))


def _is_internal_path(path):
    return any(pattern.search(path) for pattern in INTERNAL_PATH_PATTERNS)


def _validated_method(request):
    method = str(request.get("method", "undefined")).upper()
    if method not in SUPPORTED_METHODS:
        raise ValueError("Unsupported Agent Network method: %s" % method)
    return method


def _validated_path(request):
    path = request.get("path")
    if not isinstance(path, str) or not path.startswith("/agent-network-api/"):
        raise ValueError("Agent Network path must start with /agent-network-api/")
    if _is_internal_path(path):
        raise ValueError("This endpoint is not available through the ordinary-user connector")
    return path


def _validated_key(request, method):
    key = request.get("idempotencyKey")
    normalized_key = key.strip() if isinstance(key, str) else None
    if method in MUTATION_METHODS and not normalized_key:
        raise ValueError("Mutating Agent Network requests require a stable Idempotency-Key")
    return normalized_key


def _validate_reauthorize(request):
    reauthorize = request.get("reauthorize")
    if "reauthorize" in request and not isinstance(reauthorize, bool):
        raise ValueError("Agent Network reauthorize must be a boolean")


def validate_business_request(request):
    method = _validated_method(request)
    path = _validated_path(request)
    normalized_key = _validated_key(request, method)
    _validate_reauthorize(request)
    operation = {"method": method, "path": path}
    if normalized_key:
        operation["idempotencyKey"] = normalized_key
    return operation


def build_business_url(base_url, path):
    url = urljoin(base_url + "/", path)
    parsed = urlsplit(url)
    origin = normalize_base_url(url)
    if origin != base_url or not parsed.path.startswith("/agent-network-api/"):
        raise ValueError("Agent Network request must remain on the configured origin")
    if _is_internal_path(parsed.path):
        raise ValueError("This endpoint is not available through the ordinary-user connector")
    return url


def is_public_discovery_request(operation):
    if operation.get("method") != "GET":
        return False
    parsed = urlsplit(operation.get("path", ""))
    query = parse_qsl(parsed.query)
    mine_requested = any(key == "mine" and value == "1" for key, value in query)
    return parsed.path == PUBLIC_AGENT_DIRECTORY_PATH and not mine_requested
