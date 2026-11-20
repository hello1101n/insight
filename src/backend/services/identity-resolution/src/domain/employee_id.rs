//! Employee IDs of the roster: the second key, after the address, that links an
//! account to an existing person.
//!
//! Only the roster's IDs count. An employee ID has meaning only in the system
//! that issued it, and the roster is the one system the installation trusts.
//! Another source links when it states the same value — for example a chat
//! directory that copies the HR employee number.

use std::collections::HashMap;

use uuid::Uuid;

use super::resolution::EXCLUDED_PERSON;
use super::roster::RosterSource;
use super::seed::{PersonAssignment, SeedProfile};

pub(crate) const EMPLOYEE_ID_VALUE_TYPE: &str = "employee_id";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Holder {
    Person(Uuid),
    /// Two persons hold this ID. It is no evidence for either one.
    Contested,
}

/// Which person holds each employee ID of the roster.
#[derive(Debug, Default)]
pub struct RosterEmployeeIds(HashMap<String, Holder>);

impl RosterEmployeeIds {
    /// Build the map from `(employee_id, person_id)` pairs. An ID that two
    /// persons hold is contested.
    #[must_use]
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, Uuid)>) -> Self {
        let mut ids = Self::default();
        for (employee_id, person) in pairs {
            ids.record(&employee_id, person);
        }
        ids
    }

    fn record(&mut self, employee_id: &str, person: Uuid) {
        let Some(key) = normalize(employee_id) else {
            return;
        };
        if person == EXCLUDED_PERSON {
            return;
        }

        self.0
            .entry(key)
            .and_modify(|holder| {
                if *holder != Holder::Person(person) {
                    *holder = Holder::Contested;
                }
            })
            .or_insert(Holder::Person(person));
    }

    /// Record the employee IDs that the roster accounts of new assignments
    /// state, so a later group of the same run links to them.
    pub(crate) fn learn(&mut self, assignments: &[PersonAssignment], roster: &RosterSource) {
        for assignment in assignments {
            let roster_profiles = assignment
                .profiles
                .iter()
                .filter(|profile| roster.speaks_for(&profile.account.source_type));
            for profile in roster_profiles {
                for employee_id in stated_employee_ids(profile) {
                    self.record(employee_id, assignment.person_id);
                }
            }
        }
    }

    /// The one person that every employee ID of the group names. `None` when
    /// the group states no known ID, or when its IDs name different persons
    /// or a contested holder.
    pub(crate) fn claim(&self, profiles: &[SeedProfile]) -> Option<Uuid> {
        let mut claimed: Option<Uuid> = None;
        for employee_id in profiles.iter().flat_map(stated_employee_ids) {
            let Some(key) = normalize(employee_id) else {
                continue;
            };
            let Some(holder) = self.0.get(&key) else {
                continue;
            };
            let Holder::Person(person) = *holder else {
                return None;
            };
            if claimed.is_some_and(|earlier| earlier != person) {
                return None;
            }
            claimed = Some(person);
        }
        claimed
    }
}

fn stated_employee_ids(profile: &SeedProfile) -> impl Iterator<Item = &str> {
    profile
        .observations
        .iter()
        .filter(|observation| observation.value_type == EMPLOYEE_ID_VALUE_TYPE)
        .map(|observation| observation.value.as_str())
}

