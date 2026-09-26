from typing import Any, Dict, Optional


class StripeObject(Dict[str, Any]):
    class _ReprJSONEncoder(json.JSONEncoder):
        def default(self, o: Any) -> Any:
            return super(StripeObject._ReprJSONEncoder, self).default(o)

    _retrieve_params: Dict[str, Any]
    _previous: Optional[Dict[str, Any]]

    def __init__(
        self,
        id: Optional[str] = None,
        api_key: Optional[str] = None,
        **params: Any
    ):
        super(StripeObject, self).__init__()
