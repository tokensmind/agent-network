import base64
import hashlib
import secrets
import uuid


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _random_credential(prefix):
    encoded = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")
    return prefix + encoded


def create_authorization_material(device_prefix, token_prefix):
    device_code = _random_credential(device_prefix)
    token = _random_credential(token_prefix)
    return {
        "authorizationId": str(uuid.uuid4()),
        "createIdempotencyKey": str(uuid.uuid4()),
        "exchangeIdempotencyKey": str(uuid.uuid4()),
        "deviceCode": device_code,
        "deviceCodeHash": sha256(device_code),
        "token": token,
        "tokenHash": sha256(token),
        "tokenPrefix": token[:20],
    }
