use super::{Error, Resources, resources::ResourcePatch, validation::Violation};
use crate::infra::cluster::{
    Cluster,
    capacity::{AirbytePlacement, NodeCapacity, Request},
};

pub(super) async fn validate(
    cluster: &Cluster,
    patch: &ResourcePatch,
    stored: &Resources,
) -> Result<(), Error> {
    if !patch.sets_pod_resources() || !cluster.enabled() {
        return Ok(());
    }

    let nodes = match cluster.node_capacity().await {
        Ok(nodes) => nodes,
        Err(error) => {
            tracing::warn!(%error, "Node capacity read failed. Use resource range validation.");
            return Ok(());
        }
    };
    validate_sizes(&patch.merge(stored), &nodes, &cluster.airbyte_placement)
        .map_err(Error::UnschedulableResources)
}

fn validate_sizes(
    sizes: &Resources,
    nodes: &[NodeCapacity],
    airbyte: &AirbytePlacement,
) -> Result<(), Violation> {
    let airbyte_nodes: Vec<_> = nodes
        .iter()
        .filter(|node| {
            airbyte
                .node_selector
                .iter()
                .all(|(key, value)| node.labels.get(key) == Some(value))
        })
        .map(|node| node.allocatable)
        .collect();
    let general_nodes: Vec<_> = nodes.iter().map(|node| node.allocatable).collect();

    let airbyte_cpu = sizes.airbyte_cpu_millis.map(u64::from);
    let airbyte_memory = sizes.airbyte_memory_bytes;
    validate_pair("airbyte", airbyte_cpu, airbyte_memory, &airbyte_nodes)?;
    validate_pair(
        "dbt",
        sizes.dbt_cpu_millis.map(u64::from),
        sizes.dbt_memory_bytes,
        &general_nodes,
    )?;
    validate_pair(
        "identity",
        sizes.identity_cpu_millis.map(u64::from),
        sizes.identity_memory_bytes,
        &general_nodes,
    )?;

    if (airbyte_cpu.is_some() || airbyte_memory.is_some())
        && let Some(request) = airbyte.request(airbyte_cpu, airbyte_memory)
        && cannot_fit(request, &airbyte_nodes)
    {
        return Err(Violation::new(
            "airbyte",
            "the Airbyte replication pod cannot fit on any node that matches the node selector",
        ));
    }
    Ok(())
}

fn validate_pair(
    stage: &'static str,
    cpu: Option<u64>,
    memory: Option<u64>,
    nodes: &[Request],
) -> Result<(), Violation> {
    if (cpu.is_some() || memory.is_some())
        && cannot_fit(Request::new(cpu.unwrap_or(0), memory.unwrap_or(0)), nodes)
    {
        return Err(Violation::new(
            stage,
            "the CPU and memory requests cannot fit on any matching node",
        ));
    }
    Ok(())
}

fn cannot_fit(request: Request, nodes: &[Request]) -> bool {
    !nodes.iter().any(|node| request.fits(*node))
}
