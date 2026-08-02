"""FastAPI application for authenticated remote NNModelling training."""

from __future__ import annotations

import json
import hmac
import os
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from backend.static import SPAStaticFiles

from backend.auth import (
    AuthError,
    AuthService,
    InMemoryAuthStore,
    PairingLimitError,
    ValkeyAuthStore,
    parse_duration,
)
from backend.dataset_registry import discover_datasets
from backend.manager import JobManager, PackageIntegrityError, _remove_file
from backend.models import (
    JobStatus,
    JobSubmission,
    PairingGrantResponse,
    PairingApprovalInput,
    PairingRequestInput,
    PairingStatusResponse,
    SessionInfo,
)
from backend.project_schema import (
    CreateProjectRequest,
    DatasetCatalogResponse,
    OpenProjectRequest,
    ProjectSummary,
    RecentProjectsResponse,
    StereotypeCatalogResponse,
    WandbKeyInput,
    WandbKeyStatus,
    WandbSettingsResponse,
    WandbUpdate,
)
from backend.projects import ProjectError, ProjectManager


DEFAULT_ALLOWED_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "http://localhost:5173",
    "http://localhost:5174",
]


class _CleanupFileResponse(FileResponse):
    """FileResponse that always runs its background cleanup.

    Starlette invokes the ``background`` callback only after a fully
    successful transfer; on a client disconnect or a streaming error the
    callback would be skipped, leaking the verified download snapshot. This
    wrapper runs the callback in a ``finally`` so cleanup happens on every
    outcome. The callback must be idempotent because the parent already runs
    it once on the happy path.
    """

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            if self.background is not None:
                await self.background()


def _verified_snapshot_response(snapshot: Path, filename: str, digest: str) -> FileResponse:
    """Serve the verified immutable snapshot and delete it when the response ends.

    Only the backend-private snapshot created and hashed by the manager is
    served; the original artifact path is never reopened here, so bytes
    replaced on disk after verification cannot be transferred. The snapshot is
    removed after the response completes, errors, or is disconnected.

    Args:
        snapshot: Verified snapshot path created by ``package_download``.
        filename: Original wheel name used for ``Content-Disposition``.
        digest: SHA-256 of the snapshot, exposed via ``X-NNM-SHA256``.

    Raises:
        HTTPException: 404 when the snapshot can no longer be read.
    """

    try:
        snapshot.stat()
    except OSError:
        _remove_file(snapshot)
        raise HTTPException(status_code=404, detail="Model package is not available") from None
    return _CleanupFileResponse(
        snapshot,
        media_type="application/octet-stream",
        filename=filename,
        headers={"X-NNM-SHA256": digest},
        background=BackgroundTask(_remove_file, snapshot),
    )


