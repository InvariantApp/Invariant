"""A tiny API in a language that is not Node, standing in for a real provider.

It serves only the current contract and knows nothing about Invariant. Every
old-contract caller in the tests reaches it through the proxy, which is the
claim under test: the provider's own code never changes.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep test output clean
        pass

    def _send(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length else b""

    def do_POST(self):
        raw = self._body()
        if self.path == "/v1/payments":
            sent = json.loads(raw or b"{}")
            # The current contract speaks in minor units and knows `review`.
            self._send(200, {
                "id": "pay_1",
                "amount_cents": sent.get("amount_cents"),
                "status": "review" if sent.get("amount_cents", 0) > 1000 else "done",
                "received": sent,
                "saw_internal_header": any(
                    k.lower().startswith("x-invariant-") for k in self.headers.keys()
                ),
            })
        elif self.path == "/v1/upload":
            self._send(200, {"bytes": len(raw)})
        else:
            self._send(404, {"error": "not found"})

    def do_GET(self):
        if self.path == "/v1/big":
            self._send(200, {"items": ["x" * 100] * 20000})
        elif self.path == "/down-page":
            self._send(503, b"<h1>maintenance</h1>", "text/html")
        else:
            self._send(404, {"error": "not found"})


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
