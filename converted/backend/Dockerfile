FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends podman ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

COPY src ./src

ENV PYTHONPATH=/app/src
ENV NNM_CONVERTED_DIR=/app
ENV NNM_BACKEND_ARTIFACT_ROOT=/app/jobs
ENV NNM_CONTAINER_ENGINE=podman
ENV UV_NO_SYNC=1

EXPOSE 8000
CMD ["uv", "run", "python", "-m", "backend.cli", "--host", "0.0.0.0", "--port", "8000"]