def create_app(
    manager: JobManager | None = None,
    *,
    auth_service: AuthService | None = None,
    admin_token: str | None = None,
    allowed_origins: list[str] | None = None,
    project_manager: ProjectManager | None = None,
    static_dir: str | Path | None = None,
) -> FastAPI:
    """Create the API application with injectable services for tests.

    Args:
        manager: Job manager; defaults to ``JobManager.from_environment``.
        auth_service: Auth service; defaults to the environment store.
        admin_token: Administrator capability; defaults to the token file.
        allowed_origins: CORS origins; defaults to the development origins.
        project_manager: Companion project service; defaults to the
            environment state directory.
        static_dir: Optional built frontend directory. When provided, the app
            also serves the editor (SPA fallback) and the production project
            calls resolve under the ``/api`` prefix on the same origin.
    """

    injected_manager = manager

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.manager.start()
        try:
            yield
        finally:
            app.state.manager.stop()

    app = FastAPI(
        title="NNModelling Training Backend",
        version="0.2.0",
        lifespan=lifespan,
    )
    origins = allowed_origins if allowed_origins is not None else _allowed_origins_from_environment()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Last-Event-ID", "X-NNM-Admin-Token"],
        expose_headers=["X-NNM-SHA256"],
    )
    app.state.projects = project_manager or ProjectManager.from_environment()
    app.state.manager = manager or JobManager.from_environment(project_manager=app.state.projects)
    app.state.auth = auth_service or _auth_from_environment(in_memory=injected_manager is not None)
    app.state.admin_token = admin_token if admin_token is not None else _read_admin_token()

    async def bearer_token(authorization: str | None = Header(default=None)) -> str:
        if authorization is None or not authorization.startswith("Bearer "):
            raise _auth_http_error(AuthError("missing_token"))
        token = authorization.removeprefix("Bearer ").strip()
        if not token:
            raise _auth_http_error(AuthError("missing_token"))
        return token

    async def current_connection(token: str = Depends(bearer_token)) -> dict[str, Any]:
        try:
            return app.state.auth.authenticate(token)
        except AuthError as exc:
            raise _auth_http_error(exc) from exc

    async def administrator(
        x_nnm_admin_token: str | None = Header(default=None),
    ) -> None:
        expected = app.state.admin_token
        if expected is None:
            raise HTTPException(
                status_code=503,
                detail={"code": "admin_not_configured", "message": "administrator token is not configured"},
            )
        if x_nnm_admin_token is None or not hmac.compare_digest(x_nnm_admin_token, expected):
            raise HTTPException(
                status_code=401,
                detail={"code": "invalid_admin_token", "message": "invalid administrator token"},
            )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/pairing/requests", response_model=PairingGrantResponse, status_code=201)
    async def create_pairing(body: PairingRequestInput, request: Request) -> PairingGrantResponse:
        try:
            grant = app.state.auth.create_pairing(
                body.device_name,
                client_host=_client_host(request),
                origin=request.headers.get("origin"),
                user_agent=request.headers.get("user-agent"),
            )
            return PairingGrantResponse(**grant.__dict__)
        except PairingLimitError as exc:
            raise HTTPException(
                status_code=429,
                detail={"code": exc.code, "message": str(exc)},
                headers={"Retry-After": "60"},
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/pairing/requests/{request_id}", response_model=PairingStatusResponse)
    async def pairing_status(
        request_id: str,
        token: str = Depends(bearer_token),
    ) -> PairingStatusResponse:
        try:
            return PairingStatusResponse.model_validate(app.state.auth.pairing_status(request_id, token))
        except AuthError as exc:
            raise _auth_http_error(exc, not_found_codes={"pairing_not_found"}) from exc

    @app.post("/pairing/renewals", response_model=PairingGrantResponse, status_code=201)
    async def create_renewal(
        request: Request,
        token: str = Depends(bearer_token),
    ) -> PairingGrantResponse:
        try:
            grant = app.state.auth.create_renewal(
                token,
                client_host=_client_host(request),
                origin=request.headers.get("origin"),
                user_agent=request.headers.get("user-agent"),
            )
            return PairingGrantResponse(**grant.__dict__)
        except PairingLimitError as exc:
            raise HTTPException(
                status_code=429,
                detail={"code": exc.code, "message": str(exc)},
                headers={"Retry-After": "60"},
            ) from exc
        except AuthError as exc:
            raise _auth_http_error(exc) from exc

    @app.get("/session", response_model=SessionInfo)
    async def session(connection: dict[str, Any] = Depends(current_connection)) -> SessionInfo:
        return SessionInfo.model_validate(app.state.auth.public_session(connection))

    @app.delete("/session", response_model=SessionInfo)
    async def revoke_session(connection: dict[str, Any] = Depends(current_connection)) -> SessionInfo:
        return SessionInfo.model_validate(app.state.auth.revoke(connection["id"]))

    @app.get("/datasets")
    async def datasets(
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> list[dict[str, Any]]:
        return [dataset.model_dump(mode="json") for dataset in discover_datasets()]

    # -- Project workspace APIs -------------------------------------------------
    # Project calls use the companion origin; every endpoint requires the same
    # pairing authentication as the training endpoints. Project IDs resolve
    # only through the companion-owned recent-project registry. The router is
    # registered both at the root (established backend contract) and under the
    # ``/api`` prefix, which is how the built editor's same-origin
    # ``ProjectApiClient`` reaches the companion in production.

    project_router = APIRouter()

    @project_router.post("/projects", response_model=ProjectSummary, status_code=201)
    async def create_project(
        body: CreateProjectRequest,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> ProjectSummary:
        try:
            return app.state.projects.create_project(body.name, body.root)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.post("/projects/open", response_model=ProjectSummary)
    async def open_project(
        body: OpenProjectRequest,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> ProjectSummary:
        try:
            return app.state.projects.open_project(body.root)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.get("/projects", response_model=RecentProjectsResponse)
    async def list_projects(
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> RecentProjectsResponse:
        return app.state.projects.list_projects()

    @project_router.get("/projects/active", response_model=ProjectSummary)
    async def active_project(
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> ProjectSummary:
        summary = app.state.projects.active_project()
        if summary is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "no_active_project", "message": "no project is currently active"},
            )
        return summary

    @project_router.get("/projects/{project_id}", response_model=ProjectSummary)
    async def get_project(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> ProjectSummary:
        try:
            return app.state.projects.get_project(project_id)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.post("/projects/{project_id}/sync", response_model=ProjectSummary)
    async def sync_project(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> ProjectSummary:
        try:
            return app.state.projects.sync_project(project_id)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.delete("/projects/{project_id}", response_model=ProjectSummary)
    async def forget_project(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> ProjectSummary:
        try:
            summary = app.state.projects.get_project(project_id)
            app.state.projects.forget_project(project_id)
            return summary
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.get("/projects/{project_id}/graph", response_model=dict[str, Any])
    async def read_graph(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> dict[str, Any]:
        try:
            return app.state.projects.read_graph(project_id)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.put("/projects/{project_id}/graph", response_model=dict[str, Any])
    async def write_graph(
        project_id: str,
        body: dict[str, Any],
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> dict[str, Any]:
        try:
            app.state.projects.write_graph(project_id, body)
            return app.state.projects.read_graph(project_id)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.get("/projects/{project_id}/stereotypes", response_model=StereotypeCatalogResponse)
    async def project_stereotypes(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> StereotypeCatalogResponse:
        try:
            return app.state.projects.project_stereotypes(project_id)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.get("/projects/{project_id}/datasets", response_model=DatasetCatalogResponse)
    async def project_datasets(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> DatasetCatalogResponse:
        try:
            return app.state.projects.project_datasets(project_id)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.get("/projects/{project_id}/wandb", response_model=WandbSettingsResponse)
    async def read_wandb(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> WandbSettingsResponse:
        try:
            settings, configured = app.state.projects.read_wandb(project_id)
            return WandbSettingsResponse(**settings.model_dump(), api_key_configured=configured)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.put("/projects/{project_id}/wandb", response_model=WandbSettingsResponse)
    async def update_wandb(
        project_id: str,
        body: WandbUpdate,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> WandbSettingsResponse:
        try:
            settings = app.state.projects.update_wandb(project_id, body)
            configured = app.state.projects.wandb_key_configured(project_id)
            return WandbSettingsResponse(**settings.model_dump(), api_key_configured=configured)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.put("/projects/{project_id}/wandb-key", response_model=WandbKeyStatus)
    async def set_wandb_key(
        project_id: str,
        body: WandbKeyInput,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> WandbKeyStatus:
        try:
            app.state.projects.set_wandb_key(project_id, body.api_key)
            return WandbKeyStatus(configured=True)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    @project_router.delete("/projects/{project_id}/wandb-key", response_model=WandbKeyStatus)
    async def delete_wandb_key(
        project_id: str,
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> WandbKeyStatus:
        try:
            app.state.projects.delete_wandb_key(project_id)
            return WandbKeyStatus(configured=False)
        except ProjectError as exc:
            raise _project_http_error(exc) from exc

    app.include_router(project_router)
    app.include_router(project_router, prefix="/api", include_in_schema=False)

    @app.get("/compute-units")
    async def compute_units(
        _connection: dict[str, Any] = Depends(current_connection),
    ) -> list[dict[str, Any]]:
        return [executor.describe() for executor in app.state.manager.executors]

    @app.post("/jobs", response_model=JobStatus, status_code=202)
    async def submit_job(
        submission: JobSubmission,
        connection: dict[str, Any] = Depends(current_connection),
    ) -> JobStatus:
        try:
            return app.state.manager.submit(submission, owner_connection_id=connection["id"])
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/jobs", response_model=list[JobStatus])
    async def list_jobs(
        connection: dict[str, Any] = Depends(current_connection),
    ) -> list[JobStatus]:
        return app.state.manager.list_status(owner_connection_id=connection["id"])

    @app.get("/jobs/{job_id}", response_model=JobStatus)
    async def get_job(
        job_id: str,
        connection: dict[str, Any] = Depends(current_connection),
    ) -> JobStatus:
        try:
            return app.state.manager.status(job_id, owner_connection_id=connection["id"])
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    @app.get("/jobs/{job_id}/logs")
    async def get_logs(
        job_id: str,
        connection: dict[str, Any] = Depends(current_connection),
    ) -> dict[str, str]:
        try:
            return app.state.manager.logs(job_id, owner_connection_id=connection["id"])
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    @app.get("/jobs/{job_id}/logs/tail")
    async def tail_logs(
        job_id: str,
        connection: dict[str, Any] = Depends(current_connection),
        stdout_after: int = Query(default=0, ge=0),
        stderr_after: int = Query(default=0, ge=0),
    ) -> dict[str, dict[str, str | int | bool]]:
        """Read only the output appended after each client cursor."""

        try:
            return app.state.manager.tail_logs(
                job_id,
                owner_connection_id=connection["id"],
                stdout_after=stdout_after,
                stderr_after=stderr_after,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    @app.get("/jobs/{job_id}/package")
    async def download_model_package(
        job_id: str,
        connection: dict[str, Any] = Depends(current_connection),
    ) -> FileResponse:
        """Download the authenticated job's generated pip wheel.

        The wheel is streamed into a private immutable snapshot and hashed
        from that single opened source handle before any byte is served; the
        snapshot digest must match the manifest, and only the verified
        snapshot is transferred (never the mutable artifact path). A corrupted
        or replaced wheel is rejected with ``409 Conflict`` and never
        downloaded. On success the verified digest is exposed through the
        ``X-NNM-SHA256`` response header and the snapshot is removed once the
        response completes or fails.
        """

        try:
            path, filename, digest = app.state.manager.package_download(
                job_id,
                owner_connection_id=connection["id"],
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Model package is not available") from exc
        except PackageIntegrityError as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": "package_integrity_error", "message": str(exc)},
            ) from exc
        return _verified_snapshot_response(path, filename, digest)

    @app.get("/jobs/{job_id}/events")
    def get_events(
        job_id: str,
        connection: dict[str, Any] = Depends(current_connection),
        after: str | None = None,
        last_event_id: str | None = Header(default=None),
    ) -> StreamingResponse:
        owner_connection_id = connection["id"]
        try:
            app.state.manager.status(job_id, owner_connection_id=owner_connection_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

        def stream() -> Iterator[str]:
            cursor = after or last_event_id
            idle_cycles = 0
            while idle_cycles < 120:
                events = app.state.manager.events(
                    job_id,
                    cursor,
                    owner_connection_id=owner_connection_id,
                )
                if events:
                    idle_cycles = 0
                    for event in events:
                        cursor = str(event["id"])
                        yield f"id: {cursor}\ndata: {json.dumps(event)}\n\n"
                else:
                    idle_cycles += 1
                    status = app.state.manager.status(job_id, owner_connection_id=owner_connection_id)
                    if status.status in {"succeeded", "failed", "cancelled"}:
                        break
                    yield ": keep-alive\n\n"
                time.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.delete("/jobs/{job_id}", response_model=JobStatus)
    async def cancel_job(
        job_id: str,
        connection: dict[str, Any] = Depends(current_connection),
    ) -> JobStatus:
        try:
            return app.state.manager.cancel(job_id, owner_connection_id=connection["id"])
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    admin_dependency = [Depends(administrator)]

    @app.get(
        "/admin/pairing/requests",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_pairing_requests() -> list[dict[str, Any]]:
        return app.state.auth.list_requests(pending_only=True)

    @app.post(
        "/admin/pairing/requests/{request_id}/approve",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_approve_pairing(
        request_id: str,
        body: PairingApprovalInput,
    ) -> dict[str, Any]:
        try:
            ttl = parse_duration(body.ttl) if body.ttl else None
            return app.state.auth.approve(request_id, ttl)
        except AuthError as exc:
            raise _auth_http_error(exc, not_found_codes={"pairing_not_found"}) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post(
        "/admin/pairing/requests/{request_id}/reject",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_reject_pairing(request_id: str) -> dict[str, Any]:
        try:
            return app.state.auth.reject(request_id)
        except AuthError as exc:
            raise _auth_http_error(exc, not_found_codes={"pairing_not_found"}) from exc

    @app.get(
        "/admin/sessions",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_sessions() -> list[dict[str, Any]]:
        return app.state.auth.list_sessions()

    @app.delete(
        "/admin/sessions/{connection_id}",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_revoke_session(connection_id: str) -> dict[str, Any]:
        try:
            return app.state.auth.revoke(connection_id)
        except AuthError as exc:
            raise _auth_http_error(exc, not_found_codes={"session_not_found"}) from exc

    @app.get(
        "/admin/jobs",
        response_model=list[JobStatus],
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_jobs() -> list[JobStatus]:
        return app.state.manager.admin_list_status()

    @app.get(
        "/admin/jobs/{job_id}",
        response_model=JobStatus,
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_job(job_id: str) -> JobStatus:
        try:
            return app.state.manager.admin_status(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    @app.get(
        "/admin/jobs/{job_id}/logs",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_job_logs(job_id: str) -> dict[str, str]:
        try:
            return app.state.manager.admin_logs(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    @app.get(
        "/admin/jobs/{job_id}/events",
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_job_events(job_id: str, after: str | None = None) -> list[dict[str, Any]]:
        try:
            return app.state.manager.admin_events(job_id, after)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    @app.delete(
        "/admin/jobs/{job_id}",
        response_model=JobStatus,
        dependencies=admin_dependency,
        include_in_schema=False,
    )
    async def admin_cancel_job(job_id: str) -> JobStatus:
        try:
            return app.state.manager.admin_cancel(job_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown job") from exc

    if static_dir is not None:
        # The mount is added after every API route so registered endpoints
        # keep precedence; the handler never rewrites /api paths to the SPA.
        app.mount("/", SPAStaticFiles(static_dir), name="spa")

    return app


def _auth_from_environment(*, in_memory: bool = False) -> AuthService:
    store = InMemoryAuthStore() if in_memory else ValkeyAuthStore(os.getenv("NNM_VALKEY_URL", "valkey://127.0.0.1:6379/0"))
    return AuthService(
        store,
        session_ttl=parse_duration(os.getenv("NNM_SESSION_TTL", "24h")),
        request_ttl=parse_duration(os.getenv("NNM_PAIRING_REQUEST_TTL", "10m")),
        max_pending_per_ip=int(os.getenv("NNM_PAIRING_MAX_PER_IP", "5")),
        max_pending_global=int(os.getenv("NNM_PAIRING_MAX_GLOBAL", "100")),
    )


def _allowed_origins_from_environment() -> list[str]:
    configured = os.getenv("NNM_ALLOWED_ORIGINS")
    if configured is None:
        return DEFAULT_ALLOWED_ORIGINS
    return [origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()]


def _read_admin_token() -> str | None:
    direct = os.getenv("NNM_ADMIN_TOKEN")
    if direct:
        return direct.strip()
    default_path = Path(__file__).resolve().parents[2] / "valkey-data" / "admin.token"
    path = Path(os.getenv("NNM_ADMIN_TOKEN_FILE", str(default_path))).expanduser()
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None


def _client_host(request: Request) -> str:
    return request.client.host if request.client is not None else "unknown"


def _auth_http_error(exc: AuthError, *, not_found_codes: set[str] | None = None) -> HTTPException:
    status_code = 404 if not_found_codes and exc.code in not_found_codes else 401
    return HTTPException(status_code=status_code, detail={"code": exc.code, "message": str(exc)})


# Project lifecycle error codes mapped to HTTP statuses. Unknown projects and
# missing files are 404; conflicts with the on-disk state are 409; every
# remaining validation failure is 422 with an actionable message.
_PROJECT_ERROR_STATUS = {
    "unknown_project": 404,
    "project_not_found": 404,
    "graph_missing": 404,
    "metadata_missing": 404,
    "project_exists": 409,
    "incompatible_root": 409,
    "not_a_project": 409,
}


def _project_http_error(exc: ProjectError) -> HTTPException:
    status_code = _PROJECT_ERROR_STATUS.get(exc.code, 422)
    return HTTPException(status_code=status_code, detail={"code": exc.code, "message": str(exc)})


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("backend.app:app", host="0.0.0.0", port=8000, reload=False)
