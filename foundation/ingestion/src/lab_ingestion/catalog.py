"""Iceberg catalog access — one factory, two backends (local SQL for
development and acceptance, Glue for the shared AWS foundation). The
extractor code never knows which one it is talking to."""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
from pyiceberg.catalog import Catalog, load_catalog
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.table import Table
from pyiceberg.transforms import IdentityTransform

from .config import CatalogConfig


def open_catalog(cfg: CatalogConfig) -> Catalog:
    props: dict[str, str] = dict(cfg.properties)
    if cfg.type == "sql":
        Path(cfg.warehouse).mkdir(parents=True, exist_ok=True)
        props.update({"type": "sql", "uri": cfg.uri or "", "warehouse": cfg.warehouse})
    else:
        props.update({"type": "glue", "warehouse": cfg.warehouse})
    catalog = load_catalog(cfg.name, **props)
    if (cfg.namespace,) not in catalog.list_namespaces():
        catalog.create_namespace(cfg.namespace)
    return catalog


def ensure_table(
    catalog: Catalog,
    namespace: str,
    name: str,
    arrow_schema: pa.Schema,
    partition_by: list[str] | None = None,
) -> Table:
    """Create the table on first use from the Arrow schema (identity
    partitions on the given columns); afterwards just load it. Schema
    evolution is deliberate, not automatic — a source whose shape changed
    fails loudly at write time instead of silently widening bronze."""
    ident = (namespace, name)
    try:
        return catalog.load_table(ident)
    except NoSuchTableError:
        pass
    table = catalog.create_table(ident, schema=arrow_schema)
    if partition_by:
        with table.update_spec() as update:
            for col in partition_by:
                update.add_field(col, IdentityTransform(), col)
        table = catalog.load_table(ident)
    return table
