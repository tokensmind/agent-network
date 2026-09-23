import json
import os
import re
import tempfile
from datetime import datetime
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

DIRECTORY_MODE = 0o700
FILE_MODE = 0o600
RECORD_NAMES = frozenset(("active", "pending", "instance"))
PENDING_PHASES = frozenset(("prepared", "authorizing", "authorized"))
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
DEVICE_CODE_PATTERN = re.compile(r"^tm_device_[A-Za-z0-9_-]{43}$")
AGENT_TOKEN_PATTERN = re.compile(r"^tm_agent_[A-Za-z0-9_-]{43}$")


def _require_home_directory(home_dir):
    value = str(home_dir or "").strip()
    if not value:
        raise ValueError("Unable to resolve the current user home directory")
    return value


def resolve_portable_state_dir(platform, env=None, home_dir=None):
    home_dir = Path.home() if home_dir is None else home_dir
    if platform == "win32":
        import ntpath
        return ntpath.join(_require_home_directory(home_dir), ".tokensmind", "agent-network")
    return os.path.join(_require_home_directory(home_dir), ".tokensmind", "agent-network")


def _is_non_empty_string(value):
    return isinstance(value, str) and bool(value)


def _is_operation(value):
    return (
        isinstance(value, dict)
        and value.get("method") in ("GET", "POST", "PATCH", "DELETE")
        and _is_non_empty_string(value.get("path"))
    )


def _is_instance(value):
    return isinstance(value, dict) and bool(UUID_PATTERN.match(str(value.get("id", ""))))


def _is_active(value):
    if not isinstance(value, dict):
        return False
    token = value.get("token", "")
    prefix = value.get("tokenPrefix", "")
    return (
        bool(AGENT_TOKEN_PATTERN.match(token))
        and (value.get("agentId") is None or _is_non_empty_string(value.get("agentId")))
        and _is_non_empty_string(value.get("credentialId"))
        and _is_non_empty_string(prefix)
        and token.startswith(prefix)
    )


def _has_pending_secrets(value):
    token = value.get("token", "")
    prefix = value.get("tokenPrefix", "")
    return (
        bool(UUID_PATTERN.match(str(value.get("authorizationId", ""))))
        and bool(UUID_PATTERN.match(str(value.get("instanceId", ""))))
        and bool(UUID_PATTERN.match(str(value.get("createIdempotencyKey", ""))))
        and bool(UUID_PATTERN.match(str(value.get("exchangeIdempotencyKey", ""))))
        and bool(DEVICE_CODE_PATTERN.match(value.get("deviceCode", "")))
        and bool(SHA256_PATTERN.match(value.get("deviceCodeHash", "")))
        and bool(AGENT_TOKEN_PATTERN.match(token))
        and bool(SHA256_PATTERN.match(value.get("tokenHash", "")))
        and _is_non_empty_string(prefix)
        and token.startswith(prefix)
    )


def parse_datetime_millis(value):
    if not isinstance(value, str):
        raise ValueError("Invalid Agent Network timestamp")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except ValueError as error:
        raise ValueError("Invalid Agent Network timestamp") from error


def _has_authorization(value):
    authorization = value.get("authorization")
    if not isinstance(authorization, dict):
        return False
    interval = authorization.get("intervalSeconds")
    try:
        parse_datetime_millis(authorization.get("expiresAt"))
    except ValueError:
        return False
    return (
        authorization.get("authorizationId") == value.get("authorizationId")
        and _is_non_empty_string(authorization.get("verificationUrl"))
        and isinstance(interval, int) and not isinstance(interval, bool) and interval > 0
    )


def _is_pending(value):
    if not isinstance(value, dict) or value.get("phase") not in PENDING_PHASES:
        return False
    if not _is_operation(value.get("operation")) or not _has_pending_secrets(value):
        return False
    return value["phase"] == "prepared" or _has_authorization(value)


def _validate_record(name, value):
    valid = _is_active(value) if name == "active" else _is_pending(value)
    if name == "instance":
        valid = _is_instance(value)
    if not valid:
        raise ValueError("Portable Agent Network %s state has an invalid structure" % name)


def _validate_record_name(name):
    if name not in RECORD_NAMES:
        raise ValueError("Unsupported portable state record: %s" % name)


def _origin_namespace(origin):
    parsed = urlsplit(origin)
    normalized = "%s://%s" % (parsed.scheme, parsed.netloc)
    if parsed.scheme not in ("http", "https") or normalized != origin:
        raise ValueError("Portable Agent Network store requires a normalized HTTP origin")
    return sha256(origin.encode("utf-8")).hexdigest()


class PortableStore:
    def __init__(self, origin, platform, state_dir=None, *, env=None, home_dir=None):
        base = state_dir or resolve_portable_state_dir(platform, env, home_dir)
        self._directory = os.path.join(os.path.abspath(str(base)), _origin_namespace(origin))
        self._platform = platform

    def _record_path(self, name):
        return os.path.join(self._directory, "%s.json" % name)

    def read(self, name):
        _validate_record_name(name)
        try:
            with open(self._record_path(name), "r", encoding="utf-8") as source:
                value = json.load(source)
        except FileNotFoundError:
            return None
        except json.JSONDecodeError as error:
            raise ValueError("Portable Agent Network %s state is invalid JSON" % name) from error
        _validate_record(name, value)
        return value

    def write(self, name, value):
        _validate_record_name(name)
        _validate_record(name, value)
        os.makedirs(self._directory, mode=DIRECTORY_MODE, exist_ok=True)
        if self._platform != "win32":
            os.chmod(self._directory, DIRECTORY_MODE)
        temporary = self._write_temporary(name, value)
        try:
            os.replace(temporary, self._record_path(name))
            if self._platform != "win32":
                os.chmod(self._record_path(name), FILE_MODE)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _write_temporary(self, name, value):
        descriptor, temporary = tempfile.mkstemp(
            prefix=".%s.%s." % (name, os.getpid()), suffix=".tmp", dir=self._directory,
        )
        try:
            if self._platform != "win32":
                os.fchmod(descriptor, FILE_MODE)
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(value, target, separators=(",", ":"))
                target.flush()
                os.fsync(target.fileno())
            return temporary
        except Exception:
            if os.path.exists(temporary):
                os.unlink(temporary)
            raise

    def remove(self, name):
        _validate_record_name(name)
        try:
            os.unlink(self._record_path(name))
        except FileNotFoundError:
            return
