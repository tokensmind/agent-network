import json
import os
import shutil
import subprocess
import uuid

from .portable_store import RECORD_NAMES, _validate_record

SERVICE_NAME = "TokensMind Agent Network"
APPLICATION_NAME = "tokensmind-agent-network"
MACOS_SECURITY_PATH = "/usr/bin/security"
MACOS_ITEM_NOT_FOUND = 44
SYSTEM_STORE_PROBE_LENGTH = 1024


class SystemCredentialStoreError(RuntimeError):
    code = "SYSTEM_CREDENTIAL_STORE_UNAVAILABLE"


def _validate_record_name(name):
    if name not in RECORD_NAMES:
        raise ValueError("Unsupported portable state record: %s" % name)


def _parse_record(name, source):
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise SystemCredentialStoreError(
            "System Agent Network %s credential is invalid JSON" % name,
        ) from error
    try:
        _validate_record(name, value)
    except ValueError as error:
        raise SystemCredentialStoreError(
            "System Agent Network %s credential has an invalid structure" % name,
        ) from error
    return value


def _command_failure(backend, operation, result):
    return SystemCredentialStoreError(
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


def _run(runner, args, input_text, backend, operation):
    try:
        return runner(args, input_text)
    except OSError as error:
        raise SystemCredentialStoreError(
            "%s %s failed" % (backend, operation),
        ) from error


def _verify_round_trip(write, read, remove, expected):
    failure = None
    try:
        write(expected)
        if read() != expected:
            failure = SystemCredentialStoreError(
                "System credential store round-trip failed",
            )
    except SystemCredentialStoreError as error:
        failure = error
    try:
        remove()
    except SystemCredentialStoreError as error:
        if failure is None:
            failure = error
    if failure is not None:
        raise failure


def _probe_value():
    return str(uuid.uuid4()).ljust(SYSTEM_STORE_PROBE_LENGTH, "x")


class MacOSCredentialStore:
    def __init__(self, namespace, runner=run_credential_command):
        self._namespace = namespace
        self._runner = runner

    def _account(self, name):
        _validate_record_name(name)
        return "%s:%s" % (self._namespace, name)

    def _read_source(self, account):
        result = _run(self._runner, [
            MACOS_SECURITY_PATH, "find-generic-password",
            "-a", account, "-s", SERVICE_NAME, "-w",
        ], "", "macOS Keychain", "read")
        if result.returncode == MACOS_ITEM_NOT_FOUND:
            return None
        if result.returncode != 0:
            raise _command_failure("macOS Keychain", "read", result)
        return result.stdout.strip()

    def _write_source(self, account, source):
        result = _run(self._runner, [
            MACOS_SECURITY_PATH, "add-generic-password",
            "-a", account, "-s", SERVICE_NAME, "-U", "-w",
        ], "%s\n%s\n" % (source, source), "macOS Keychain", "write")
        if result.returncode != 0:
            raise _command_failure("macOS Keychain", "write", result)

    def _remove_account(self, account):
        result = _run(self._runner, [
            MACOS_SECURITY_PATH, "delete-generic-password",
            "-a", account, "-s", SERVICE_NAME,
        ], "", "macOS Keychain", "remove")
        if result.returncode not in (0, MACOS_ITEM_NOT_FOUND):
            raise _command_failure("macOS Keychain", "remove", result)

    def read(self, name):
        source = self._read_source(self._account(name))
        return None if source is None else _parse_record(name, source)

    def write(self, name, value):
        _validate_record(name, value)
        self._write_source(
            self._account(name), json.dumps(value, separators=(",", ":")),
        )
        if self.read(name) != value:
            raise SystemCredentialStoreError(
                "macOS Keychain %s write verification failed" % name,
            )

    def remove(self, name):
        self._remove_account(self._account(name))

    def verify_availability(self):
        account = "%s:probe:%s" % (self._namespace, uuid.uuid4())
        expected = _probe_value()
        _verify_round_trip(
            lambda source: self._write_source(account, source),
            lambda: self._read_source(account),
            lambda: self._remove_account(account),
            expected,
        )

    backend = "macos-keychain"


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

    def _lookup_source(self, attributes):
        result = _run(
            self._runner, [self._command, "lookup"] + attributes,
            "", "Linux Secret Service", "read",
        )
        missing = (
            result.returncode == 1
            and not result.stdout.strip()
            and not result.stderr.strip()
        )
        if missing:
            return None
        if result.returncode != 0:
            raise _command_failure("Linux Secret Service", "read", result)
        return result.stdout.strip()

    def _write_source(self, attributes, source):
        result = _run(self._runner, [
            self._command, "store", "--label=%s" % SERVICE_NAME,
        ] + attributes, source + "\n", "Linux Secret Service", "write")
        if result.returncode != 0:
            raise _command_failure("Linux Secret Service", "write", result)

    def _remove_attributes(self, attributes):
        if self._lookup_source(attributes) is None:
            return
        result = _run(
            self._runner, [self._command, "clear"] + attributes,
            "", "Linux Secret Service", "remove",
        )
        if result.returncode != 0:
            raise _command_failure("Linux Secret Service", "remove", result)

    def read(self, name):
        source = self._lookup_source(self._attributes(name))
        return None if source is None else _parse_record(name, source)

    def write(self, name, value):
        _validate_record(name, value)
        self._write_source(
            self._attributes(name), json.dumps(value, separators=(",", ":")),
        )
        if self.read(name) != value:
            raise SystemCredentialStoreError(
                "Linux Secret Service %s write verification failed" % name,
            )

    def remove(self, name):
        self._remove_attributes(self._attributes(name))

    def verify_availability(self):
        attributes = [
            "application", APPLICATION_NAME,
            "origin", self._namespace,
            "record", "probe-%s" % uuid.uuid4(),
        ]
        expected = _probe_value()
        _verify_round_trip(
            lambda source: self._write_source(attributes, source),
            lambda: self._lookup_source(attributes),
            lambda: self._remove_attributes(attributes),
            expected,
        )

    backend = "linux-secret-service"


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
