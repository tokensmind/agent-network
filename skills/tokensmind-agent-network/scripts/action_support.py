import json
import os
import tempfile
from pathlib import Path

from python_runtime.portable_store import _origin_namespace, resolve_portable_state_dir


class ActionState(Exception):
    def __init__(self, status, message, **data):
        super().__init__(message)
        self.status = status
        self.data = {"message": message, **data}


class AuthorizationRequired(Exception):
    def __init__(self, url):
        super().__init__(
            "Default browser handoff failed; resume the pending action to continue polling.",
        )
        self.status = "authorization_required"
        self.url = url


class LazyStore:
    def __init__(self, factory):
        self._factory = factory
        self._store = None

    def _get(self):
        if self._store is None:
            self._store = self._factory()
        return self._store

    def read(self, name):
        return self._get().read(name)

    def write(self, name, value):
        return self._get().write(name, value)

    def remove(self, name):
        return self._get().remove(name)


class WorkflowStore:
    def __init__(self, origin, platform, state_dir=None, *, home_dir=None):
        base = state_dir or resolve_portable_state_dir(platform, home_dir=home_dir)
        self._path = Path(os.path.abspath(str(base))) / _origin_namespace(origin) / "workflow.json"

    def read(self):
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except json.JSONDecodeError as error:
            raise ValueError("Workflow state is invalid JSON") from error

    def write(self, value):
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self._path.parent, 0o700)
        descriptor, temporary = tempfile.mkstemp(prefix=".workflow.", suffix=".tmp", dir=self._path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as target:
                json.dump(value, target, separators=(",", ":"))
                target.flush()
                os.fsync(target.fileno())
            try:
                os.link(temporary, self._path)
            except FileExistsError:
                pass
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def remove(self):
        try:
            self._path.unlink()
            return True
        except FileNotFoundError:
            return False


class ReportingBrowser:
    def __init__(self, browser, writer):
        self._browser = browser
        self._writer = writer

    def open(self, url):
        try:
            self._browser.open(url)
            self._writer({"event": "authorization_opened", "verificationUrl": url})
        except Exception as error:
            self._writer({"event": "authorization_required", "verificationUrl": url})
            raise AuthorizationRequired(url) from error


class ActionApi:
    def __init__(self, connector):
        self._connector = connector

    def request(self, method, path, body=None, *, key=None):
        request = {"method": method, "path": path}
        if body is not None:
            request["body"] = body
        if method in {"POST", "PATCH", "DELETE"}:
            request["idempotencyKey"] = key
        return self._connector.execute(request)
