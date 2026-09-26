# The renamed field read with a fallback from untyped JSON.
import json

import acme

client = acme.Client("sk_test")


def on_event(body: str) -> str:
    event = json.loads(body)
    client.customers.retrieve(event["data"]["object"]["id"])
    return event["data"]["object"].get("nickname", "friend")  # <- flag
