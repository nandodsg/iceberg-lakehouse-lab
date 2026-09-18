"""Extractor configuration.

The public package knows source *types*; the real configuration for a
given deployment (identifiers, connection details, which columns to
promote) lives outside this repository and is passed in as a YAML file.
`config.example.yaml` documents the shape with placeholder values.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal, Union

import yaml
from pydantic import BaseModel, Field


class CatalogConfig(BaseModel):
    """Where bronze tables live. `sql` = local SQLite catalog + local
    warehouse directory (development/acceptance); `glue` = AWS Glue Data
    Catalog + S3 warehouse (foundation/infra/)."""

    type: Literal["sql", "glue"] = "sql"
    name: str = "lab"
    uri: str | None = None  # sql: sqlite:///<path>
    warehouse: str  # sql: directory; glue: s3://bucket/prefix
    namespace: str = "bronze"
    properties: dict[str, str] = Field(default_factory=dict)


class AbmJsonlSource(BaseModel):
    """ABM harness output (one JSONL file per batch), governed by the
    Lab-owned contract `contracts/abm-behavioral-events.contract.yaml`."""

    kind: Literal["abm_jsonl"]
    table: str = "abm_decision_steps"
    contract: Path


class KnownUsersRef(BaseModel):
    """Where the GA4 source finds the user ids it may keep when an event
    carries no population tag at all (a login fires before the tag is
    attached): a column of another bronze table. When `population_column`
    is set, only rows whose value is in `population_allow` contribute."""

    table: str
    column: str
    population_column: str | None = None


class Ga4BigQuerySource(BaseModel):
    """A GA4 property's BigQuery Export dataset (`events_YYYYMMDD` daily
    tables, optionally `events_intraday_YYYYMMDD`)."""

    kind: Literal["ga4_bigquery"]
    table: str = "app_events"
    project: str
    dataset: str
    location: str | None = None
    # User properties promoted to top-level columns (e.g. the population
    # tag and one `exp_<key>` per experiment). Names are deployment
    # details — they come from the config, never from code.
    promoted_user_properties: list[str] = Field(default_factory=list)
    population_property: str = "population"
    # Rows whose population is in this list are loaded; rows with no
    # population at all are loaded only if their user id is in the
    # allow-list built from `known_user_sources`; everything else is
    # filtered out and counted in the manifest (`rows_filtered`).
    population_allow: list[str] = Field(default_factory=lambda: ["abm", "synthetic"])
    known_user_sources: list[KnownUsersRef] = Field(
        default_factory=lambda: [KnownUsersRef(table="abm_decision_steps", column="session_id")]
    )
    contract: Path | None = None


class PostgresExportSource(BaseModel):
    """Read-only export views of the source application's database,
    governed by that application's own export contract (ODCS)."""

    kind: Literal["postgres_export"]
    dsn_env: str = "LAB_PG_DSN"  # DSN comes from the environment, never the file
    schema_name: str = "export"
    contract: Path
    # export view -> bronze table name (public names, chosen by the Lab)
    tables: dict[str, str] = Field(default_factory=dict)


Source = Annotated[
    Union[AbmJsonlSource, Ga4BigQuerySource, PostgresExportSource],
    Field(discriminator="kind"),
]


class Config(BaseModel):
    catalog: CatalogConfig
    sources: dict[str, Source]

    @classmethod
    def load(cls, path: Path) -> "Config":
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        cfg = cls.model_validate(raw)
        # Relative paths in the file resolve against the file's directory.
        base = path.parent
        for src in cfg.sources.values():
            c = getattr(src, "contract", None)
            if c is not None and not Path(c).is_absolute():
                src.contract = (base / c).resolve()
        if cfg.catalog.type == "sql":
            if not Path(cfg.catalog.warehouse).is_absolute():
                cfg.catalog.warehouse = str((base / cfg.catalog.warehouse).resolve())
            if cfg.catalog.uri is None:
                cfg.catalog.uri = f"sqlite:///{Path(cfg.catalog.warehouse) / 'catalog.db'}"
        return cfg