fn normalize(employee_id: &str) -> Option<String> {
    let trimmed = employee_id.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use sea_orm::prelude::DateTime;

    use super::*;
    use crate::domain::seed::{AssignmentKind, IdentityInputRow, SourceAccountKey};

    const ANN: Uuid = Uuid::from_u128(1);
    const BOB: Uuid = Uuid::from_u128(2);

    fn profile(source_type: &str, employee_ids: &[&str]) -> SeedProfile {
        let observations = employee_ids
            .iter()
            .map(|value| IdentityInputRow {
                source_type: source_type.to_owned(),
                source_id: Uuid::from_u128(9),
                source_account_id: "A1".to_owned(),
                value_type: EMPLOYEE_ID_VALUE_TYPE.to_owned(),
                value: (*value).to_owned(),
                synced_at: DateTime::default(),
                is_delete: false,
            })
            .collect();
        SeedProfile {
            account: SourceAccountKey {
                source_type: source_type.to_owned(),
                source_id: Uuid::from_u128(9),
                account_id: "A1".to_owned(),
            },
            latest_email: None,
            is_closed: false,
            roster_membership: None,
            observations,
        }
    }

    #[test]
    fn a_group_links_to_the_one_person_its_ids_name() {
        let ids = RosterEmployeeIds::from_pairs([("E1".to_owned(), ANN), ("E2".to_owned(), BOB)]);

        let cases = [
            ("one known id", vec![profile("slack", &["E1"])], Some(ANN)),
            (
                "surrounding spaces",
                vec![profile("slack", &[" E1 "])],
                Some(ANN),
            ),
            ("an unknown id", vec![profile("slack", &["E9"])], None),
            ("a blank id", vec![profile("slack", &["  "])], None),
            ("no id", vec![profile("slack", &[])], None),
            (
                "a known and an unknown id",
                vec![profile("slack", &["E1"]), profile("zoom", &["E9"])],
                Some(ANN),
            ),
            (
                "ids of two persons",
                vec![profile("slack", &["E1"]), profile("zoom", &["E2"])],
                None,
            ),
        ];
        for (case, profiles, expected) in cases {
            assert_eq!(ids.claim(&profiles), expected, "case: {case}");
        }
    }

    #[test]
    fn an_id_two_persons_hold_links_nobody() {
        let ids = RosterEmployeeIds::from_pairs([("E1".to_owned(), ANN), ("E1".to_owned(), BOB)]);

        assert_eq!(ids.claim(&[profile("slack", &["E1"])]), None);
    }

    #[test]
    fn the_same_holder_twice_is_not_a_contest() {
        let ids = RosterEmployeeIds::from_pairs([("E1".to_owned(), ANN), ("E1".to_owned(), ANN)]);

        assert_eq!(ids.claim(&[profile("slack", &["E1"])]), Some(ANN));
    }

    #[test]
    fn the_excluded_person_holds_no_id() {
        let ids = RosterEmployeeIds::from_pairs([("E1".to_owned(), EXCLUDED_PERSON)]);

        assert_eq!(ids.claim(&[profile("slack", &["E1"])]), None);
    }

    #[test]
    fn only_roster_accounts_teach_an_id() -> Result<(), Box<dyn std::error::Error>> {
        let roster = RosterSource::parse("bamboohr").ok_or("roster must parse")?;
        let assignment = PersonAssignment {
            person_id: ANN,
            kind: AssignmentKind::Minted,
            profiles: vec![profile("bamboohr", &["E1"]), profile("zoom", &["E2"])],
        };
        let mut ids = RosterEmployeeIds::default();

        ids.learn(&[assignment], &roster);

        assert_eq!(ids.claim(&[profile("slack", &["E1"])]), Some(ANN));
        assert_eq!(
            ids.claim(&[profile("slack", &["E2"])]),
            None,
            "a non-roster id must not become linking evidence"
        );
        Ok(())
    }
}

#[cfg(test)]
mod resolution_tests {
    use std::collections::HashMap;

    use sea_orm::prelude::DateTime;
    use uuid::Uuid;

    use super::*;
    use crate::domain::resolution::BINDING_VALUE_TYPE;
    use crate::domain::seed::{
        AssignmentKind, EMPLOYEE_ID_LINK_REASON, IdentityInputRow, RosterMembership,
        SourceAccountKey, assignments_to_rows, group_by_email, resolve_assignments,
    };

    const ANN: Uuid = Uuid::from_u128(0xA11);
    const BOB: Uuid = Uuid::from_u128(0xB0B);

    fn observation(
        source_type: &str,
        account_id: &str,
        value_type: &str,
        value: &str,
    ) -> IdentityInputRow {
        IdentityInputRow {
            source_type: source_type.to_owned(),
            source_id: Uuid::from_u128(7),
            source_account_id: account_id.to_owned(),
            value_type: value_type.to_owned(),
            value: value.to_owned(),
            synced_at: DateTime::default(),
            is_delete: false,
        }
    }

    fn account(
        source_type: &str,
        account_id: &str,
        email: Option<&str>,
        employee_id: Option<&str>,
    ) -> SeedProfile {
        let mut observations = vec![observation(
            source_type,
            account_id,
            BINDING_VALUE_TYPE,
            account_id,
        )];
        observations
            .extend(email.map(|value| observation(source_type, account_id, "email", value)));
        observations.extend(
            employee_id
                .map(|value| observation(source_type, account_id, EMPLOYEE_ID_VALUE_TYPE, value)),
        );
        SeedProfile {
            account: SourceAccountKey {
                source_type: source_type.to_owned(),
                source_id: Uuid::from_u128(7),
                account_id: account_id.to_owned(),
            },
            latest_email: email.map(str::to_owned),
            is_closed: false,
            roster_membership: Some(RosterMembership {
                active: true,
                observed_at: DateTime::default(),
            }),
            observations,
        }
    }

    fn held(pairs: &[(&str, Uuid)]) -> RosterEmployeeIds {
        RosterEmployeeIds::from_pairs(pairs.iter().map(|(id, person)| ((*id).to_owned(), *person)))
    }

    fn minted() -> impl FnMut() -> Uuid {
        let mut n = 0u128;
        move || {
            n += 1;
            Uuid::from_u128(n)
        }
    }

    fn person_of(out: &crate::domain::seed::ResolveOutcome, source_type: &str) -> Option<Uuid> {
        out.assignments
            .iter()
            .find(|a| {
                a.profiles
                    .iter()
                    .any(|p| p.account.source_type == source_type)
            })
            .map(|a| a.person_id)
    }

