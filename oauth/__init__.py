from __future__ import annotations

from flask import Blueprint

from .authorize import register_authorize_routes
from .token import register_token_routes
from .userinfo import register_userinfo_routes

blueprint = Blueprint("oauth", __name__, url_prefix="/oauth")

register_authorize_routes(blueprint)
register_token_routes(blueprint)
register_userinfo_routes(blueprint)
