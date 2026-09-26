# The part of pydantic's surface the SDK's models use, as a stub, so the
# checker reads them the way pydantic's own dataclass transform says to.
from typing import Any

from typing_extensions import dataclass_transform

def Field(default: Any = ..., *, alias: str | None = None) -> Any: ...
@dataclass_transform(kw_only_default=True, field_specifiers=(Field,))
class BaseModel:
    def model_dump(self) -> dict[str, Any]: ...
    def model_copy(self, *, update: dict[str, Any] | None = None) -> Any: ...
