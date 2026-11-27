"""Which HubSpot properties the connector requests, and the review status of each one.

The connector requests the curated set (``curated_property_names``) plus the
``collect`` decisions of the instance, and never a money property. Every other
property stays on the portal. An instance without decisions requests every
property that is not money. The ``property_definitions`` stream
writes the status of each property, so a dbt check can report a property
that has no decision.
"""

from __future__ import annotations

import json
from enum import StrEnum

from airbyte_cdk.models import FailureType
from airbyte_cdk.utils import AirbyteTracedException
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError, model_validator

from source_hubspot.constants import (
    ALLOWED_PROPERTIES_BY_OBJECT,
    MODEL_PROPERTIES_BY_OBJECT,
    PROPERTY_DEFINITION_OBJECT_TYPES,
)
from source_hubspot.models import PropertyDescriptor, validation_summary
from source_hubspot.money import is_money_property


class Selection(StrEnum):
    COLLECTED = "collected"
    IGNORED = "ignored"
    FORBIDDEN = "forbidden"
    UNREVIEWED = "unreviewed"
    CONFLICT = "conflict"


class ObjectDecisions(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    collect: frozenset[str] = frozenset()
    ignore: frozenset[str] = frozenset()

    @model_validator(mode="after")
    def _one_decision_per_property(self) -> ObjectDecisions:
        both = self.collect & self.ignore
        if both:
            raise ValueError(f"{len(both)} properties are in both collect and ignore")
        return self


_OBJECTS_ADAPTER = TypeAdapter(dict[str, ObjectDecisions])


class PropertySelection(BaseModel):
    """The ``hubspot_property_selection`` config value, keyed by CRM object type."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    # None: the instance has no decisions yet, so every non-money property is requested.
    objects: dict[str, ObjectDecisions] | None = None

    @model_validator(mode="after")
    def _known_object_types(self) -> PropertySelection:
        unknown = sorted(set(self.objects or {}) - set(PROPERTY_DEFINITION_OBJECT_TYPES))
        if unknown:
            raise ValueError(f"unknown object types: {', '.join(unknown)}")
        return self

    def decisions(self, object_type: str) -> ObjectDecisions:
        return (self.objects or {}).get(object_type, ObjectDecisions())

    def is_requested(self, object_type: str, descriptor: PropertyDescriptor) -> bool:
        return self.status(object_type, descriptor) is Selection.COLLECTED

    def status(self, object_type: str, descriptor: PropertyDescriptor) -> Selection:
        name = descriptor.name or ""
        decisions = self.decisions(object_type)
        curated = name in curated_property_names(object_type)
        money = is_money_property(descriptor)

        if self.objects is None:
            return Selection.FORBIDDEN if money else Selection.COLLECTED

        if money and name in decisions.collect:
            return Selection.CONFLICT
        if not (curated or name in decisions.collect or name in decisions.ignore):
            return Selection.UNREVIEWED
        if money:
            return Selection.FORBIDDEN
        if name in decisions.ignore:
            return Selection.IGNORED
        return Selection.COLLECTED


def curated_property_names(object_type: str) -> frozenset[str]:
    """The properties the connector always requests: the bronze columns and those the dbt models read."""
    columns = ALLOWED_PROPERTIES_BY_OBJECT.get(object_type, frozenset())
    return columns | MODEL_PROPERTIES_BY_OBJECT.get(object_type, frozenset())


def parse_property_selection(raw: str | None) -> PropertySelection:
    """Parse the JSON config value. An absent value means the instance has no decisions yet."""
    if not raw or not raw.strip():
        return PropertySelection()
    try:
        return PropertySelection(objects=_OBJECTS_ADAPTER.validate_json(raw))
    except ValidationError as exc:
        summary = validation_summary(exc)
        raise AirbyteTracedException(
            message=f"Invalid hubspot_property_selection: {summary}",
            internal_message=summary,
            failure_type=FailureType.config_error,
        ) from None


def with_unreviewed_ignored(
    selection: PropertySelection, defined: dict[str, tuple[PropertyDescriptor, ...]]
) -> PropertySelection:
    """Every unreviewed property of ``defined`` added to ``ignore``; existing decisions stay."""
    selection = PropertySelection(objects=dict(selection.objects or {}))
    objects = dict(selection.objects or {})
    for object_type, descriptors in defined.items():
        decisions = selection.decisions(object_type)
        unreviewed = {
            d.name for d in descriptors if d.name and selection.status(object_type, d) is Selection.UNREVIEWED
        }
        if unreviewed:
            objects[object_type] = ObjectDecisions(collect=decisions.collect, ignore=decisions.ignore | unreviewed)
    return PropertySelection(objects=objects)


def selection_json(selection: PropertySelection) -> str:
    """The config value, sorted so that a diff of two versions shows only real changes."""
    document = {
        object_type: {"collect": sorted(decisions.collect), "ignore": sorted(decisions.ignore)}
        for object_type, decisions in sorted((selection.objects or {}).items())
    }
    return json.dumps(document, indent=2) + "\n"