    #[test]
    fn an_account_without_an_address_links_to_the_roster_person_of_its_employee_id() {
        let roster = RosterSource::parse("bamboohr");

        let out = resolve_assignments(
            group_by_email(vec![account("slack", "U1", None, Some("E1"))]),
            &HashMap::new(),
            &HashMap::new(),
            held(&[("E1", ANN)]),
            roster.as_ref(),
            minted(),
        );

        assert_eq!(person_of(&out, "slack"), Some(ANN));
        assert_eq!(out.linked_by_employee_id, 1);
        assert_eq!(out.skipped_no_email, 0);
    }

    #[test]
    fn an_account_with_an_unknown_address_links_by_its_employee_id_instead_of_minting() {
        let roster = RosterSource::parse("bamboohr");

        let out = resolve_assignments(
            group_by_email(vec![account(
                "slack",
                "U1",
                Some("ann.alias@example.com"),
                Some("E1"),
            )]),
            &HashMap::new(),
            &HashMap::new(),
            held(&[("E1", ANN)]),
            roster.as_ref(),
            minted(),
        );

        assert_eq!(person_of(&out, "slack"), Some(ANN));
        assert_eq!(out.minted, 0);
    }

    #[test]
    fn the_address_wins_when_the_address_and_the_employee_id_name_different_persons() {
        let roster = RosterSource::parse("bamboohr");
        let emails = HashMap::from([("bob@example.com".to_owned(), BOB)]);

        let out = resolve_assignments(
            group_by_email(vec![account(
                "slack",
                "U1",
                Some("bob@example.com"),
                Some("E1"),
            )]),
            &HashMap::new(),
            &emails,
            held(&[("E1", ANN)]),
            roster.as_ref(),
            minted(),
        );

        assert_eq!(person_of(&out, "slack"), Some(BOB));
        assert_eq!((out.linked_by_email, out.linked_by_employee_id), (1, 0));
    }

    #[test]
    fn a_roster_account_minted_in_the_same_run_teaches_its_employee_id() {
        let roster = RosterSource::parse("bamboohr");
        let profiles = vec![
            account("slack", "U1", None, Some("E1")),
            account("bamboohr", "100", Some("ann@example.com"), Some("E1")),
        ];

        let out = resolve_assignments(
            group_by_email(profiles),
            &HashMap::new(),
            &HashMap::new(),
            RosterEmployeeIds::default(),
            roster.as_ref(),
            minted(),
        );

        let roster_person = person_of(&out, "bamboohr");
        assert!(roster_person.is_some());
        assert_eq!(
            person_of(&out, "slack"),
            roster_person,
            "the slack account should join the roster person"
        );
    }

    #[test]
    fn a_roster_account_never_links_through_its_own_employee_id() {
        let roster = RosterSource::parse("bamboohr");

        let out = resolve_assignments(
            group_by_email(vec![account(
                "bamboohr",
                "200",
                Some("new.hire@example.com"),
                Some("E1"),
            )]),
            &HashMap::new(),
            &HashMap::new(),
            held(&[("E1", ANN)]),
            roster.as_ref(),
            minted(),
        );

        assert_ne!(
            person_of(&out, "bamboohr"),
            Some(ANN),
            "the roster states the ID; it is not evidence"
        );
        assert_eq!(out.linked_by_employee_id, 0);
    }

    #[test]
    fn without_a_roster_an_employee_id_links_nobody() {
        let out = resolve_assignments(
            group_by_email(vec![account("slack", "U1", None, Some("E1"))]),
            &HashMap::new(),
            &HashMap::new(),
            held(&[("E1", ANN)]),
            None,
            minted(),
        );

        assert!(out.assignments.is_empty());
        assert_eq!(out.skipped_no_email, 1);
    }

    #[test]
    fn a_non_roster_account_never_teaches_an_employee_id() {
        let roster = RosterSource::parse("bamboohr");
        let profiles = vec![
            account("zoom", "Z1", Some("ann@example.com"), Some("E1")),
            account("slack", "U1", None, Some("E1")),
        ];

        let out = resolve_assignments(
            group_by_email(profiles),
            &HashMap::new(),
            &HashMap::new(),
            RosterEmployeeIds::default(),
            roster.as_ref(),
            minted(),
        );

        assert_eq!(person_of(&out, "slack"), None);
        assert_eq!(out.skipped_no_email, 1);
    }

    #[test]
    fn an_employee_id_link_is_stamped_with_its_own_reason() {
        let roster = RosterSource::parse("bamboohr");
        let out = resolve_assignments(
            group_by_email(vec![account("slack", "U1", None, Some("E1"))]),
            &HashMap::new(),
            &HashMap::new(),
            held(&[("E1", ANN)]),
            roster.as_ref(),
            minted(),
        );

        let rows = assignments_to_rows(&out.assignments, Uuid::nil(), &HashMap::new());

        assert_eq!(out.assignments[0].kind, AssignmentKind::LinkedByEmployeeId);
        assert!(
            rows.iter()
                .all(|row| row.reason.as_deref() == Some(EMPLOYEE_ID_LINK_REASON)),
            "every row should carry the employee ID link reason"
        );
    }
}
