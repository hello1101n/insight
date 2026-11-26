use std::collections::BTreeMap;

use bigdecimal::{BigDecimal, RoundingMode, ToPrimitive};
use k8s_openapi::api::core::v1::Node;
use kube::{Api, api::ListParams};
use serde::Deserialize;

use super::{Cluster, Error, MAX_OBJECTS, PAGE_SIZE};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub(crate) struct AirbytePlacement {
    pub(crate) node_selector: BTreeMap<String, String>,
    requests: Option<AirbyteRequests>,
}

#[derive(Clone, Debug, Deserialize)]
struct AirbyteRequests {
    orchestrator: Quantities,
    source: Quantities,
    destination: Quantities,
    init: Quantities,
}

#[derive(Clone, Debug, Deserialize)]
struct Quantities {
    cpu: String,
    memory: String,
}

impl Quantities {
    fn request(&self) -> Option<Request> {
        Some(Request::new(
            quantity(&self.cpu, 1000, RoundingMode::Ceiling)?,
            quantity(&self.memory, 1, RoundingMode::Ceiling)?,
        ))
    }
}

impl AirbytePlacement {
    pub(crate) fn request(&self, cpu: Option<u64>, memory: Option<u64>) -> Option<Request> {
        let sizes = self.requests.as_ref()?;
        let source = sizes.source.request()?;
        let destination = sizes.destination.request()?;
        let orchestrator = sizes.orchestrator.request()?;
        let init = sizes.init.request()?;
        Some(Request {
            cpu: cpu
                .unwrap_or(source.cpu)
                .saturating_add(destination.cpu)
                .saturating_add(orchestrator.cpu)
                .max(init.cpu),
            memory: memory
                .unwrap_or(source.memory)
                .saturating_add(destination.memory)
                .saturating_add(orchestrator.memory)
                .max(init.memory),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Request {
    cpu: u64,
    memory: u64,
}

impl Request {
    pub(crate) const fn new(cpu: u64, memory: u64) -> Self {
        Self { cpu, memory }
    }

    pub(crate) fn fits(self, available: Self) -> bool {
        self.cpu <= available.cpu && self.memory <= available.memory
    }
}

#[derive(Debug)]
pub(crate) struct NodeCapacity {
    pub(crate) allocatable: Request,
    pub(crate) labels: BTreeMap<String, String>,
}

impl NodeCapacity {
    fn from_node(node: Node) -> Result<Option<Self>, Error> {
        let Some(sizes) = node.status.and_then(|status| status.allocatable) else {
            return Ok(None);
        };
        let size = |key, scale| {
            sizes
                .get(key)
                .and_then(|q| quantity(&q.0, scale, RoundingMode::Down))
                .ok_or(Error::NodeCapacity)
        };
        Ok(Some(Self {
            allocatable: Request::new(size("cpu", 1000)?, size("memory", 1)?),
            labels: node.metadata.labels.unwrap_or_default(),
        }))
    }
}

fn quantity(raw: &str, units: u64, rounding: RoundingMode) -> Option<u64> {
    let mut scale = BigDecimal::from(units);
    let mut number = raw;
    for (suffix, precision, multiplier) in [
        ("Ki", 0, 1_u64 << 10),
        ("Mi", 0, 1 << 20),
        ("Gi", 0, 1 << 30),
        ("Ti", 0, 1 << 40),
        ("Pi", 0, 1 << 50),
        ("Ei", 0, 1 << 60),
        ("n", 9, 1),
        ("u", 6, 1),
        ("m", 3, 1),
        ("k", -3, 1),
        ("M", -6, 1),
        ("G", -9, 1),
        ("T", -12, 1),
        ("P", -15, 1),
        ("E", -18, 1),
    ] {
        if let Some(value) = raw.strip_suffix(suffix) {
            number = value;
            scale *= BigDecimal::new(multiplier.into(), precision);
            break;
        }
    }

    let value: BigDecimal = number.parse().ok()?;
    let (digits, precision) = value.as_bigint_and_exponent();
    if !(-30..=30).contains(&precision) || digits < 0.into() {
        return None;
    }
    (value * scale).with_scale_round(0, rounding).to_u64()
}

impl Cluster {
    pub(crate) async fn node_capacity(&self) -> Result<Vec<NodeCapacity>, Error> {
        let client = self.client.clone().ok_or(Error::Disabled)?;
        let api = Api::<Node>::all(client);
        let mut params = ListParams::default().limit(PAGE_SIZE);
        let mut seen = 0;
        let mut capacities = Vec::new();
        let deadline = tokio::time::Instant::now() + self.call_timeout;
        loop {
            let page = tokio::time::timeout_at(deadline, api.list(&params)).await??;
            seen += page.items.len();
            if seen > MAX_OBJECTS {
                return Err(Error::NodeCapacity);
            }
            for node in page.items {
                capacities.extend(NodeCapacity::from_node(node)?);
            }
            let Some(token) = page.metadata.continue_.filter(|s| !s.is_empty()) else {
                return Ok(capacities);
            };
            params = params.continue_token(&token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_quantities_keep_the_cpu_and_memory_boundary() {
        for (raw, units, expected) in [
            ("1500m", 1000, 1500),
            ("4", 1000, 4000),
            ("1.5Ki", 1, 1536),
            ("8Gi", 1, 8 << 30),
            ("1e9", 1, 1_000_000_000),
        ] {
            assert_eq!(
                quantity(raw, units, RoundingMode::Down),
                Some(expected),
                "{raw}"
            );
        }
    }
}
