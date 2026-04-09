from __future__ import annotations

import os


# Flask-SocketIO + simple-websocket under gunicorn works reliably with gthread.
# Keep a single worker unless you add a proper message queue + sticky routing.
wsgi_app = "app:app"
bind = os.getenv("GUNICORN_BIND", "0.0.0.0:5000")
worker_class = "gthread"
workers = int(os.getenv("GUNICORN_WORKERS", "1"))
#
# Each active websocket can occupy a gthread worker thread, so the previous
# value of 8 was too small for a classroom deployment with multiple board and
# teacher clients connected at the same time.
threads = max(int(os.getenv("GUNICORN_THREADS", "8")), 32)
timeout = int(os.getenv("GUNICORN_TIMEOUT", "120"))
#
# systemd currently stops this service after 20 seconds, so keep gunicorn's
# graceful shutdown budget below that to avoid repeated SIGKILL shutdowns.
graceful_timeout = min(int(os.getenv("GUNICORN_GRACEFUL_TIMEOUT", "30")), 15)
keepalive = int(os.getenv("GUNICORN_KEEPALIVE", "5"))
accesslog = "-"
errorlog = "-"
capture_output = True
