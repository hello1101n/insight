//! Read-after-write on a replicated warehouse.
//!
//! The pair is not a stronger default. A sequential quorum insert is refused
//! while the previous one into the same table is unconfirmed
//! (`QUORUM_FOR_PREVIOUS_WRITE_NOT_SATISFIED`), so two writers of one table
//! fail each other; a sequentially consistent read on a lagging replica
//! throws (`REPLICA_IS_NOT_IN_QUORUM`) instead of answering. A call site
//! takes the pair only when a read of its own decides on a write of its own.

use crate::Topology;
use crate::missing_relation::reported_code;

const REPLICA_IS_NOT_IN_QUORUM: u32 = 289;

/// A sequentially consistent read refused: the quorum record names a part
/// that the replica does not hold, for example after a partition replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the quorum record of the table names a part that the replica does not hold")]
pub struct ReplicaNotInQuorum;

impl ReplicaNotInQuorum {
    #[must_use]
    pub fn from_error(error: &clickhouse::error::Error) -> Option<Self> {
        Self::from_message(&error.to_string())
    }

    #[must_use]
    pub fn from_message(message: &str) -> Option<Self> {
        (reported_code(message)? == REPLICA_IS_NOT_IN_QUORUM).then_some(Self)
    }
}

/// Confirms an insert on a quorum of replicas, so the read below is
/// guaranteed to reach one that holds it. `insert_quorum_parallel = 0` is what
/// gives that read its meaning — ClickHouse makes no sequential-consistency
/// promise while quorum inserts run in parallel.
const QUORUM_WRITE: [(&str, &str); 2] =
    [("insert_quorum", "auto"), ("insert_quorum_parallel", "0")];
const CONSISTENT_READ: [(&str, &str); 1] = [("select_sequential_consistency", "1")];

pub(crate) fn every_active_replica_settings(active_replicas: u32) -> [(&'static str, String); 2] {
    [
        ("insert_quorum", active_replicas.max(1).to_string()),
        ("insert_quorum_parallel", "0".to_owned()),
    ]
}

pub(crate) fn write_settings(topology: Topology) -> &'static [(&'static str, &'static str)] {
    if topology.is_replicated() {
        &QUORUM_WRITE
    } else {
        &[]
    }
}

pub(crate) fn read_settings(topology: Topology) -> &'static [(&'static str, &'static str)] {
    if topology.is_replicated() {
        &CONSISTENT_READ
    } else {
        &[]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_node_waits_for_nothing() {
        assert!(write_settings(Topology::Standalone).is_empty());
        assert!(read_settings(Topology::Standalone).is_empty());
    }

    #[test]
    fn a_replicated_write_is_confirmed_before_the_read_that_decides_on_it() {
        let topology = Topology::new(true, "insight_cluster");

        assert_eq!(
            write_settings(topology),
            [("insert_quorum", "auto"), ("insert_quorum_parallel", "0")]
        );
        assert_eq!(
            read_settings(topology),
            [("select_sequential_consistency", "1")]
        );
    }

    #[test]
    fn a_consistent_read_refused_for_a_missing_quorum_part_is_recognised() {
        let message = "bad response: Code: 289. DB::Exception: Replica doesn't have part \
                       'p_0_0_0' which was successfully written to quorum of other replicas. \
                       (REPLICA_IS_NOT_IN_QUORUM)";

        assert_eq!(
            ReplicaNotInQuorum::from_message(message),
            Some(ReplicaNotInQuorum)
        );
        assert_eq!(ReplicaNotInQuorum::from_message("Code: 341"), None);
        assert_eq!(
            ReplicaNotInQuorum::from_error(&clickhouse::error::Error::BadResponse(
                message.to_owned()
            )),
            Some(ReplicaNotInQuorum)
        );
    }

    #[test]
    fn a_quorum_of_the_active_replicas_never_drops_to_none() {
        assert_eq!(
            every_active_replica_settings(3),
            [
                ("insert_quorum", "3".to_owned()),
                ("insert_quorum_parallel", "0".to_owned())
            ]
        );
        assert_eq!(every_active_replica_settings(0)[0].1, "1");
    }

    #[test]
    fn a_parallel_quorum_would_void_the_read_it_is_paired_with() {
        let parallel = write_settings(Topology::new(true, "insight_cluster"))
            .iter()
            .find(|(name, _)| *name == "insert_quorum_parallel");

        assert_eq!(parallel, Some(&("insert_quorum_parallel", "0")));
    }
}
