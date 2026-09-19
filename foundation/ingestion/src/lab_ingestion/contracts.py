"""Open Data Contract Standard (ODCS v3) reader.

Every bronze source is governed by a contract — the Lab's own for the ABM
output, the source application's for its exports. The extractor reads
the contract's `schema:` to validate rows and derive the bronze Arrow
schema, and its `quality:` entries to record (and, when the contract
declares a `custom` check implemented by this package, execute) the
quality expectations for the manifest. It never invents columns the
contract does not declare.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pyarrow as pa
import yaml


@dataclass(frozen=True)
class Field:
    name: str
    logical_type: str  # string | number | integer | boolean | date | object | array
    physical_type: str | None
    required: bool
    enum: tuple[str, ...] | None
    description: str


@dataclass(frozen=True)
class QualityRule:
    description: str
    dimension: str | None
    status: str | None
    type: str  # text | library | sql | custom
    implementation: str | None  # for custom checks: the check name in this package


@dataclass
class Contract:
    id: str
    version: str
    status: str
    object_name: str
    fields: list[Field]
    quality: list[QualityRule]
    path: Path

    @staticmethod
    def object_names(path: Path) -> list[str]:
        """The names of the contract's `schema:` objects (a contract may
        describe several tables/views of one export)."""
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        return [o["name"] for o in raw.get("schema") or []]

    @classmethod
    def load(cls, path: Path, object_name: str | None = None) -> "Contract":
        """One `Contract` = one schema object. A single-object contract
        needs no name; a multi-object one is loaded per object."""
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        objects = raw.get("schema") or []
        names = [o.get("name") for o in objects]
        if object_name is None:
            if len(objects) != 1:
                raise ValueError(f"{path}: contract declares {len(objects)} schema objects {names}; name one")
            obj = objects[0]
        else:
            found = [o for o in objects if o.get("name") == object_name]
            if not found:
                raise ValueError(f"{path}: no schema object named {object_name!r} (have: {names})")
            obj = found[0]
        fields = []
        for p in obj.get("properties", []):
            opts = p.get("logicalTypeOptions") or {}
            enum = opts.get("enum")
            fields.append(
                Field(
                    name=p["name"],
                    logical_type=p.get("logicalType", "string"),
                    physical_type=p.get("physicalType"),
                    required=bool(p.get("required", False)),
                    enum=tuple(enum) if enum else None,
                    description=(p.get("description") or "").strip(),
                )
            )
        quality = [
            QualityRule(
                description=(q.get("description") or "").strip(),
                dimension=q.get("dimension"),
                status=q.get("status"),
                type=q.get("type", "text"),
                implementation=q.get("implementation"),
            )
            for q in raw.get("quality") or []
        ]
        return cls(
            id=raw["id"],
            version=str(raw["version"]),
            status=raw.get("status", "unknown"),
            object_name=obj["name"],
            fields=fields,
            quality=quality,
            path=Path(path),
        )

    # ---- Arrow schema -------------------------------------------------

    def arrow_type(self, f: Field) -> pa.DataType:
        lt, pt = f.logical_type, (f.physical_type or "").lower()
        if lt == "string":
            return pa.string()
        if lt == "integer" or (lt == "number" and pt in {"int", "integer", "bigint", "long"}):
            return pa.int64()
        if lt == "number":
            return pa.float64()
        if lt == "boolean":
            return pa.bool_()
        if lt == "date":
            return pa.timestamp("us", tz="UTC") if "time" in pt else pa.date32()
        # object / array: kept as a JSON string in bronze — the most
        # engine-neutral representation of a contract-open structure.
        return pa.string()

    def arrow_schema(self) -> pa.Schema:
        return pa.schema(
            [pa.field(f.name, self.arrow_type(f), nullable=not f.required) for f in self.fields]
        )

    # ---- Row validation ------------------------------------------------

    def validate_row(self, row: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
        """Return (normalized_row, None) or (None, reason)."""
        out: dict[str, Any] = {}
        for f in self.fields:
            v = row.get(f.name)
            if v is None:
                if f.required:
                    return None, f"missing required field {f.name}"
                out[f.name] = None
                continue
            try:
                out[f.name] = _coerce(f, v)
            except ValueError as e:
                return None, f"{f.name}: {e}"
            if f.enum is not None and out[f.name] not in f.enum:
                return None, f"{f.name}: {v!r} not in enum"
        return out, None

    def quality_records(self, results: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """`quality:` entries as manifest records, merged with the outcome
        of the checks this package actually ran."""
        results = results or {}
        recs = []
        for q in self.quality:
            rec: dict[str, Any] = {
                "description": q.description,
                "dimension": q.dimension,
                "status": q.status,
                "type": q.type,
                "implementation": q.implementation,
                "executed": False,
                "result": None,
            }
            if q.type == "custom" and q.implementation in results:
                rec["executed"] = True
                rec["result"] = results[q.implementation]
            recs.append(rec)
        return recs


def _coerce(f: Field, v: Any) -> Any:
    lt = f.logical_type
    if lt == "string":
        if not isinstance(v, str):
            raise ValueError(f"expected string, got {type(v).__name__}")
        return v
    if lt in {"number", "integer"}:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"expected number, got {type(v).__name__}")
        return v
    if lt == "boolean":
        if not isinstance(v, bool):
            raise ValueError(f"expected boolean, got {type(v).__name__}")
        return v
    if lt == "date":
        if isinstance(v, datetime):
            return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        if isinstance(v, str):
            try:
                dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError as e:
                raise ValueError(f"not ISO 8601: {v!r}") from e
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        raise ValueError(f"expected timestamp, got {type(v).__name__}")
    # object / array -> JSON string
    if isinstance(v, str):
        return v
    return json.dumps(v, separators=(",", ":"), sort_keys=True)


# Custom quality checks a contract can name (`type: custom`,
# `engine: lab-ingestion`, `implementation: <name>`). Each takes the
# validated rows of one load and returns a JSON-serializable result.
CHECKS: dict[str, Callable[[list[dict[str, Any]]], dict[str, Any]]] = {}


def check(name: str):
    def deco(fn):
        CHECKS[name] = fn
        return fn

    return deco
