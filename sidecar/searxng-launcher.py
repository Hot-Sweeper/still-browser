"""Loopback-only launcher for Still's bundled SearXNG instance."""

import hmac
import getpass
import os
import sys
from types import SimpleNamespace
from urllib.parse import parse_qs

# SearXNG's optional Valkey error logger imports the Unix-only pwd module even
# when Valkey is disabled. Supply only the identity shape that logger needs.
try:
    import pwd  # type: ignore  # noqa: F401
except ImportError:
    sys.modules["pwd"] = SimpleNamespace(
        getpwuid=lambda uid: SimpleNamespace(pw_name=getpass.getuser(), pw_uid=uid)
    )

from waitress import serve

# SearXNG discovers result templates with os.path.join(), then compares those
# paths to URL-style forward-slash names. Normalize the discovery set on Windows.
import searx.webutils

_native_get_result_templates = searx.webutils.get_result_templates
_native_get_static_file_list = searx.webutils.get_static_file_list


def _portable_result_templates(templates_path):
    return {name.replace(os.sep, "/") for name in _native_get_result_templates(templates_path)}


def _portable_static_file_list():
    return [name.replace(os.sep, "/") for name in _native_get_static_file_list()]


searx.webutils.get_result_templates = _portable_result_templates
searx.webutils.get_static_file_list = _portable_static_file_list

from searx.webapp import app as searxng_app


HEALTH_PATH = "/__still_searxng_health"
health_token = os.environ.get("STILL_SEARXNG_HEALTH_TOKEN", "")


def application(environ, start_response):
    if environ.get("PATH_INFO") == HEALTH_PATH:
        supplied = parse_qs(environ.get("QUERY_STRING", "")).get("token", [""])[0]
        if health_token and hmac.compare_digest(supplied, health_token):
            body = b"still-searxng-ok"
            start_response(
                "200 OK",
                [
                    ("Content-Type", "text/plain; charset=utf-8"),
                    ("Content-Length", str(len(body))),
                    ("Cache-Control", "no-store"),
                ],
            )
            return [body]
        body = b"not found"
        start_response("404 Not Found", [("Content-Length", str(len(body)))])
        return [body]
    # The service is loopback-only and has no reverse proxy. Give SearXNG the
    # canonical client address it expects instead of trusting request headers.
    environ["HTTP_X_FORWARDED_FOR"] = "127.0.0.1"
    environ["HTTP_X_REAL_IP"] = "127.0.0.1"
    return searxng_app(environ, start_response)


def main():
    port = int(os.environ["STILL_SEARXNG_PORT"])
    serve(
        application,
        host="127.0.0.1",
        port=port,
        threads=6,
        clear_untrusted_proxy_headers=True,
        ident="Still Search",
    )


if __name__ == "__main__":
    main()
