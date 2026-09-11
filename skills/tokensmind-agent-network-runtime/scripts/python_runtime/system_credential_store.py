import json
import os
import shutil
import subprocess

from .portable_store import RECORD_NAMES, _validate_record

SERVICE_NAME = "TokensMind Agent Network"
APPLICATION_NAME = "tokensmind-agent-network"
MACOS_SECURITY_PATH = "/usr/bin/security"
MACOS_ITEM_NOT_FOUND = 44


def _validate_record_name(name):
    if name not in RECORD_NAMES:
        raise ValueError("Unsupported portable state record: %s" % name)


def _parse_record(name, source):
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise ValueError(
            "System Agent Network %s credential is invalid JSON" % name,
        ) from error
    _validate_record(name, value)
    return value


def _command_failure(backend, operation, result):
    return RuntimeError(
        "%s %s failed with exit code %s" % (backend, operation, result.returncode),
    )


def run_credential_command(args, input_text=""):
    return subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


class MacOSCredentialStore:
    def __init__(self, namespace, runner=run_credential_command):
        self._namespace = namespace
        self._runner = runner

    def _account(self, name):
        _validate_record_name(name)
        return "%s:%s" % (self._namespace, name)

    def read(self, name):
        result = self._runner([
            MACOS_SECURITY_PATH, "find-generic-password",
            "-a", self._account(name), "-s", SERVICE_NAME, "-w",
        ])
        if result.returncode == MACOS_ITEM_NOT_FOUND:
            return None
        if result.returncode != 0:
            raise _command_failure("macOS Keychain", "read", result)
        return _parse_record(name, result.stdout.strip())

    def write(self, name, value):
        _validate_record(name, value)
        result = self._runner([
            MACOS_SECURITY_PATH, "add-generic-password",
            "-a", self._account(name), "-s", SERVICE_NAME, "-U", "-w",
        ], json.dumps(value, separators=(",", ":")) + "\n")
        if result.returncode != 0:
            raise _command_failure("macOS Keychain", "write", result)

    def remove(self, name):
        result = self._runner([
            MACOS_SECURITY_PATH, "delete-generic-password",
            "-a", self._account(name), "-s", SERVICE_NAME,
        ])
        if result.returncode not in (0, MACOS_ITEM_NOT_FOUND):
            raise _command_failure("macOS Keychain", "remove", result)


class LinuxSecretServiceStore:
    def __init__(self, namespace, command, runner=run_credential_command):
        self._namespace = namespace
        self._command = command
        self._runner = runner

    def _attributes(self, name):
        _validate_record_name(name)
        return [
            "application", APPLICATION_NAME,
            "origin", self._namespace,
            "record", name,
        ]

    def read(self, name):
        result = self._runner([self._command, "lookup"] + self._attributes(name))
        missing = (
            result.returncode == 1
            and not result.stdout.strip()
            and not result.stderr.strip()
        )
        if missing:
            return None
        if result.returncode != 0:
            raise _command_failure("Linux Secret Service", "read", result)
        return _parse_record(name, result.stdout.strip())

    def write(self, name, value):
        _validate_record(name, value)
        result = self._runner(
            [self._command, "store", "--label=%s" % SERVICE_NAME]
            + self._attributes(name),
            json.dumps(value, separators=(",", ":")) + "\n",
        )
        if result.returncode != 0:
            raise _command_failure("Linux Secret Service", "write", result)

    def remove(self, name):
        if self.read(name) is None:
            return
        result = self._runner([self._command, "clear"] + self._attributes(name))
        if result.returncode != 0:
            raise _command_failure("Linux Secret Service", "remove", result)


def resolve_system_credential_store(
        platform, namespace, env=None, *, runner=run_credential_command):
    if platform == "darwin":
        if not os.path.isfile(MACOS_SECURITY_PATH):
            return None
        if not os.access(MACOS_SECURITY_PATH, os.X_OK):
            return None
        return MacOSCredentialStore(namespace, runner)
    if platform == "linux":
        environment = os.environ if env is None else env
        command = shutil.which("secret-tool", path=environment.get("PATH"))
        if command:
            return LinuxSecretServiceStore(namespace, command, runner)
    return None
