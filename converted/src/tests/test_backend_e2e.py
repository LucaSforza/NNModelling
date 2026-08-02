"""End-to-end backend job tests through the real production path.

One serialized path is exercised without faking the job store, the executor,
the wheel exporter, or the downloaded wheel::

    POST /jobs (authenticated)
      -> ValkeyJobStore
      -> scheduler claim
      -> LocalExecutor
      -> main.py on a tiny deterministic MNIST-shaped dataset
      -> weights.safetensors
      -> build_model_wheel
      -> GET /jobs/{id}/package
      -> sha256 verification against the manifest
      -> pip install of the DOWNLOADED wheel into an isolated venv
      -> load_model().predict() from the installed package only

Covered models: the repository's MNIST classifier (``mninst``) and the
autoencoder (``autoencoder_mnist``). External W&B is disabled, never stubbed.
On failure, job artifacts and logs can be retained for CI diagnostics by
setting ``NNM_E2E_ARTIFACT_DIR`` (see ``retain_e2e_artifacts_on_failure``).

Run with::

    cd converted && uv run pytest src/tests/ -m e2e -q
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest
import torch
from omegaconf import OmegaConf
from safetensors.torch import load_file

from backend.app import create_app
from backend.auth import AuthService, ValkeyAuthStore
from backend.executors import LocalExecutor
from backend.manager import JobManager
from backend.models import JobStatus
from backend.project_env import project_python
from backend.projects import ProjectManager
from backend.store import ValkeyJobStore
from model_package.runtime import GraphNet
from tests.backend_helpers import (
    CONVERTED_DIR,
    autoencoder_submission,
    broken_submission,
    classification_submission,
    deterministic_input,
    get_test_valkey_url,
    install_and_predict,
    wait_for_package,
    wait_for_terminal,
)


pytestmark = pytest.mark.e2e

ADMIN_TOKEN = "e2e-admin-secret"
OWNER = "e2e-browser"


@pytest.fixture()
def backend(tmp_path, clean_valkey):
    """A fully real backend: Valkey stores, JobManager, and LocalExecutor."""
    manager = JobManager(
        ValkeyJobStore(get_test_valkey_url()),
        tmp_path / "jobs",
        [LocalExecutor(CONVERTED_DIR)],
        poll_interval=0.1,
    )
    auth = AuthService(ValkeyAuthStore(get_test_valkey_url()))
    app = create_app(manager, auth_service=auth, admin_token=ADMIN_TOKEN)
    yield app, manager, auth


async def _submit_authenticated(
    client: httpx.AsyncClient,
    auth: AuthService,
    submission: Any,
) -> tuple[str, str, dict[str, str]]:
    """Pair a browser, approve it through the admin API, and submit the job.

    Returns the job id, the owning connection id, and the bearer headers.
    """
    pairing = auth.create_pairing(OWNER, client_host="127.0.0.1")
    approve = await client.post(
        f"/admin/pairing/requests/{pairing.request_id}/approve",
        headers={"x-nnm-admin-token": ADMIN_TOKEN},
        json={"ttl": "24h"},
    )
    assert approve.status_code == 200, approve.text
    headers = {"authorization": f"Bearer {pairing.token}"}
    response = await client.post(
        "/jobs",
        headers=headers,
        json=submission.model_dump(mode="json"),
    )
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "queued"
    return response.json()["id"], pairing.connection_id, headers


def _assert_event_chain(manager: JobManager, job_id: str, owner: str) -> None:
    """Assert queued < running < package_ready < succeeded appear in order."""
    events = manager.events(job_id, owner_connection_id=owner)
    types = [event["type"] for event in events]
    for expected in ("queued", "running", "package_ready", "succeeded"):
        assert expected in types, f"missing {expected!r} event in {types}"
    indices = [types.index("queued"), types.index("running"), types.index("package_ready"), types.index("succeeded")]
    assert indices == sorted(indices), f"events out of order: {types}"
    assert types[-1] == "succeeded"


def _run_real_job(
    app,
    manager: JobManager,
    auth: AuthService,
    submission: Any,
    work_dir: Path,
    *,
    expected_output_shape: tuple[int, ...],
) -> tuple[JobStatus, dict[str, Any]]:
    """Run one job through the real API/queue/executor and validate artifacts."""

    async def exercise() -> tuple[JobStatus, dict[str, Any]]:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                job_id, owner_connection_id, headers = await _submit_authenticated(client, auth, submission)
                status = wait_for_terminal(manager, job_id, owner_connection_id, timeout=900)
                assert status.status == "succeeded", f"job {job_id} failed: {status.error}"
                status = wait_for_package(manager, job_id, owner_connection_id)
                _assert_event_chain(manager, job_id, owner_connection_id)
                assert status.model_package is not None

                root = Path(status.artifact_dir).resolve()
                assert root.is_dir(), f"artifact root missing: {root}"
                assert (root / "requested_config.json").is_file()
                assert (root / "resolved_config.yaml").is_file()

                # Safe weights must be loadable and match the resolved architecture.
                weights_path = root / "weights.safetensors"
                assert weights_path.is_file(), "weights.safetensors missing from artifact root"
                state = load_file(str(weights_path))
                assert state, "weights.safetensors is empty"
                resolved = OmegaConf.load(root / "resolved_config.yaml")
                net_config = OmegaConf.to_container(resolved["net"], resolve=True)
                assert isinstance(net_config, dict)
                network = GraphNet(net_config)
                network.load_state_dict(state, strict=True)

                # Wheel digest must match the manifest and the served download.
                wheel_rel = status.model_package.wheel
                wheel_path = (root / wheel_rel).resolve()
                assert wheel_path.is_file() and wheel_path.suffix == ".whl"
                assert status.model_package.sha256 == hashlib.sha256(wheel_path.read_bytes()).hexdigest()
                manifest_on_disk = json.loads((root / "model-package.json").read_text(encoding="utf-8"))
                assert manifest_on_disk["sha256"] == status.model_package.sha256

                downloaded = await client.get(f"/jobs/{job_id}/package", headers=headers)
                assert downloaded.status_code == 200
                assert downloaded.content == wheel_path.read_bytes()
                assert downloaded.headers["x-nnm-sha256"] == status.model_package.sha256
                assert "attachment" in downloaded.headers["content-disposition"]

                # Save the served bytes to a client-owned wheel file (named
                # after the manifest so pip accepts it) and verify its digest
                # against the manifest before installing it.
                downloaded_wheel = work_dir / Path(status.model_package.wheel).name
                downloaded_wheel.write_bytes(downloaded.content)
                assert (
                    hashlib.sha256(downloaded_wheel.read_bytes()).hexdigest()
                    == status.model_package.sha256
                )

                # Install the DOWNLOADED wheel in an isolated venv and predict.
                inputs = deterministic_input(batch=2)
                result = install_and_predict(
                    downloaded_wheel,
                    status.model_package.package_name,
                    inputs,
                    work_dir,
                )
                assert tuple(result["shape"]) == expected_output_shape
                assert result["dtype"] == "torch.float32"
                assert result["finite"] is True
                assert result["reload_equivalent"] is True

                # Parent-side independent reload agrees with the installed package.
                with torch.inference_mode():
                    parent_output = network(inputs)
                assert tuple(parent_output.shape) == expected_output_shape
                assert parent_output.flatten()[:5].tolist() == result["sample"]
                return status, result

    return asyncio.run(exercise())


def test_e2e_mnist_classifier_job(backend, tmp_path, retain_e2e_artifacts_on_failure):
    """The full production path for the mninst classifier model."""
    app, manager, auth = backend
    work_dir = tmp_path / "classifier-work"
    work_dir.mkdir()

    status, result = _run_real_job(
        app,
        manager,
        auth,
        classification_submission(),
        work_dir,
        expected_output_shape=(2, 10),
    )

    assert status.executor == "local"
    assert status.model_package.package_name == "nnm_mnist_classifier"
    assert result["shape"] == [2, 10]


def test_e2e_autoencoder_job(backend, tmp_path, retain_e2e_artifacts_on_failure):
    """The full production path for the autoencoder_mnist model."""
    app, manager, auth = backend
    work_dir = tmp_path / "autoencoder-work"
    work_dir.mkdir()

    status, result = _run_real_job(
        app,
        manager,
        auth,
        autoencoder_submission(),
        work_dir,
        expected_output_shape=(2, 1, 28, 28),
    )

    assert status.model_package.package_name == "nnm_autoencoder_tiny"
    assert result["shape"] == [2, 1, 28, 28]


def test_e2e_real_job_failure_records_coherent_terminal_state(
    backend, tmp_path, retain_e2e_artifacts_on_failure
):
    """A real executor failure must produce failed status, event, and logs."""
    app, manager, auth = backend
    submission = broken_submission()

    async def exercise() -> None:
        transport = httpx.ASGITransport(app=app)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                job_id, owner_connection_id, headers = await _submit_authenticated(client, auth, submission)
                status = wait_for_terminal(manager, job_id, owner_connection_id, timeout=900)
                assert status.status == "failed"
                assert status.finished_at is not None
                assert status.model_package is None
                assert "tiny broken dataset cannot be constructed" in (status.error or "")

                events = manager.events(job_id, owner_connection_id=owner_connection_id)
                assert events[-1]["type"] == "failed"
                logs = manager.logs(job_id, owner_connection_id=owner_connection_id)
                assert "tiny broken dataset cannot be constructed" in logs["stderr"]
                package = await client.get(f"/jobs/{job_id}/package", headers=headers)
                assert package.status_code == 404

                # D5: the failed job must not remain claimable from the real
                # queue, while the record and its audit trail stay visible.
                assert ValkeyJobStore(get_test_valkey_url()).claim_next() is None
                assert [job.id for job in manager.admin_list_status()] == [job_id]

    asyncio.run(exercise())


def test_e2e_project_scoped_job_runs_inside_the_project_runs_dir(
    tmp_path, clean_valkey, retain_e2e_artifacts_on_failure
):
    """A project-scoped job resolves through the companion registry, stores every
    artifact under ``<project>/runs/<job-id>``, and trains with the project
    interpreter and import roots through the real queue/executor pipeline."""
    projects = ProjectManager(tmp_path / "state", sync_enabled=False)
    project = projects.create_project("e2e-proj", str(tmp_path / "proj"))
    root = Path(project.root)
    # Materialize the project interpreter without uv/network: a real venv whose
    # site-packages inherit the companion venv's heavy dependencies through a
    # ``.pth`` file, exactly like ``install_and_predict`` does for the wheel.
    subprocess.run(
        [sys.executable, "-m", "venv", str(root / ".venv")],
        check=True,
        capture_output=True,
    )
    venv_python = project_python(root)
    parent_site = subprocess.check_output(
        [sys.executable, "-c", "import site; print(site.getsitepackages()[0])"],
        text=True,
    ).strip()
    venv_site = subprocess.check_output(
        [str(venv_python), "-c", "import site; print(site.getsitepackages()[0])"],
        text=True,
    ).strip()
    Path(venv_site, "nnm-e2e-parent-site.pth").write_text(f"{parent_site}\n", encoding="utf-8")
    manager = JobManager(
        ValkeyJobStore(get_test_valkey_url()),
        tmp_path / "jobs",
        [LocalExecutor(CONVERTED_DIR)],
        poll_interval=0.1,
        project_manager=projects,
    )
    auth = AuthService(ValkeyAuthStore(get_test_valkey_url()))
    app = create_app(
        manager,
        auth_service=auth,
        admin_token=ADMIN_TOKEN,
        project_manager=projects,
    )
    work_dir = tmp_path / "project-work"
    work_dir.mkdir()

    status, _result = _run_real_job(
        app,
        manager,
        auth,
        classification_submission().model_copy(update={"project_id": project.id}),
        work_dir,
        expected_output_shape=(2, 10),
    )

    artifact = Path(status.artifact_dir).resolve()
    runs_dir = (root / "runs").resolve()
    assert artifact.parent == runs_dir
    assert artifact.name == status.id
    assert (artifact / "requested_config.json").is_file()
    assert (artifact / "resolved_config.yaml").is_file()
    assert status.executor == "local"
    assert status.model_package is not None
