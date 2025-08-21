from __future__ import annotations

import logging
import uuid

from flask import Response, g, request
from prometheus_client import Counter, Histogram, generate_latest

REQUEST_COUNT = Counter(
    "http_requests_total", "Total HTTP requests", ["method", "endpoint", "http_status"]
)
REQUEST_LATENCY = Histogram(
    "http_request_latency_seconds", "Request latency", ["endpoint"]
)


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=level,
        format="%(message)s",
    )


def before_request() -> None:
    g.request_id = str(uuid.uuid4())
    logging.info(
        {
            "event": "request_start",
            "method": request.method,
            "path": request.path,
            "request_id": g.request_id,
        }
    )


def after_request(response: Response) -> Response:
    REQUEST_COUNT.labels(request.method, request.path, response.status_code).inc()
    REQUEST_LATENCY.labels(request.path).observe(request.elapsed.total_seconds() if hasattr(request, 'elapsed') else 0)
    logging.info(
        {
            "event": "request_end",
            "status": response.status_code,
            "request_id": g.request_id,
        }
    )
    return response


def metrics() -> Response:
    return Response(generate_latest(), mimetype="text/plain")
