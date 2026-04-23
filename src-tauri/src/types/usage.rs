use serde::{Deserialize, Serialize};

/// A single usage poll result, captured at a point in time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct UsageSnapshot {
    pub captured_at: String,           // RFC3339 / ISO8601
    pub five_hour: WindowUsage,
    pub seven_day: WindowUsage,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct WindowUsage {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, ts_rs::TS)]
#[ts(export_to = "../../src/types/ipc.generated.ts")]
pub struct ExtraUsage {
    pub is_enabled: bool,
    pub monthly_limit: f64,
    pub used_credits: f64,
    pub utilization: f64,
    pub currency: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_snapshot_parses_real_api_shape() {
        let raw = r#"{
            "captured_at": "2026-04-19T10:00:00Z",
            "five_hour": { "utilization": 7.0, "resets_at": "2026-04-19T15:00:00Z" },
            "seven_day": { "utilization": 4.0, "resets_at": "2026-04-23T23:00:00Z" },
            "extra_usage": {
                "is_enabled": true, "monthly_limit": 8500,
                "used_credits": 329, "utilization": 3.87, "currency": "EUR"
            }
        }"#;
        let parsed: UsageSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.five_hour.utilization, 7.0);
        assert_eq!(parsed.extra_usage.as_ref().unwrap().monthly_limit, 8500.0);
    }
}
