import importlib
import os


def _force_pure_python_protobuf() -> None:
    # Python 3.14 currently crashes importing protobuf C extensions.
    # Force the pure-Python fallback by blocking those modules.
    os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

    original_import_module = importlib.import_module

    def patched_import_module(name, package=None):
        if name in ("google._upb._message", "google.protobuf.pyext._message"):
            raise ImportError(f"{name} disabled for pure-Python protobuf")
        return original_import_module(name, package)

    importlib.import_module = patched_import_module


if os.environ.get("PROTOBUF_FORCE_PYTHON", "1") == "1":
    _force_pure_python_protobuf()


def _patch_nyctrains_resources() -> None:
    # Point nyctrains to the local GTFS resources we already have.
    # Use environment variable or fallback to /app/backend/gtfs
    local_resources = os.environ.get("NYCTRAINS_RESOURCE_DIR", "/app/backend/gtfs")
    
    print(f"[sitecustomize] Attempting to patch nyctrains RESOURCE_DIR to: {local_resources}")
    
    if not os.path.exists(local_resources):
        print(f"[sitecustomize] WARNING: Resource directory not found: {local_resources}")
        return

    try:
        import nyctrains.data_loader as data_loader
        import nyctrains.static_gtfs as static_gtfs
        
        data_loader.RESOURCE_DIR = local_resources
        static_gtfs.RESOURCE_DIR = local_resources
        print(f"[sitecustomize] SUCCESS: Patched nyctrains to use {local_resources}")
    except Exception as e:
        print(f"[sitecustomize] ERROR: Failed to patch nyctrains: {e}")
        return


_patch_nyctrains_resources()
