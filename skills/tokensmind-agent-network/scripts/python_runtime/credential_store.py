import os
from pathlib import Path

from .portable_store import (
    PortableStore,
    RECORD_NAMES,
    _origin_namespace,
    resolve_portable_state_dir,
)
from .system_credential_store import (
    SystemCredentialStoreError,
    resolve_system_credential_store,
)

AUTO_SECURE_STORE = object()


def resolve_legacy_state_dirs(platform, env=None, home_dir=None):
    environment = os.environ if env is None else env
    home = str(Path.home() if home_dir is None else home_dir).strip()
    if not home:
        raise ValueError("Unable to resolve the current user home directory")
    if platform == "darwin":
        return [os.path.join(
            home, "Library", "Application Support", "TokensMind", "AgentNetwork",
        )]
    if platform == "win32":
        local_app_data = str(environment.get("LOCALAPPDATA", "")).strip()
        if not local_app_data:
            return []
        import ntpath
        return [ntpath.join(local_app_data, "TokensMind", "AgentNetwork")]
    if platform != "linux":
        return []
    default_dir = os.path.join(home, ".local", "state", "tokensmind", "agent-network")
    xdg_state_home = str(environment.get("XDG_STATE_HOME", "")).strip()
    directories = (
        [os.path.join(xdg_state_home, "tokensmind", "agent-network"), default_dir]
        if xdg_state_home else [default_dir]
    )
    return list(dict.fromkeys(directories))


def _collect_source_records(sources):
    candidates = {}
    for source in sources:
        for name in RECORD_NAMES:
            value = source.read(name)
            if value is None:
                continue
            if name in candidates and candidates[name]["value"] != value:
                raise ValueError(
                    "Conflicting Agent Network %s records exist in known local stores" % name,
                )
            candidate = candidates.setdefault(name, {"value": value, "sources": []})
            candidate["sources"].append(source)
    return candidates


def _validate_migration_target(target, candidates):
    missing = []
    for name, candidate in candidates.items():
        current = target.read(name)
        if current is None:
            missing.append((name, candidate["value"]))
        elif current != candidate["value"]:
            raise ValueError(
                "Stored Agent Network %s conflicts with a known legacy record" % name,
            )
    return missing


def migrate_credential_stores(target, sources):
    candidates = _collect_source_records(sources)
    if not candidates:
        return
    for name, value in _validate_migration_target(target, candidates):
        target.write(name, value)
    for name, candidate in candidates.items():
        if target.read(name) != candidate["value"]:
            raise RuntimeError("Agent Network %s migration could not be verified" % name)
    for name, candidate in candidates.items():
        for source in candidate["sources"]:
            source.remove(name)


def _file_stores(options):
    return [
        PortableStore(
            origin=options["origin"],
            platform=options["platform"],
            state_dir=directory,
            env=options["env"],
            home_dir=options["home_dir"],
        )
        for directory in options["directories"]
    ]


def _validate_system_records(system_store):
    for name in RECORD_NAMES:
        system_store.read(name)


def _initialize_store(
        system_store, fallback, fallback_dir, legacy_dirs, options, on_fallback):
    record_dir = os.path.join(fallback_dir, _origin_namespace(options["origin"]))
    legacy_sources = _file_stores({**options, "directories": legacy_dirs})
    if system_store is None:
        on_fallback({
            "backend": None,
            "directory": record_dir,
            "reason": "No supported system credential store is available",
        })
        migrate_credential_stores(fallback, legacy_sources)
        return fallback
    try:
        if not hasattr(system_store, "verify_availability"):
            raise SystemCredentialStoreError(
                "System credential store does not support availability verification",
            )
        system_store.verify_availability()
        _validate_system_records(system_store)
        sources = _file_stores({
            **options, "directories": [fallback_dir] + legacy_dirs,
        })
        migrate_credential_stores(system_store, sources)
        return system_store
    except SystemCredentialStoreError as error:
        on_fallback({
            "backend": system_store.backend,
            "directory": record_dir,
            "reason": str(error),
        })
        migrate_credential_stores(fallback, legacy_sources)
        return fallback


def create_credential_store(
        origin, platform, *, state_dir=None, env=None, home_dir=None,
        secure_store=AUTO_SECURE_STORE,
        secure_store_resolver=resolve_system_credential_store,
        command_runner=None, on_fallback=None):
    environment = os.environ if env is None else env
    if state_dir:
        return PortableStore(
            origin, platform, state_dir, env=environment, home_dir=home_dir,
        )
    fallback_dir = resolve_portable_state_dir(platform, environment, home_dir)
    fallback = PortableStore(
        origin, platform, fallback_dir, env=environment, home_dir=home_dir,
    )
    if secure_store is AUTO_SECURE_STORE:
        resolver_options = {
            "platform": platform,
            "namespace": _origin_namespace(origin),
            "env": environment,
        }
        if command_runner is not None:
            resolver_options["runner"] = command_runner
        system_store = secure_store_resolver(**resolver_options)
    else:
        system_store = secure_store
    legacy_dirs = list(dict.fromkeys(
        resolve_legacy_state_dirs(platform, environment, home_dir),
    ))
    return _initialize_store(
        system_store,
        fallback,
        fallback_dir,
        legacy_dirs,
        {
        "origin": origin,
        "platform": platform,
        "env": environment,
        "home_dir": home_dir,
        },
        on_fallback or (lambda _event: None),
    )
