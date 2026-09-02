"""Least-privilege controller for package worker containers.

The controller is deliberately independent from FastAPI.  Callers must hand
it a :class:`ContainerJobSpec`, which is a small, validated description of a
worker invocation.  Engine-specific flags never cross this boundary.
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol


_DIGEST_IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[0-9a-f]{64}$")
_JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_WORKER = ("/app/.venv/bin/python", "-m", "package_worker")
_RPC_VERSION = 1


def _dataset_root() -> Path:
    """Resolve the operator-provisioned dataset directory for local control."""

    default = Path(__file__).resolve().parents[2] / "data"
    return Path(os.environ.get("NNM_CONTAINER_DATA_ROOT", str(default))).expanduser().resolve()


class ContainerCapabilityError(RuntimeError):
    """The configured engine cannot satisfy a package job."""


class ControllerProtocolError(RuntimeError):
    """The trusted controller rejected or failed an RPC request."""


@dataclass(frozen=True, slots=True)
class ContainerJobSpec:
    """Server-generated, immutable container request.

    ``input_dir`` and ``artifact_dir`` must be below the controller roots.  A
    caller cannot choose arbitrary engine flags or an arbitrary executable.
    """

    job_id: str
    image: str
    input_dir: Path
    artifact_dir: Path
    cpu: int = 1
    memory_gb: float = 1.0
    pid_limit: int = 256
    timeout_seconds: float = 3600.0
    output_limit_bytes: int = 1 << 30
    network: str = "none"
    dataset_dir: Path | None = None

    def validate(self, *, input_root: Path, artifact_root: Path,
                 dataset_root: Path | None = None) -> "ContainerJobSpec":
        if not _JOB_ID.fullmatch(self.job_id):
            raise ValueError("invalid job id")
        if not _DIGEST_IMAGE.fullmatch(self.image):
            raise ValueError("image must be pinned by sha256 digest")
        if self.network != "none":
            raise ValueError("package workers require network=none")
        if self.cpu < 1 or self.memory_gb <= 0 or self.pid_limit < 1:
            raise ValueError("invalid resource limit")
        if self.timeout_seconds <= 0 or self.output_limit_bytes < 1:
            raise ValueError("invalid job limit")
        for candidate, root, name in (
            (self.input_dir, input_root, "input_dir"),
            (self.artifact_dir, artifact_root, "artifact_dir"),
        ):
            try:
                candidate.resolve().relative_to(root.resolve())
            except ValueError as exc:
                raise ValueError(f"{name} escapes controller root") from exc
        if self.dataset_dir is not None:
            if not self.dataset_dir.is_dir():
                raise ValueError("dataset_dir must be a directory")
            if dataset_root is not None:
                try:
                    self.dataset_dir.resolve().relative_to(dataset_root.resolve())
                except ValueError as exc:
                    raise ValueError("dataset_dir escapes controller root") from exc
        return self

    def to_json(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id, "image": self.image,
            "input_dir": str(self.input_dir), "artifact_dir": str(self.artifact_dir),
            "cpu": self.cpu, "memory_gb": self.memory_gb, "pid_limit": self.pid_limit,
            "timeout_seconds": self.timeout_seconds,
            "output_limit_bytes": self.output_limit_bytes, "network": self.network,
            "dataset_dir": str(self.dataset_dir) if self.dataset_dir else None,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "ContainerJobSpec":
        allowed = {"job_id", "image", "input_dir", "artifact_dir", "cpu", "memory_gb",
                   "pid_limit", "timeout_seconds", "output_limit_bytes", "network", "dataset_dir"}
        if set(value) != allowed:
            raise ValueError("invalid container job specification fields")
        return cls(
            job_id=value["job_id"], image=value["image"], input_dir=Path(value["input_dir"]),
            artifact_dir=Path(value["artifact_dir"]), cpu=value["cpu"], memory_gb=value["memory_gb"],
            pid_limit=value["pid_limit"], timeout_seconds=value["timeout_seconds"],
            output_limit_bytes=value["output_limit_bytes"], network=value["network"],
            dataset_dir=Path(value["dataset_dir"]) if value["dataset_dir"] else None,
        )


class EngineAdapter(Protocol):
    name: str

    def command(self, spec: ContainerJobSpec) -> list[str]: ...


class CliEngineAdapter:
    """Build argv for either rootless Podman or Docker."""

    def __init__(self, name: str = "podman", *, executable: str | None = None) -> None:
        if name not in {"podman", "docker"}:
            raise ValueError("engine must be podman or docker")
        self.name = name
        self.executable = executable or name

    def command(self, spec: ContainerJobSpec) -> list[str]:
        input_dir = spec.input_dir.resolve()
        artifact_dir = spec.artifact_dir.resolve()
        artifact_mount = f"type=bind,src={artifact_dir},dst=/artifacts"
        # Rootless Podman on SELinux hosts cannot write an unlabeled host bind
        # mount.  This is scoped to the per-job artifact directory; inputs and
        # datasets remain read-only and unlabeled.
        if self.name == "podman":
            artifact_mount += ",relabel=shared"
        command = [
            self.executable, "run", "--rm", "--name", f"nnm-package-{spec.job_id[:32]}",
            "--read-only", "--network", "none", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--pids-limit", str(spec.pid_limit),
            *(("--userns", "keep-id") if self.name == "podman" else ()),
            "--cpus", str(spec.cpu), "--memory", f"{spec.memory_gb:g}g",
            "--mount", f"type=bind,src={input_dir},dst=/input,readonly",
            "--mount", artifact_mount,
            # Do not pass an engine socket, devices, host root, or credentials.
            # Match the backend-created artifact directory ownership without
            # granting root or changing permissions on a shared host path.
            "--user", f"{os.getuid()}:{os.getgid()}", spec.image, *_WORKER,
            "--input", "/input/job.json", "--artifacts", "/artifacts",
        ]
        if spec.dataset_dir is not None:
            command[command.index(spec.image):command.index(spec.image)] = [
                "--env", "NNM_DATASET_ROOT=/app/data",
                "--mount", f"type=bind,src={spec.dataset_dir.resolve()},dst=/app/data,readonly",
            ]
        return command


class ContainerController:
    """Own container lifecycle and turn missing capabilities into errors."""

    def __init__(self, *, engine: EngineAdapter, input_root: Path, artifact_root: Path,
                 dataset_root: Path | None = None,
                 popen: Callable[..., subprocess.Popen[Any]] = subprocess.Popen) -> None:
        self.engine = engine
        self.input_root = input_root.resolve()
        self.artifact_root = artifact_root.resolve()
        self.dataset_root = dataset_root.resolve() if dataset_root is not None else None
        self._popen = popen
        self._active: dict[str, subprocess.Popen[Any]] = {}
        self._finished: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()

    def command(self, spec: ContainerJobSpec) -> list[str]:
        spec.validate(input_root=self.input_root, artifact_root=self.artifact_root,
                      dataset_root=self.dataset_root)
        return self.engine.command(spec)

    def submit(self, spec: ContainerJobSpec, *, on_heartbeat: Callable[[dict[str, Any]], None] | None = None,
               on_finished: Callable[[int, dict[str, Any]], None] | None = None) -> dict[str, Any]:
        command = self.command(spec)
        if not shutil_which(command[0]):
            raise ContainerCapabilityError(f"container engine unavailable: {command[0]}")
        spec.input_dir.mkdir(parents=True, exist_ok=True)
        spec.artifact_dir.mkdir(parents=True, exist_ok=True)
        stdout_path = spec.artifact_dir / "stdout.log"
        stderr_path = spec.artifact_dir / "stderr.log"
        stdout = stdout_path.open("ab")
        stderr = stderr_path.open("ab")
        try:
            process = self._popen(command, stdout=stdout, stderr=stderr, start_new_session=True)
        except Exception:
            stdout.close(); stderr.close()
            raise
        stdout.close(); stderr.close()
        with self._lock:
            self._active[spec.job_id] = process
        started = time.monotonic()

        def monitor() -> None:
            timed_out = False
            output_limited = False
            while process.poll() is None:
                if time.monotonic() - started >= spec.timeout_seconds:
                    timed_out = True
                    self.cancel(spec.job_id)
                    break
                if _output_size(stdout_path, stderr_path) > spec.output_limit_bytes:
                    output_limited = True
                    self.cancel(spec.job_id)
                    break
                if on_heartbeat:
                    on_heartbeat({"job_id": spec.job_id, "pid": process.pid, "controller": "container"})
                time.sleep(1)
            code = process.returncode if process.returncode is not None else 1
            metadata = {"pid": process.pid, "timed_out": timed_out,
                        "output_limited": output_limited,
                        "stdout": str(stdout_path), "stderr": str(stderr_path), "command": command}
            with self._lock:
                self._active.pop(spec.job_id, None)
                self._finished[spec.job_id] = {"code": code, **metadata}
            if on_finished:
                on_finished(code, metadata)

        threading.Thread(target=monitor, name=f"nnm-container-{spec.job_id}", daemon=True).start()
        return {"pid": process.pid, "command": command, "stdout": str(stdout_path), "stderr": str(stderr_path)}

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            process = self._active.get(job_id)
        if process is None or process.poll() is not None:
            return False
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        except ProcessLookupError:
            return False
        return True

    def status(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            process = self._active.get(job_id)
            finished = self._finished.get(job_id)
        if finished is not None:
            return {"state": "finished", **finished}
        if process is None:
            return {"state": "unknown"}
        return {"state": "running", "pid": process.pid}

    def logs(self, job_id: str, *, stream: str = "stdout", offset: int = 0) -> dict[str, Any]:
        if stream not in {"stdout", "stderr"} or offset < 0:
            raise ValueError("invalid log request")
        status = self.status(job_id)
        path = status.get(stream)
        if not path:
            raise KeyError(job_id)
        data = Path(path).read_bytes()[offset:]
        return {"job_id": job_id, "stream": stream, "offset": offset,
                "next_offset": offset + len(data), "data": data.decode("utf-8", "replace")}


def shutil_which(binary: str) -> str | None:
    """Small injectable-friendly wrapper around PATH lookup."""
    import shutil
    return shutil.which(binary)


def _output_size(*paths: Path) -> int:
    """Return output size without allowing a disappearing log to fail cleanup."""
    return sum(path.stat().st_size for path in paths if path.exists())


def _authorized(conn: socket.socket, token: bytes) -> bool:
    """Require the same uid and a per-process bearer token."""
    try:
        peer_uid = os.getuid()
        raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        peer_uid = int.from_bytes(raw[4:8], sys.byteorder)
    except (AttributeError, OSError):
        pass
    return peer_uid == os.getuid()


def _rpc_response(request: dict[str, Any], *, result: Any = None, error: str | None = None) -> bytes:
    response = {"version": _RPC_VERSION, "request_id": request.get("request_id")}
    response["ok"] = error is None
    if error is None:
        response["result"] = result
    else:
        response["error"] = error
    return (json.dumps(response, sort_keys=True) + "\n").encode()


def serve_unix(controller: ContainerController, socket_path: Path, *, token: bytes) -> None:
    """Serve authenticated submit/cancel/status/log/heartbeat RPCs."""
    socket_path.unlink(missing_ok=True)
    socket_path.parent.mkdir(parents=True, exist_ok=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path)); os.chmod(socket_path, 0o600); server.listen(8)
    try:
        while True:
            conn, _ = server.accept()
            with conn:
                try:
                    request = json.loads(conn.recv(1 << 20))
                    if (request.get("version") != _RPC_VERSION or
                            request.get("token") != token.hex() or not _authorized(conn, token)):
                        conn.sendall(_rpc_response(request, error="unauthorized")); continue
                    op = request.get("op")
                    payload = request.get("payload", {})
                    if op == "submit":
                        result = controller.submit(ContainerJobSpec.from_json(payload))
                    elif op == "cancel":
                        result = {"cancelled": controller.cancel(payload["job_id"])}
                    elif op in {"status", "heartbeat", "finished"}:
                        result = controller.status(payload["job_id"])
                        if op == "heartbeat":
                            result = {**result, "job_id": payload["job_id"], "controller": "container"}
                        if op == "finished" and result.get("state") != "finished":
                            result = {"state": "pending", **result}
                    elif op == "log":
                        result = controller.logs(payload["job_id"], stream=payload.get("stream", "stdout"), offset=payload.get("offset", 0))
                    else:
                        raise ValueError("unsupported controller operation")
                    conn.sendall(_rpc_response(request, result=result))
                except (KeyError, TypeError, ValueError, OSError, json.JSONDecodeError) as exc:
                    conn.sendall(_rpc_response(locals().get("request", {}), error=str(exc)))
    finally:
        server.close(); socket_path.unlink(missing_ok=True)


class ContainerControllerClient:
    """Small synchronous client used by the untrusted FastAPI process."""

    def __init__(self, socket_path: Path, token: bytes, *, timeout: float = 5.0) -> None:
        self.socket_path, self.token, self.timeout = socket_path, token, timeout

    def call(self, op: str, payload: dict[str, Any]) -> Any:
        request = {"version": _RPC_VERSION, "request_id": os.urandom(8).hex(), "token": self.token.hex(),
                   "op": op, "payload": payload}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(self.timeout)
            conn.connect(str(self.socket_path)); conn.sendall((json.dumps(request) + "\n").encode())
            response = json.loads(conn.recv(1 << 20))
        if not response.get("ok"):
            message = response.get("error", "controller RPC failed")
            if "unavailable" in message:
                raise ContainerCapabilityError(message)
            raise ControllerProtocolError(message)
        return response.get("result")

    def submit(self, spec: ContainerJobSpec) -> dict[str, Any]:
        return self.call("submit", spec.to_json())

    def cancel(self, job_id: str) -> bool:
        return bool(self.call("cancel", {"job_id": job_id})["cancelled"])

    def status(self, job_id: str) -> dict[str, Any]:
        return self.call("status", {"job_id": job_id})

    def heartbeat(self, job_id: str) -> dict[str, Any]:
        return self.call("heartbeat", {"job_id": job_id})

    def finished(self, job_id: str) -> dict[str, Any]:
        return self.call("finished", {"job_id": job_id})

    def log(self, job_id: str, *, stream: str = "stdout", offset: int = 0) -> dict[str, Any]:
        return self.call("log", {"job_id": job_id, "stream": stream, "offset": offset})


def controller_main(argv: list[str]) -> int:
    if len(argv) != 6 or argv[0] != "serve":
        print("usage: python -m backend.container_controller serve SOCKET TOKEN INPUT_ROOT ARTIFACT_ROOT ENGINE", file=sys.stderr)
        return 2
    _, socket_name, token_argument, input_root, artifact_root, engine = argv
    try:
        token = _load_token_argument(token_argument)
    except (OSError, ValueError) as exc:
        print(f"controller token unavailable: {exc}", file=sys.stderr)
        return 1
    # Built-in data lives under ``converted/data`` while project archives are
    # extracted under ``converted/jobs/<job>/dataset``.  Both are manager-owned
    # paths below this shared root; the controller still rejects everything
    # outside it during per-job validation.
    dataset_root = Path(input_root).resolve().parent
    controller = ContainerController(engine=CliEngineAdapter(engine), input_root=Path(input_root), artifact_root=Path(artifact_root), dataset_root=dataset_root)
    serve_unix(controller, Path(socket_name), token=token)
    return 0


def _load_token_argument(argument: str) -> bytes:
    """Load a 32-byte RPC token from a hex argument or an operator file."""
    if argument.startswith("@"):
        path = Path(argument[1:])
        if not path.is_file():
            raise ValueError("token file is not a regular file")
        raw = path.read_bytes()
    else:
        raw = argument.encode("ascii")
    try:
        token = bytes.fromhex(raw.decode("ascii").strip())
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError("token must contain hexadecimal bytes") from exc
    if len(token) != 32:
        raise ValueError("token must be exactly 32 bytes")
    return token


if __name__ == "__main__":
    raise SystemExit(controller_main(sys.argv[1:]))
