# NNModelling — DSL for designing neural networks via visual node editor
# Copyright (C) 2026  Luca Sforza
#
# Licensed under the GNU General Public License v3 or later.
# Commercial licenses are available — contact Luca Sforza.
# See the LICENSE file for details.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
import os
import shutil
from pathlib import Path

import pytest

from tests.backend_helpers import get_test_valkey_url, valkey_required


# Gate markers that place a test in an explicit mandatory suite. Anything
# without one of these is implicitly part of the fast gate.
GATE_MARKERS = {"service", "e2e"}


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config, items):
    """Auto-apply the ``fast`` marker to every test without an explicit gate.

    This keeps ``-m fast`` a deterministic, explicit selection of the intended
    fast suite while guaranteeing a test can never land in both the fast gate
    and a mandatory service/e2e gate at the same time.
    """
    del config
    for item in items:
        if GATE_MARKERS.isdisjoint(marker.name for marker in item.iter_markers()):
            item.add_marker(pytest.mark.fast)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Flag the item when its call phase failed (used by artifact retention)."""
    outcome = yield
    if call.when == "call" and outcome.get_result().failed:
        item._nnm_failed = True


@pytest.fixture()
def retain_e2e_artifacts_on_failure(request, tmp_path):
    """Copy E2E job artifacts/logs to a caller-specified directory on failure.

    Opt-in contract for CI failure diagnostics: when ``NNM_E2E_ARTIFACT_DIR``
    is set and the test fails, the test's temporary directory (job artifacts,
    resolved configs, safetensors, wheels, stdout/stderr logs) is copied to
    ``<NNM_E2E_ARTIFACT_DIR>/<test-name>/``. When the variable is unset the
    fixture is a no-op, so local runs stay isolated, and successful runs never
    copy anything. Tokens and admin credentials never reach the test temporary
    directory (they live only in Valkey), so nothing sensitive is ever copied.
    """
    yield
    target_root = os.getenv("NNM_E2E_ARTIFACT_DIR")
    if not target_root or not getattr(request.node, "_nnm_failed", False):
        return

    def _ignore(directory, names):
        del directory
        return [name for name in names if name == "venv" or name == "__pycache__"]

    target = Path(target_root) / request.node.name
    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(tmp_path, target, dirs_exist_ok=True, ignore=_ignore)


@pytest.fixture(scope="session")
def valkey_client():
    """Connect to a real Valkey for service and E2E tests.

    The fixture is instantiated only when a test requests it, so fast runs
    never contact Valkey. When Valkey is not reachable the tests are skipped,
    except in required mode (``NNM_REQUIRE_VALKEY=1``) in which the suite
    fails instead so CI cannot silently drop service coverage.
    """
    import valkey

    url = get_test_valkey_url()
    client = valkey.from_url(url, decode_responses=True)
    try:
        client.ping()
    except Exception as exc:  # noqa: BLE001 - any connection error is fatal here
        if valkey_required():
            pytest.fail(f"required Valkey service is not reachable at {url}: {exc}")
        pytest.skip(f"Valkey is not reachable at {url}: {exc}")
    try:
        client.flushdb()
        yield client
    finally:
        try:
            client.flushdb()
            client.close()
        except Exception:  # noqa: BLE001 - teardown must never mask test results
            pass


@pytest.fixture()
def clean_valkey(valkey_client):
    """Flush the dedicated test database before and after each test."""
    valkey_client.flushdb()
    yield valkey_client
    valkey_client.flushdb()
