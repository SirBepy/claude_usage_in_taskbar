use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub enum InstanceKind {
    Automated,
    External,
    Interactive,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_kind_serializes_lowercase() {
        let a = InstanceKind::Automated;
        let e = InstanceKind::External;
        assert_eq!(serde_json::to_string(&a).unwrap(), "\"automated\"");
        assert_eq!(serde_json::to_string(&e).unwrap(), "\"external\"");
    }

    #[test]
    fn interactive_kind_serializes_lowercase() {
        let kind = InstanceKind::Interactive;
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, "\"interactive\"");
    }

    #[test]
    fn interactive_kind_deserializes() {
        let kind: InstanceKind = serde_json::from_str("\"interactive\"").unwrap();
        assert!(matches!(kind, InstanceKind::Interactive));
    }
}
