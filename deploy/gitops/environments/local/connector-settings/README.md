# Connector settings

Each `*.yaml` file here is a ConfigMap with non-secret source config fields
for one connector instance. `make connector-settings` applies the files, and
`make deploy` runs that target.

The reconciler finds the ConfigMap by the same two annotations as the connector
Secret. It adds the `data` fields to the source config and to the cfg-hash. A
changed ConfigMap updates the source and starts a sync on the next reconcile
tick.

The descriptor of the connector lists the permitted fields under
`settings.fields`. The reconciler refuses a ConfigMap that:

- has a field that `settings.fields` does not list;
- has a field that the Secret also sets;
- names the same instance as a second ConfigMap.

The source then stays as it is, and the reconcile run reports the instance as
failed.

A Helm installation without this flow sets `ingestion.reconcile.connectorSettings`
in the chart values instead; the chart renders the same ConfigMaps.

Delete a ConfigMap with `kubectl delete configmap`. A deleted file does not
delete its ConfigMap.

## HubSpot

`hubspot_property_selection` is a JSON object keyed by CRM object type. Each
object type has a `collect` list and an `ignore` list of property names:

- The connector requests its curated properties and the `collect` list.
- The connector does not request the `ignore` list.
- The connector never requests a property that holds money, also when it is in
  `collect`.

The check `assert_hubspot_properties_have_a_decision` reports a property in
neither list (`unreviewed`) and a money property in `collect` (`conflict`).
Write the first file with `tools/selection_baseline.py` of the HubSpot
connector. See `hubspot-main.yaml.example`.
