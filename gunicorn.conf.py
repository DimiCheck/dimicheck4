from __future__ import annotations

import os


# Flask-SocketIO + simple-websocket under gunicorn works reliably with gthread.
# Keep a single worker unless you add a proper message queue + sticky routing.
wsgi_app = "app:app"
bind = os.getenv("GUNICORN_BIND", "0.0.0.0:5000")
worker_class = "gthread"
workers = int(os.getenv("GUNICORN_WORKERS", "1"))
threads = int(os.getenv("GUNICORN_THREADS", "8"))
timeout = int(os.getenv("GUNICORN_TIMEOUT", "120"))
graceful_timeout = int(os.getenv("GUNICORN_GRACEFUL_TIMEOUT", "30"))
keepalive = int(os.getenv("GUNICORN_KEEPALIVE", "5"))
accesslog = "-"
errorlog = "-"
capture_output = True
