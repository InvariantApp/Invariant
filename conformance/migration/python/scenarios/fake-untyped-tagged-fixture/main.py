# A recorded webhook, kept as the untyped JSON the API sent, which names
# its own schema.
from typing import Any

import acme

client = acme.Client("sk_test")

RECORDED = {
    "type": "customer.updated",
    "data": {
        "object": {
            "object": "customer",
            "id": "cus_1",
            "nickname": "Ada",  # <- flag
        },
    },
}


def handle(event: dict[str, Any]) -> acme.Customer:
    return client.customers.retrieve(event["data"]["object"]["id"])
