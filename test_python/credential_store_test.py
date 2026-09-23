import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = PACKAGE_DIR / "skills" / "tokensmind-agent-network" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from python_runtime.credential_store import create_credential_store
from python_runtime.portable_store import PortableStore
from python_runtime.system_credential_store import (
    MacOSCredentialStore,
    SystemCredentialStoreError,
)

ORIGIN = "https://tokensmind.ai"


class UnavailableSystemStore:
    backend = "macos-keychain"

    def verify_availability(self):
        raise SystemCredentialStoreError("keychain locked")

    def read(self, _name):
        return None

    def write(self, _name, _value):
        pass

    def remove(self, _name):
        pass


class CorruptSystemStore(UnavailableSystemStore):
    def verify_availability(self):
        pass

    def read(self, _name):
        raise SystemCredentialStoreError("stored record is corrupt")


class MacRunner:
    def __init__(self):
        self.records = {}
        self.calls = []

    def __call__(self, args, input_text=""):
        self.calls.append((args, input_text))
        account = args[args.index("-a") + 1]
        if args[1] == "add-generic-password":
            lines = input_text.rstrip("\n").split("\n")
            if len(lines) == 2 and lines[0] == lines[1]:
                self.records[account] = lines[0]
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if args[1] == "find-generic-password":
            if account in self.records:
                return SimpleNamespace(
                    returncode=0, stdout=self.records[account], stderr="",
                )
            return SimpleNamespace(returncode=44, stdout="", stderr="")
        self.records.pop(account, None)
        return SimpleNamespace(returncode=0, stdout="", stderr="")


class CredentialStoreTests(unittest.TestCase):
    def test_failure_migrates_legacy_state_to_file_fallback(self):
        with tempfile.TemporaryDirectory() as home_dir:
            legacy_dir = os.path.join(
                home_dir, "Library", "Application Support", "TokensMind", "AgentNetwork",
            )
            legacy = PortableStore(ORIGIN, "darwin", state_dir=legacy_dir)
            instance = {"id": str(uuid.uuid4())}
            legacy.write("instance", instance)
            events = []
            store = create_credential_store(
                ORIGIN,
                "darwin",
                home_dir=home_dir,
                secure_store=UnavailableSystemStore(),
                on_fallback=events.append,
            )

            self.assertEqual(store.read("instance"), instance)
            self.assertIsNone(legacy.read("instance"))
            namespace = next(
                (Path(home_dir) / ".tokensmind" / "agent-network").iterdir(),
            )
            with (namespace / "instance.json").open(encoding="utf-8") as source:
                self.assertEqual(json.load(source), instance)
            self.assertEqual(events[0]["backend"], "macos-keychain")
            self.assertEqual(events[0]["reason"], "keychain locked")

    def test_macos_write_uses_two_matching_inputs_and_verifies(self):
        runner = MacRunner()
        store = MacOSCredentialStore("namespace", runner)
        instance = {"id": str(uuid.uuid4())}

        store.write("instance", instance)

        self.assertEqual(store.read("instance"), instance)
        write = next(call for call in runner.calls if call[0][1] == "add-generic-password")
        lines = write[1].rstrip("\n").split("\n")
        self.assertEqual(lines, [lines[0], lines[0]])
        self.assertNotIn(instance["id"], " ".join(write[0]))

    def test_corrupt_system_records_select_file_fallback(self):
        with tempfile.TemporaryDirectory() as home_dir:
            events = []
            store = create_credential_store(
                ORIGIN,
                "darwin",
                home_dir=home_dir,
                secure_store=CorruptSystemStore(),
                on_fallback=events.append,
            )
            instance = {"id": str(uuid.uuid4())}

            self.assertIsNone(store.read("instance"))
            store.write("instance", instance)

            namespace = next(
                (Path(home_dir) / ".tokensmind" / "agent-network").iterdir(),
            )
            with (namespace / "instance.json").open(encoding="utf-8") as source:
                self.assertEqual(json.load(source), instance)
            self.assertEqual(events[0]["reason"], "stored record is corrupt")

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Keychain")
    def test_real_macos_keychain_round_trip(self):
        store = MacOSCredentialStore("test-%s" % uuid.uuid4())
        instance = {"id": str(uuid.uuid4())}
        self.addCleanup(store.remove, "instance")

        store.write("instance", instance)

        self.assertEqual(store.read("instance"), instance)
        store.remove("instance")

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Keychain")
    def test_real_macos_keychain_rejects_truncated_availability_probe(self):
        store = MacOSCredentialStore("test-%s" % uuid.uuid4())

        with self.assertRaises(SystemCredentialStoreError):
            store.verify_availability()


if __name__ == "__main__":
    unittest.main()
